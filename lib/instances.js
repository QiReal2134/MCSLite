'use strict';
// 实例管理器:创建/导入/启动/停止/重启/强杀、日志环形缓冲、资源统计、玩家探测
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { uid, now, readJson, writeJson, safeJoin, runCmd, sleep } = require('./util');
const { findServerJars, extract: extractZip, dirSize } = require('./files');
const { renderPattern, backupsDir, listBackups, worldFolders, zipWorlds, safeBackupName, MANUAL_PREFIX } = require('./backup');
const { detectJava, detectJavaDeep, pickJava, requiredJavaForMc } = require('./java');
const { probeServer } = require('./mcping');
const { EV } = require('./sse');

const MAX_LOG_LINES = 3000;
const STOP_TIMEOUT = 30000;
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

// 默认 server.properties(完整标准选项)
const DEFAULT_PROPS = [
  'server-port=25565', 'server-ip=', 'online-mode=true',
  'motd=\\u00A7bMCSLite \\u00A7r\\u00A7f我的世界服务器',
  'max-players=20', 'max-world-size=29999984', 'max-build-height=256',
  'view-distance=10', 'simulation-distance=10', 'render-distance=10',
  'spawn-protection=16', 'tick-rate=3',
  'difficulty=normal', 'gamemode=survival', 'level-type=default',
  'level-name=world', 'level-seed=',
  'generate-structures=true', 'allow-nether=true', 'allow-flight=false',
  'spawn-npcs=true', 'spawn-monsters=true', 'spawn-animals=true',
  'pvp=true', 'hardcore=false', 'enable-command-block=false',
  'enable-status=true', 'enable-query=false', 'query.port=25565',
  'enable-rcon=false', 'rcon.port=25575', 'rcon.password=',
  'broadcast-console-to-ops=true', 'broadcast-rcon-to-ops=true',
  'op-permission-level=4', 'function-permission-level=2',
  'player-idle-timeout=0', 'enforce-secure-profile=true',
  'prevent-proxy-connections=false', 'hide-online-players=false',
  'max-tick-time=60000', 'network-compression-threshold=256',
  'rate-limit=0', 'sync-chunk-writes=true',
  'entity-broadcast-range-percentage=100', 'use-native-transport=true',
  'white-list=false', 'enforce-whitelist=false', 'spawn-tnt-explosion-decay=true'
].join('\n') + '\n';

class InstanceManager {
  constructor({ root, dataDir, hub, getConfig }) {
    this.root = root;
    this.dataDir = dataDir;
    this.serversDir = path.join(root, 'servers');
    this.storeFile = path.join(dataDir, 'instances.json');
    this.hub = hub;
    this.getConfig = getConfig;
    this.instances = [];
    this.javaCache = null;
    this.javaCacheAt = 0;
    this.logs = new Map();      // id -> {lines: [], partial}
    this.logStreams = new Map(); // id -> writeStream
    this.stats = new Map();     // id -> {cpu, mem, rss, at, lastCpuSec}
    this.ping = new Map();      // id -> {result, at}
    this.disk = new Map();      // id -> {size, at} 实例目录占用
    this.tps = new Map();       // id -> {value, at} 服务器 TPS
    this._diskScanning = new Set();
    this._tpsPending = new Map(); // id -> 发起时间
    this._opsCache = new Map();   // id -> {mtime, data}
    this._propsCache = new Map(); // id -> {mtime, text, parsed} server.properties 解析缓存
    this._jarsCache = new Map();  // id -> {dirMtime, at, jars} findServerJars 结果缓存
    this._backupRunning = new Set(); // 正在进行备份的实例 id,防止并发打包
    this.prevProcCpu = new Map(); // pid -> cpu seconds
    this.loadJavaCache();
    this.load();
    this.startPoller();
  }

  // 加载持久化的 Java 扫描结果(重启后无需重新扫描即可用)
  loadJavaCache() {
    try {
      const cached = readJson(path.join(this.dataDir, 'java-cache.json'), null);
      if (cached && Array.isArray(cached.java)) {
        const valid = cached.java.filter(j => j && j.path && fs.existsSync(j.path));
        if (valid.length) {
          this.javaCache = valid;
          this.javaCacheAt = now();
          console.log(`[Java] 已加载缓存 ${valid.length} 个 Java (来自上次扫描)`);
        }
      }
    } catch {}
  }

  // 保存扫描结果到磁盘
  saveJavaCache() {
    if (!this.javaCache) return;
    try {
      writeJson(path.join(this.dataDir, 'java-cache.json'), { savedAt: now(), java: this.javaCache });
    } catch {}
  }

  load() {
    fs.mkdirSync(this.serversDir, { recursive: true });
    const list = readJson(this.storeFile, []);
    if (!Array.isArray(list)) return;
    this.instances = list;
    for (const ins of this.instances) {
      if (!this.logs.has(ins.id)) this.logs.set(ins.id, { lines: [], partial: '' });
    }
    // 收养上次面板退出时仍在运行的进程
    for (const ins of this.instances) {
      if (ins.pid && this.isAlive(ins.pid)) {
        ins._adopted = true;
        this.appendLog(ins.id, `[面板] 检测到服务端进程仍在运行 (PID ${ins.pid}),已接管监控`);
      } else {
        ins.pid = null; ins.startedAt = 0;
      }
    }
    this.save();
  }

  save() {
    const clean = this.instances.map(ins => {
      const c = {};
      for (const k of Object.keys(ins)) {
        if (!k.startsWith('_')) c[k] = ins[k];
      }
      return c;
    });
    writeJson(this.storeFile, clean);
  }

  // ---------- 目录 ----------
  instanceDir(ins) {
    return safeJoin(this.serversDir, ins.dir);
  }

  sanitizeDirName(name) {
    return String(name).replace(/[\\/:*?"<>|\r\n]/g, '_').trim().slice(0, 60) || 'server';
  }

  // ---------- 创建 ----------
  create({ name, dir } = {}) {
    if (!name || !String(name).trim()) throw new Error('请输入实例名称');
    name = String(name).trim();
    const dirName = dir || this.sanitizeDirName(name);
    let finalDir = dirName, n = 1;
    while (this.instances.some(i => i.dir === finalDir)) finalDir = `${dirName}_${n++}`;
    const id = uid(6);
    const ins = {
      id, name, dir: finalDir, javaPath: '', javaRequirement: 'auto',
      xms: '1024M', xmx: '2048M', jvmArgs: '', serverJar: '',
      autoStart: false, eula: false, pid: null, startedAt: 0,
      backupEnabled: false, backupInterval: 60, backupMax: 10,
      backupPattern: 'auto-{y}{m}{d}-{h}{min}', lastBackupAt: 0,
      createdAt: now(), updatedAt: now()
    };
    fs.mkdirSync(this.instanceDir(ins), { recursive: true });
    // 初始化基础文件
    const dirPath = this.instanceDir(ins);
    const propsFile = path.join(dirPath, 'server.properties');
    if (!fs.existsSync(propsFile)) fs.writeFileSync(propsFile, DEFAULT_PROPS);
    const eulaFile = path.join(dirPath, 'eula.txt');
    if (!fs.existsSync(eulaFile)) fs.writeFileSync(eulaFile, 'eula=false\n');
    fs.mkdirSync(path.join(dirPath, 'logs'), { recursive: true });
    this.instances.push(ins);
    this.logs.set(ins.id, { lines: [], partial: '' });
    this.save();
    return this.get(ins.id);
  }

  // 导入整合包(zipPath 为服务器本地路径,或提供临时文件)
  async importModpack({ name, zipPath, tempFile }) {
    if (!name || !String(name).trim()) throw new Error('请输入实例名称');
    if (!zipPath && !tempFile) throw new Error('缺少整合包文件');
    const ins = this.create({ name });
    const dirPath = this.instanceDir(ins);
    try {
      let src = zipPath ? safeJoin(this.root, zipPath) : tempFile;
      if (!fs.existsSync(src)) throw new Error('整合包文件不存在: ' + (zipPath || '(上传数据缺失)'));
      // 复制到实例内再解压,保持原子性
      const tmpZip = path.join(dirPath, '__import.zip');
      fs.copyFileSync(src, tmpZip);
      await extractZip(dirPath, '__import.zip');
      fs.rmSync(tmpZip, { force: true });
      // 若解压出单一嵌套目录,提升一层(常见于某些整合包)
      this.flattenIfSingleDir(dirPath);
      // 探测服务端 jar
      const jars = findServerJars(dirPath);
      if (jars.length > 0) ins.serverJar = jars[0].path;
      // 补齐基础文件
      const propsFile = path.join(dirPath, 'server.properties');
      if (!fs.existsSync(propsFile)) fs.writeFileSync(propsFile, DEFAULT_PROPS);
      const eulaFile = path.join(dirPath, 'eula.txt');
      if (!fs.existsSync(eulaFile)) fs.writeFileSync(eulaFile, 'eula=false\n');
      fs.mkdirSync(path.join(dirPath, 'logs'), { recursive: true });
      ins.updatedAt = now();
      this.save();
      return this.get(ins.id);
    } catch (e) {
      // 失败回滚
      this.remove(ins.id, true);
      throw e;
    }
  }

  flattenIfSingleDir(dirPath) {
    let entries;
    try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); } catch { return; }
    const files = entries.filter(e => e.isFile());
    const dirs = entries.filter(e => e.isDirectory());
    if (files.length === 0 && dirs.length === 1 && dirs[0].name !== 'logs') {
      const sub = path.join(dirPath, dirs[0].name);
      for (const e of fs.readdirSync(sub, { withFileTypes: true })) {
        fs.renameSync(path.join(sub, e.name), path.join(dirPath, e.name));
      }
      try { fs.rmdirSync(sub); } catch {}
      this.flattenIfSingleDir(dirPath);
    }
  }

  remove(id, silent = false) {
    const ins = this.get(id);
    if (!ins) return false;
    if (this.isRunning(ins)) throw new Error('实例正在运行,请先停止');
    try { fs.rmSync(this.instanceDir(ins), { recursive: true, force: true }); } catch {}
    this.instances = this.instances.filter(i => i.id !== id);
    this.logs.delete(id); this.logStreams.delete(id); this.stats.delete(id); this.ping.delete(id);
    this.save();
    return true;
  }

  get(id) { return this.instances.find(i => i.id === id); }

  // ---------- 运行状态 ----------
  isAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; }
    catch (e) { return e.code === 'EPERM'; }
  }

  isRunning(ins) {
    return !!(ins.pid && this.isAlive(ins.pid));
  }

  status(ins) {
    return this.isRunning(ins) ? 'running' : 'stopped';
  }

  // ---------- 日志 ----------
  appendLog(id, line, stamp = true) {
    const rec = this.logs.get(id);
    if (!rec) return;
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const clean = String(line).replace(ANSI_RE, '').replace(/\r/g, '');
    if (!clean) return;
    // TPS 响应捕获(发送 tps 命令后匹配输出;须含 tps 字样,避免聊天等含三个小数的日志误判)
    if (this._tpsPending.has(id)) {
      const m = /tps/i.test(clean) ? /([\d.]+)\s*[,\s]+\s*([\d.]+)\s*[,\s]+\s*([\d.]+)/.exec(clean) : null;
      if (m) {
        this.tps.set(id, { value: parseFloat(m[1]), at: now() });
        this._tpsPending.delete(id);
      } else if (/unknown command|not a command|无法识别的命令|未知的命令/i.test(clean)) {
        this.tps.set(id, { value: null, at: now() });
        this._tpsPending.delete(id);
      }
    }
    const entry = stamp ? `[${t}] ${clean}` : clean;
    rec.lines.push(entry);
    if (rec.lines.length > MAX_LOG_LINES) rec.lines.splice(0, rec.lines.length - MAX_LOG_LINES);
    // 写日志文件
    const ws = this.logStreams.get(id);
    if (ws && ws.writable) ws.write(clean + '\n');
    // SSE 广播
    this.hub.send(EV.LINE, { id, line: entry });
  }

  rotateLogs(ins) {
    const logDir = path.join(this.instanceDir(ins), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const latest = path.join(logDir, 'latest.log');
    if (fs.existsSync(latest) && fs.statSync(latest).size > 0) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const backup = path.join(logDir, `${ts}.log`);
      try { fs.renameSync(latest, backup); } catch {}
    }
    // 只保留最近 3 个备份
    try {
      const olds = fs.readdirSync(logDir).filter(f => f !== 'latest.log' && f.endsWith('.log')).sort();
      while (olds.length > 3) fs.unlinkSync(path.join(logDir, olds.shift()));
    } catch {}
    const ws = fs.createWriteStream(latest, { flags: 'a' });
    this.logStreams.set(ins.id, ws);
  }

  logLines(id) { return this.logs.get(id)?.lines || []; }

  // ---------- Java ----------
  async javaList(force = false) {
    if (!force && this.javaCache && (now() - this.javaCacheAt < 60000)) return this.javaCache;
    const fresh = await detectJava();
    // 合并:保留旧列表中仍存在且新列表未包含的项(深度查找的成果不被快速扫描覆盖)
    const old = this.javaCache || [];
    const byPath = new Map(fresh.map(j => [j.path.toLowerCase(), j]));
    for (const j of old) {
      const k = j.path.toLowerCase();
      if (!byPath.has(k) && j.path && fs.existsSync(j.path)) byPath.set(k, j);
    }
    this.javaCache = [...byPath.values()].sort((a, b) => (b.major - a.major) || a.path.localeCompare(b.path));
    this.javaCacheAt = now();
    this.saveJavaCache();
    return this.javaCache;
  }

  get deepScanning() { return !!this._deepScanning; }

  // 深度查找(异步,后台执行;完成后更新缓存并持久化)
  deepScan() {
    if (this._deepScanning) return;
    this._deepScanning = true;
    detectJavaDeep()
      .then(list => {
        this.javaCache = list;
        this.javaCacheAt = now();
        this.saveJavaCache();
      })
      .catch(() => {})
      .finally(() => { this._deepScanning = false; });
  }

  resolveJava(ins) {
    if (ins.javaPath) return ins.javaPath;
    const list = this.javaCache || [];
    const picked = pickJava(list, ins.javaRequirement || 'auto');
    return picked ? picked.path : null;
  }

  // 从服务端 jar 读取 Minecraft 版本(version.json;失败则从文件名猜)
  async detectMcVersion(ins) {
    const jar = this.resolveJar(ins);
    if (!jar) return null;
    const jarPath = path.join(this.instanceDir(ins), jar);
    try {
      if (process.platform === 'win32') {
        const r = await runCmd('tar', ['-xOf', jarPath, 'version.json'], { timeout: 15000 });
        if (r.code === 0 && r.stdout) {
          try {
            const v = JSON.parse(r.stdout);
            if (v && (v.id || v.minecraftVersion || v.name)) return String(v.id || v.minecraftVersion || v.name);
          } catch {}
        }
      } else {
        const r = await runCmd('unzip', ['-p', jarPath, 'version.json'], { timeout: 15000 });
        if (r.code === 0 && r.stdout) {
          try {
            const v = JSON.parse(r.stdout);
            if (v && (v.id || v.minecraftVersion || v.name)) return String(v.id || v.minecraftVersion || v.name);
          } catch {}
        }
      }
    } catch {}
    const m = /(\d+\.\d+(?:\.\d+)?)/.exec(jar);
    return m ? m[1] : null;
  }

  // 智能自动选择:auto 时按服务器版本匹配所需 Java(1.26+ → 25),无法识别再取最新
  async resolveJavaSmart(ins) {
    if (ins.javaPath) return ins.javaPath;
    const list = this.javaCache || [];
    if (!list.length) return null;
    const req = ins.javaRequirement || 'auto';
    if (req !== 'auto' && req !== 'latest') {
      const picked = pickJava(list, req);
      return picked ? picked.path : null;
    }
    // auto:按 MC 版本匹配
    let mcVer = null, need = null;
    try { mcVer = await this.detectMcVersion(ins); } catch {}
    if (mcVer) {
      need = requiredJavaForMc(mcVer);
      if (need) {
        const picked = pickJava(list, need);
        if (picked) {
          this.appendLog(ins.id, `[面板] 检测到 MC ${mcVer} → 需要 Java ${need},使用 ${picked.path}`);
          return picked.path;
        }
      }
    }
    const latest = pickJava(list, 'latest');
    return latest ? latest.path : null;
  }

  async ensureJava() { await this.javaList(); }

  // 自动挑选服务端 jar
  resolveJar(ins) {
    const dirPath = this.instanceDir(ins);
    if (ins.serverJar) {
      const p = safeJoin(dirPath, ins.serverJar);
      if (fs.existsSync(p)) return ins.serverJar;
    }
    const jars = this.serverJars(ins);
    if (jars.length === 0) return null;
    ins.serverJar = jars[0].path;
    return ins.serverJar;
  }

  // ---------- 进程控制 ----------
  async start(id) {
    const ins = this.get(id);
    if (!ins) throw new Error('实例不存在');
    // _starting 覆盖 Java 检测/版本探测的异步窗口,防止连点双开
    if (this.isRunning(ins) || ins._starting) return { already: true };
    ins._starting = true;
    try {
      return await this.startInner(ins);
    } finally { ins._starting = false; }
  }

  async startInner(ins) {
    if (this.isRunning(ins)) return { already: true };

    await this.ensureJava();
    const java = await this.resolveJavaSmart(ins);
    if (!java) throw new Error('未找到 Java 运行时,请先在「Java 设置」中配置或安装 Java 8/17/21/25');

    const jar = this.resolveJar(ins);
    if (!jar) throw new Error('未找到服务端 jar,请上传服务端文件或指定 jar 路径');

    // EULA
    if (ins.eula) {
      const eulaFile = path.join(this.instanceDir(ins), 'eula.txt');
      fs.writeFileSync(eulaFile, 'eula=true\n');
    }

    // 初始化
    const dirPath = this.instanceDir(ins);
    this.rotateLogs(ins);
    this.appendLog(ins.id, '====== 服务端启动 ======');
    this.appendLog(ins.id, `Java: ${java}`);
    this.appendLog(ins.id, `Jar: ${jar}`);

    const args = [];
    if (ins.xms) args.push('-Xms' + ins.xms);
    if (ins.xmx) args.push('-Xmx' + ins.xmx);
    if (ins.jvmArgs) args.push(...ins.jvmArgs.split(/\s+/).filter(Boolean));
    args.push('-jar', jar, 'nogui');

    let child;
    try {
      child = spawn(java, args, { cwd: dirPath, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      this.appendLog(ins.id, '启动失败: ' + (e.message || e));
      throw new Error('启动失败: ' + (e.message || e));
    }

    ins.pid = child.pid;
    ins.startedAt = now();
    ins.updatedAt = now();
    ins._childStdin = child.stdin;
    this.save();
    this.stats.set(ins.id, { cpu: 0, mem: 0, rss: 0, at: now() });

    let partial = '';
    const onData = (d) => {
      partial += d.toString('utf8');
      let idx;
      while ((idx = partial.indexOf('\n')) >= 0) {
        const line = partial.slice(0, idx);
        partial = partial.slice(idx + 1);
        this.appendLog(ins.id, line);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('error', (e) => {
      this.appendLog(ins.id, '进程错误: ' + (e.message || e));
    });
    child.on('exit', (code) => {
      if (partial) { this.appendLog(ins.id, partial); partial = ''; }
      const wasRunning = this.status(ins) === 'running';
      ins.pid = null; ins.startedAt = 0; ins._childStdin = null;
      this.save();
      this.appendLog(ins.id, `====== 服务端已停止 (退出码 ${code}) ======`);
      this.hub.send(EV.STATUS, { id, status: 'stopped' });
      const ws = this.logStreams.get(id);
      if (ws) { try { ws.end(); } catch {} this.logStreams.delete(id); }
      // 进程退出后立即探测一次(玩家页面及时刷新)
      this.probeOnce(ins);
    });

    this.hub.send(EV.STATUS, { id, status: 'running', pid: child.pid });
    this.appendLog(ins.id, `PID: ${child.pid}`);
    return { pid: child.pid };
  }

  async stop(id) {
    const ins = this.get(id);
    if (!ins) throw new Error('实例不存在');
    if (!this.isRunning(ins)) return { already: true };
    const pid = ins.pid;
    if (ins._childStdin && ins._childStdin.writable) {
      this.appendLog(ins.id, '[面板] 发送 stop 指令,等待退出...');
      try { ins._childStdin.write('stop\n'); } catch {}
    } else {
      // 接管的外部进程,无法走控制台,直接终止
      this.appendLog(ins.id, '[面板] 该进程非本面板启动,无法发送 stop,将直接终止');
      await this.killProc(pid);
      return { stopped: true };
    }
    // 等待退出
    const deadline = Date.now() + STOP_TIMEOUT;
    while (Date.now() < deadline) {
      if (!this.isAlive(pid)) break;
      await sleep(500);
    }
    if (this.isAlive(pid)) {
      this.appendLog(ins.id, '[面板] 超时未退出,强制终止进程');
      await this.killProc(pid);
    }
    return { stopped: true };
  }

  async kill(id) {
    const ins = this.get(id);
    if (!ins) throw new Error('实例不存在');
    if (!this.isRunning(ins)) return { already: true };
    const pid = ins.pid;
    this.appendLog(ins.id, '[面板] 强制终止进程');
    await this.killProc(pid);
    return { killed: true };
  }

  killProc(pid) {
    return new Promise((resolve) => {
      if (process.platform === 'win32') {
        const { spawn } = require('child_process');
        const p = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true });
        p.on('close', () => resolve(true));
        p.on('error', () => resolve(false));
      } else {
        try { process.kill(pid, 'SIGKILL'); } catch {}
        resolve(true);
      }
    });
  }

  async restart(id) {
    await this.stop(id);
    // 等进程完全消失
    const ins = this.get(id);
    if (ins) {
      for (let i = 0; i < 20 && this.isAlive(ins.pid); i++) await sleep(300);
    }
    return this.start(id);
  }

  command(id, cmd) {
    const ins = this.get(id);
    if (!ins) throw new Error('实例不存在');
    if (!this.isRunning(ins)) throw new Error('服务端未运行');
    const text = String(cmd || '').replace(/[\r\n]+/g, ' ').trim();
    if (!text) return false;
    if (ins._childStdin && ins._childStdin.writable) {
      ins._childStdin.write(text + '\n');
      this.appendLog(ins.id, `[命令] ${text}`);
      return true;
    }
    throw new Error('无法写入控制台');
  }

  // ---------- server.properties ----------
  // 查找服务端 jar(带缓存):overview/探测轮询高频调用,避免每次同步扫盘。
  // 目录条目增删会更新 mtime 触发重扫,另有 60 秒兜底刷新
  serverJars(ins) {
    const dirPath = this.instanceDir(ins);
    let dirMtime = 0;
    try { dirMtime = fs.statSync(dirPath).mtimeMs; } catch {}
    const cache = this._jarsCache.get(ins.id);
    if (cache && cache.dirMtime === dirMtime && (now() - cache.at) < 60000) return cache.jars;
    const jars = findServerJars(dirPath);
    this._jarsCache.set(ins.id, { dirMtime, at: now(), jars });
    return jars;
  }

  readProps(ins) {
    const dirPath = this.instanceDir(ins);
    const propsFile = path.join(dirPath, 'server.properties');
    let mtime = 0;
    try { mtime = fs.statSync(propsFile).mtimeMs; } catch {}
    let cache = this._propsCache.get(ins.id);
    // 按文件 mtime 缓存解析结果;面板内外改动文件都会更新 mtime,天然失效
    if (!cache || cache.mtime !== mtime) {
      const text = fs.existsSync(propsFile) ? fs.readFileSync(propsFile, 'utf8') : DEFAULT_PROPS;
      cache = { mtime, text, parsed: parseProperties(text) };
      this._propsCache.set(ins.id, cache);
    }
    let eula = false;
    try {
      const et = fs.readFileSync(path.join(dirPath, 'eula.txt'), 'utf8');
      eula = /eula\s*=\s*true/i.test(et);
    } catch {}
    return { props: cache.parsed.map, eula, jars: this.serverJars(ins).map(j => j.path), text: cache.text };
  }

  applyProps(ins, patch) {
    const dirPath = this.instanceDir(ins);
    const propsFile = path.join(dirPath, 'server.properties');
    const text = fs.existsSync(propsFile) ? fs.readFileSync(propsFile, 'utf8') : DEFAULT_PROPS;
    const { lines } = parseProperties(text);
    // 值内换行会注入额外配置行,统一压成空格
    const clean = (v) => String(v).replace(/[\r\n]+/g, ' ').trim();
    const keys = new Set(Object.keys(patch));
    const existed = new Set();
    const out = [];
    for (const l of lines) {
      if (l.type === 'kv' && keys.has(l.key)) {
        existed.add(l.key);
        out.push(`${l.key}=${clean(patch[l.key])}`);
      } else out.push(l.line);
    }
    // 新增键
    for (const k of keys) {
      if (!existed.has(k)) out.push(`${k}=${clean(patch[k])}`);
    }
    fs.writeFileSync(propsFile, out.join('\n').replace(/\n+$/, '') + '\n');
    // EULA 单独处理
    if ('eula' in patch) {
      const eulaFile = path.join(dirPath, 'eula.txt');
      fs.writeFileSync(eulaFile, String(patch.eula) === 'true' ? 'eula=true\n' : 'eula=false\n');
    }
    ins.serverPort = parseInt(patch['server-port'], 10) || ins.serverPort || 25565;
    ins.serverIp = patch['server-ip'] || '';
    ins.updatedAt = now();
    this.save();
    return true;
  }

  // ---------- 探测 ----------
  pingTarget(ins) {
    const props = this.readProps(ins).props;
    let host = ins.serverIp || props['server-ip'] || '';
    const port = parseInt(props['server-port'] || '25565', 10) || 25565;
    ins.serverIp = host; ins.serverPort = port;
    return { host: host || '127.0.0.1', port };
  }

  // 读取 ops.json(带 mtime 缓存),判断管理员
  readOps(ins) {
    const file = path.join(this.instanceDir(ins), 'ops.json');
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch {}
    const cache = this._opsCache.get(ins.id);
    if (cache && cache.mtime === mtime) return cache.data;
    const data = { byUuid: new Set(), byName: new Map(), list: [] };
    try {
      const ops = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(ops)) {
        for (const op of ops) {
          const name = String(op.name || '').toLowerCase();
          const uuid = normUuid(op.uuid);
          if (uuid) data.byUuid.add(uuid);
          if (name) data.byName.set(name, op.level || 4);
          data.list.push({ name: String(op.name || ''), uuid: String(op.uuid || ''), level: op.level || 4 });
        }
      }
    } catch {}
    this._opsCache.set(ins.id, { mtime, data });
    return data;
  }

  async probeOnce(ins) {
    const { host, port } = this.pingTarget(ins);
    let result = { online: false, error: 'unknown' };
    // 绑定特定 IP 时,先试该 IP 再试回环
    const hosts = [host];
    if (host !== '127.0.0.1' && host !== 'localhost') hosts.push('127.0.0.1');
    for (const h of hosts) {
      try {
        result = await probeServer(h, port, { timeout: 3500 });
        if (result.online) break;
      } catch { }
    }
    // 富化玩家样本:判定管理员/玩家(读取 ops.json)
    if (result.online && Array.isArray(result.sample)) {
      const ops = this.readOps(ins);
      result.sample = result.sample.map(p => {
        const name = String(p.name || '');
        const uuid = normUuid(p.uuid);
        const level = ops.byName.get(name.toLowerCase())
          ?? (uuid && ops.byUuid.has(uuid) ? (ops.list.find(o => normUuid(o.uuid) === uuid) || {}).level ?? 4 : null);
        return { name, uuid, admin: level !== null, level: level ?? 0 };
      });
    }
    this.ping.set(ins.id, { result, at: now() });
    this.hub.send(EV.PLAYERS, { id: ins.id, ...result });
  }

  // ---------- 备份 ----------
  // 打包世界前暂停服务端保存(save-off / save-all flush),完成后恢复,避免 zip 到写一半的数据
  async withWorldFrozen(ins, fn) {
    const canFreeze = this.isRunning(ins) && ins._childStdin && ins._childStdin.writable;
    if (canFreeze) {
      try { ins._childStdin.write('save-off\n'); } catch {}
      try { ins._childStdin.write('save-all flush\n'); } catch {}
      await sleep(2000);
    }
    try { return await fn(); }
    finally {
      if (canFreeze) { try { ins._childStdin.write('save-on\n'); } catch {} }
    }
  }

  // 创建备份:isAuto=true 走定时(受最大数量限制),name 为手动备份自定义名称
  // 同一实例同时只允许一个备份任务(大世界打包可能超过定时周期,防止并发压缩同一世界)
  async createBackup(id, { isAuto = false, name = '' } = {}) {
    const ins = this.get(id);
    if (!ins) throw new Error('实例不存在');
    if (this._backupRunning.has(ins.id)) {
      if (isAuto) return null; // 自动备份撞上进行中的任务:静默跳过,下个周期再来
      throw new Error('已有备份正在进行,请稍后再试');
    }
    this._backupRunning.add(ins.id);
    try {
      return await this.createBackupInner(ins, { isAuto, name });
    } finally {
      this._backupRunning.delete(ins.id);
    }
  }

  async createBackupInner(ins, { isAuto = false, name = '' } = {}) {
    const dir = this.instanceDir(ins);
    const levelName = this.readProps(ins).props['level-name'];
    const worlds = worldFolders(dir, levelName);
    if (worlds.length === 0) throw new Error('未找到世界文件夹(' + (levelName || 'world') + ')');
    fs.mkdirSync(backupsDir(dir), { recursive: true });
    // 手动备份统一加 manual- 前缀(与自动备份区分,不被自动清理)
    const base = safeBackupName(isAuto ? renderPattern(ins.backupPattern) : MANUAL_PREFIX + (name || renderPattern('{y}{m}{d}-{h}{min}')));
    let fileName = base + '.zip';
    let n = 1;
    while (fs.existsSync(path.join(backupsDir(dir), fileName))) fileName = `${base}-${n++}.zip`;
    const zipFile = path.join(backupsDir(dir), fileName);
    await this.withWorldFrozen(ins, () => zipWorlds(dir, worlds, zipFile));
    if (isAuto) {
      ins.lastBackupAt = now();
      this.pruneAutoBackups(ins);
      this.save();
    }
    this.appendLog(ins.id, `[面板] 备份完成: ${fileName}`);
    return { name: fileName, size: fs.statSync(zipFile).size };
  }

  // 自动备份按时间清理:超过 backupMax 删最旧的(手动备份不受影响)
  pruneAutoBackups(ins) {
    const max = parseInt(ins.backupMax, 10) || 10;
    const all = listBackups(this.instanceDir(ins));
    const autos = all.filter(b => !b.name.startsWith(MANUAL_PREFIX));
    const toDelete = autos.length - max;
    for (let i = 0; i < toDelete && i < autos.length; i++) {
      try { fs.unlinkSync(path.join(backupsDir(this.instanceDir(ins)), autos[i].name)); } catch {}
    }
    if (toDelete > 0) this.appendLog(ins.id, `[面板] 自动清理 ${toDelete} 个过期备份`);
  }

  deleteBackup(id, name) {
    const ins = this.get(id);
    if (!ins) throw new Error('实例不存在');
    const file = safeJoin(backupsDir(this.instanceDir(ins)), name);
    if (!file.toLowerCase().endsWith('.zip') || !fs.existsSync(file)) throw new Error('备份不存在');
    fs.unlinkSync(file);
    return true;
  }

  // 打包当前世界到指定 zip(运行中的服务端先 save-off/save-all,完成后 save-on)
  async createSaveZip(ins, zipFile) {
    const dir = this.instanceDir(ins);
    const levelName = this.readProps(ins).props['level-name'];
    const worlds = worldFolders(dir, levelName);
    if (worlds.length === 0) throw new Error('未找到世界文件夹(' + (levelName || 'world') + ')');
    await this.withWorldFrozen(ins, () => zipWorlds(dir, worlds, zipFile));
    return worlds;
  }

  // 定时备份调度:每分钟检查一次
  checkAutoBackups() {
    const t = now();
    for (const ins of this.instances) {
      if (!ins.backupEnabled) continue;
      const interval = (parseInt(ins.backupInterval, 10) || 60) * 60000;
      const last = ins.lastBackupAt || 0;
      if (t - last >= interval) {
        this.createBackup(ins.id, { isAuto: true }).catch(e => this.appendLog(ins.id, '[面板] 自动备份失败: ' + (e.message || e)));
      }
    }
  }

  // ---------- 轮询 ----------
  startPoller() {
    this._pollTimer = setInterval(() => this.pollAll(), 2000);
    this._pollTimer.unref && this._pollTimer.unref();
    // 配置自动保存安全网:每 30 秒落盘一次,避免异常退出丢失
    this._saveTimer = setInterval(() => this.save(), 30000);
    this._saveTimer.unref && this._saveTimer.unref();
    // 定时备份:每分钟检查
    this._backupTimer = setInterval(() => this.checkAutoBackups(), 60000);
    this._backupTimer.unref && this._backupTimer.unref();
  }

  async pollAll() {
    const running = this.instances.filter(i => this.isRunning(i));
    // 资源统计:每 6 秒一次(Windows 下每次要 spawn PowerShell,过于频繁开销大)
    this._statsTick = (this._statsTick || 0) + 1;
    if (running.length > 0 && this._statsTick % 3 === 0) {
      await this.pollStats(running);
    }
    // 玩家探测:每 5 秒(约 2~3 次 poll 一次)
    const t = now();
    for (const ins of running) {
      const last = this.ping.get(ins.id)?.at || 0;
      if (t - last > 5000) this.probeOnce(ins);
    }
    // 磁盘占用:错峰扫描(每 ~6 秒最多启动一个,缓存 120 秒)
    this._diskTick = (this._diskTick || 0) + 1;
    if (this._diskTick % 3 === 0) this.maybeScanDisk();
    // TPS 探测:每 ~10 秒一次
    this._tpsTick = (this._tpsTick || 0) + 1;
    if (this._tpsTick % 5 === 0) this.maybeProbeTps();
  }

  // TPS 探测:向控制台发送 tps 命令并解析输出(仅面板启动的进程;原版显示 null)
  maybeProbeTps() {
    const t = now();
    for (const ins of this.instances) {
      if (!this.isRunning(ins)) continue;
      if (!ins._childStdin || !ins._childStdin.writable) continue;
      const cached = this.tps.get(ins.id);
      const stale = !cached || (t - cached.at > 10000);
      const pendingSince = this._tpsPending.get(ins.id);
      if (pendingSince && t - pendingSince > 6000) {
        this._tpsPending.delete(ins.id);
        this.tps.set(ins.id, { value: null, at: t });
        continue;
      }
      if (stale && !pendingSince) {
        try { ins._childStdin.write('tps\n'); } catch {}
        this._tpsPending.set(ins.id, t);
      }
    }
  }

  // 磁盘占用扫描:一次只扫一个实例,结果缓存 120 秒
  maybeScanDisk() {
    const t = now();
    for (const ins of this.instances) {
      const cached = this.disk.get(ins.id);
      const stale = !cached || (t - cached.at > 120000);
      if (stale && !this._diskScanning.has(ins.id)) {
        this.scanDisk(ins.id);
        return; // 每轮只启动一个
      }
    }
  }

  async scanDisk(id) {
    const ins = this.get(id);
    if (!ins || this._diskScanning.has(id)) return;
    this._diskScanning.add(id);
    try {
      const size = await dirSize(this.instanceDir(ins));
      this.disk.set(id, { size, at: now() });
    } catch {
      this.disk.set(id, { size: null, at: now() });
    } finally {
      this._diskScanning.delete(id);
    }
  }

  diskOf(ins) {
    return this.disk.get(ins.id)?.size ?? null;
  }

  async pollStats(running) {
    if (process.platform === 'win32') {
      const ids = running.map(i => i.pid).join(',');
      const r = await runCmd('powershell', ['-NoProfile', '-Command',
        `Get-Process -Id ${ids} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id)|$([math]::Round($_.CPU,2))|$($_.WorkingSet64)" }`],
        { timeout: 6000 });
      const procMap = new Map();
      for (const line of r.stdout.split(/\r?\n/)) {
        const m = /^(\d+)\|([\d.]+)\|(\d+)$/.exec(line.trim());
        if (m) procMap.set(parseInt(m[1], 10), { cpuSec: parseFloat(m[2]), rss: parseInt(m[3], 10) });
      }
      const wall = now();
      for (const ins of running) {
        const p = procMap.get(ins.pid);
        const prev = this.prevProcCpu.get(ins.pid) || { cpuSec: 0, at: wall };
        const s = this.stats.get(ins.id) || {};
        if (p) {
          const dt = Math.max(0.1, (wall - prev.at) / 1000);
          const cpu = Math.max(0, (p.cpuSec - prev.cpuSec) / dt) * 100;
          this.stats.set(ins.id, { cpu: Math.min(999, cpu), mem: p.rss, rss: p.rss, at: wall });
          this.prevProcCpu.set(ins.pid, { cpuSec: p.cpuSec, at: wall });
        } else {
          // 进程可能刚启动,Get-Process 快照未包含
          this.stats.set(ins.id, { ...s, at: wall });
        }
        this.hub.send(EV.STATS, { id: ins.id, cpu: this.stats.get(ins.id).cpu, mem: this.stats.get(ins.id).mem });
      }
    } else {
      const ids = running.map(i => i.pid).join(',');
      const r = await runCmd('ps', ['-o', 'pid=,pcpu=,rss=', '-p', ids], { timeout: 6000 });
      const procMap = new Map();
      for (const line of r.stdout.split(/\r?\n/)) {
        const m = /^\s*(\d+)\s+([\d.]+)\s+(\d+)/.exec(line);
        if (m) procMap.set(parseInt(m[1], 10), { pcpu: parseFloat(m[2]), rss: parseInt(m[3], 10) * 1024 });
      }
      for (const ins of running) {
        const p = procMap.get(ins.pid);
        if (p) this.stats.set(ins.id, { cpu: p.pcpu, mem: p.rss, rss: p.rss, at: now() });
        this.hub.send(EV.STATS, { id: ins.id, cpu: this.stats.get(ins.id)?.cpu || 0, mem: this.stats.get(ins.id)?.mem || 0 });
      }
    }
  }

  async startAuto() {
    for (const ins of this.instances) {
      if (ins.autoStart && !this.isRunning(ins)) {
        try { await this.start(ins.id); }
        catch (e) { this.appendLog(ins.id, '[面板] 自动启动失败: ' + (e.message || e)); }
      }
    }
  }

  // ---------- 对外视图 ----------
  overview(publicView = false) {
    const out = [];
    for (const ins of this.instances) {
      const running = this.isRunning(ins);
      const st = this.stats.get(ins.id);
      const pg = this.ping.get(ins.id);
      const { host, port } = this.pingTarget(ins);
      const jar = this.resolveJar(ins);
      const tps = this.tps.get(ins.id);
      out.push({
        id: ins.id, name: ins.name, dir: ins.dir,
        status: running ? 'running' : 'stopped',
        pid: running ? ins.pid : null,
        startedAt: ins.startedAt,
        cpu: st ? Math.round(st.cpu * 10) / 10 : 0,
        mem: st ? st.mem : 0,
        xmx: ins.xmx || '',
        disk: this.diskOf(ins),
        diskScanning: this._diskScanning.has(ins.id),
        tps: running ? (tps ? tps.value : null) : null,
        ip: host === '127.0.0.1' ? null : host,
        port,
        ping: pg ? pg.result : null,
        pingAt: pg ? pg.at : 0,
        java: ins.javaPath || (ins.javaRequirement === 'auto' ? '自动' : 'Java ' + ins.javaRequirement),
        jar: jar || '',
        autoStart: ins.autoStart,
        eula: ins.eula
      });
    }
    return out;
  }
}

// ---------- 工具 ----------
// UUID 归一化:去横线、转小写,便于匹配
function normUuid(u) {
  return String(u || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
}

// ---------- server.properties 解析(保留注释与顺序) ----------
function parseProperties(text) {
  const lines = [];
  const map = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\r$/, '');
    const m = /^([^#!][^=]*)=(.*)$/.exec(line);
    if (m) {
      const key = m[1].trim();
      const value = m[2];
      map[key] = value;
      lines.push({ type: 'kv', key, value, line: `${key}=${value}` });
    } else {
      lines.push({ type: 'raw', value: line });
    }
  }
  return { lines, map };
}

module.exports = { InstanceManager, parseProperties, DEFAULT_PROPS, normUuid };
