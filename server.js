'use strict';
// MCSLite — 轻量 Minecraft 服务器管理面板(零依赖)
// 启动: node server.js [--port 8333] [--host 0.0.0.0]
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');
const { spawn, spawnSync } = require('child_process');

// 账号存储依赖内置 node:sqlite(Node 22.5 引入,22.13 起无需 flag)
const NODE_MIN = [22, 13];
const [nvMaj, nvMin] = process.versions.node.split('.').map(Number);
if (nvMaj < NODE_MIN[0] || (nvMaj === NODE_MIN[0] && nvMin < NODE_MIN[1])) {
  console.error(`[面板] 需要 Node.js v${NODE_MIN.join('.')} 或更高版本,当前为 v${process.versions.node}`);
  console.error('[面板] 请到 https://nodejs.org 升级后重试');
  process.exit(1);
}

const { createRouter, staticServe, MIME } = require('./lib/router');
const { Auth } = require('./lib/auth');
const { InstanceManager } = require('./lib/instances');
const { SSEHub } = require('./lib/sse');
const { readJson, writeJson, readBody, json, fail, ok, runCmd, uid, now, safeJoin, safeResolve } = require('./lib/util');
const F = require('./lib/files');

const VERSION = '1.0.0';
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const WEB_DIR = path.join(ROOT, 'web');
const BG_DIR = path.join(DATA_DIR, 'backgrounds');
const TMP_DIR = path.join(DATA_DIR, 'tmp');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BG_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

// Windows 下把控制台切到 UTF-8,保证中文日志正常显示
if (process.platform === 'win32') {
  try {
    const r = spawnSync('cmd', ['/c', 'chcp 65001 >nul'], { windowsHide: true, stdio: 'ignore' });
    if (r.error) throw r.error;
  } catch {}
}

// ---------- 面板配置 ----------
const CFG_FILE = path.join(DATA_DIR, 'config.json');
function loadConfig() {
  let cfg = readJson(CFG_FILE, null);
  if (!cfg || typeof cfg !== 'object') {
    cfg = {
      panel: { host: '0.0.0.0', port: 8333, background: 'web/bg.jpg' },
      maxUploadMB: 4096,
      createdAt: now()
    };
    writeJson(CFG_FILE, cfg);
  }
  if (!cfg.panel) cfg.panel = { host: '0.0.0.0', port: 8333, background: 'web/bg.jpg' };
  if (!cfg.panel.background) cfg.panel.background = 'web/bg.jpg';
  // 首页展示设置(A 标题 / B 图片 / C 标语),空值=自动
  if (cfg.panel.heroTitle === undefined) cfg.panel.heroTitle = '';
  if (cfg.panel.heroSlogan === undefined) cfg.panel.heroSlogan = '';
  if (cfg.panel.heroImage === undefined) cfg.panel.heroImage = '';
  // 自定义 IP 池(实例绑定只能从中选择)
  if (!Array.isArray(cfg.panel.ipList)) cfg.panel.ipList = [];
  // 毛玻璃颜色配置(纯色,无渐变)
  if (cfg.panel.glassColor === undefined) cfg.panel.glassColor = '#ffffff';
  if (cfg.panel.glassOpacity === undefined) cfg.panel.glassOpacity = 0.08;
  return cfg;
}
function saveConfig(cfg) { writeJson(CFG_FILE, cfg); }
const config = loadConfig();

// CLI 参数覆盖
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--port') config.panel.port = parseInt(process.argv[++i], 10) || 8333;
  else if (a === '--host') config.panel.host = process.argv[++i];
}

// ---------- 全局对象 ----------
const hub = new SSEHub();
const auth = new Auth(DATA_DIR);
const im = new InstanceManager({ root: ROOT, dataDir: DATA_DIR, hub, getConfig: () => config });

// ---------- 系统状态 ----------
let sysPrevCpu = { idle: 0, total: 0, at: now() };
let sysCpu = 0;
function sampleSysCpu() {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const c of cpus) {
    for (const t of Object.values(c.times)) total += t;
    idle += c.times.idle;
  }
  const at = now();
  const dt = Math.max(0.1, (at - sysPrevCpu.at) / 1000);
  const dIdle = idle - sysPrevCpu.idle;
  const dTotal = total - sysPrevCpu.total;
  if (dTotal > 0) sysCpu = Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
  sysPrevCpu = { idle, total, at };
}
setInterval(sampleSysCpu, 2000);
sampleSysCpu();

function getLanIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

// 玩家视图 /api/status 的公开数据(不含敏感信息)
function publicStatus() {
  const memTotal = os.totalmem();
  const memFree = os.freemem();
  return {
    ok: true,
    version: VERSION,
    time: now(),
    system: {
      hostname: os.hostname(),
      platform: os.platform() === 'win32' ? 'Windows' : os.platform(),
      arch: os.arch(),
      uptime: os.uptime(),
      cpu: Math.round(sysCpu * 10) / 10,
      memUsed: memTotal - memFree,
      memTotal,
      memPercent: Math.round(((memTotal - memFree) / memTotal) * 1000) / 10,
      lanIPs: getLanIPs(),
      node: process.version
    },
    instances: im.overview(true).map(i => ({
      id: i.id, name: i.name,
      status: i.status,
      ip: i.ip, port: i.port,
      uptime: i.startedAt ? now() - i.startedAt : 0,
      cpu: i.cpu, mem: i.mem, xmx: i.xmx,
      disk: i.disk, diskScanning: i.diskScanning,
      ping: i.ping
    })),
    hero: {
      title: String(config.panel.heroTitle || ''),
      slogan: String(config.panel.heroSlogan || ''),
      hasImage: !!(config.panel.heroImage && safeResolve(ROOT, config.panel.heroImage) && fs.existsSync(path.resolve(ROOT, config.panel.heroImage)))
    },
    glass: { color: config.panel.glassColor, opacity: config.panel.glassOpacity }
  };
}

// ---------- 路由 ----------
const router = createRouter();

// 图片响应:ETag 协商缓存。浏览器二次访问带 If-None-Match 命中即 304,
// 避免整图反复传输;文件变化时 ETag 随 mtime+size 变化,即时生效
function etagOf(st) {
  return '"' + st.size.toString(36) + '-' + Math.floor(st.mtimeMs).toString(36) + '"';
}
function sendImage(req, res, file, st) {
  const etag = etagOf(st);
  const imm = path.extname(file).toLowerCase() === '.svg' ? '' : '; max-age=60';
  const inm = String(req.headers['if-none-match'] || '');
  if (inm && inm.split(',').map(s => s.trim()).includes(etag)) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' + imm });
    res.end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'image/jpeg',
    'Content-Length': st.size,
    'ETag': etag,
    'Cache-Control': 'no-cache' + imm
  });
  fs.createReadStream(file).pipe(res);
}

// 后台图片(需在静态通配之前匹配)
router.get('bg', (req, res) => {
  const file = safeResolve(ROOT, config.panel.background);
  if (!file || !fs.existsSync(file)) { fail(res, 404, '背景图片不存在'); return; }
  sendImage(req, res, file, fs.statSync(file));
});

// 首页展示图片(B,管理员可单独设置)
router.get('hero', (req, res) => {
  const rel = config.panel.heroImage;
  if (!rel) { fail(res, 404, '未设置首页图片'); return; }
  const file = safeResolve(ROOT, rel);
  if (!file || !fs.existsSync(file)) { fail(res, 404, '首页图片不存在'); return; }
  sendImage(req, res, file, fs.statSync(file));
});

// 玩家视图(公开,只读)
router.get('api/status', (req, res) => json(res, 200, publicStatus()));
router.get('api/status/:id', (req, res) => {
  const oi = im.overview(true).find(i => i.id === req.params.id);
  if (!oi) return fail(res, 404, '实例不存在');
  json(res, 200, {
    ok: true,
    version: VERSION,
    time: now(),
    instance: {
      id: oi.id, name: oi.name, status: oi.status,
      ip: oi.ip, port: oi.port,
      uptime: oi.startedAt ? now() - oi.startedAt : 0,
      cpu: oi.cpu, mem: oi.mem, xmx: oi.xmx,
      disk: oi.disk, diskScanning: oi.diskScanning,
      tps: oi.tps,
      ping: oi.ping
    }
  });
});
router.get('api/version', (req, res) => ok(res, { version: VERSION, name: 'MCSLite' }));

// ---------- 玩家下载(备份/实时存档,仅地图;每 IP 限速) ----------
const dlLimits = new Map();     // ip -> lastAt,下载 120 秒 1 次
const dlListLimits = new Map(); // ip -> lastAt,列表 10 秒 1 次
function checkLimit(map, ip, windowMs) {
  const key = String(ip || '?');
  const last = map.get(key) || 0;
  const wait = windowMs - (now() - last);
  if (wait > 0) return { blocked: true, retryIn: Math.ceil(wait / 1000) };
  // 防止伪造 IP 撑爆内存
  if (map.size > 2000) map.delete(map.keys().next().value);
  map.set(key, now());
  return { blocked: false };
}
function checkDlLimit(ip) { return checkLimit(dlLimits, ip, 120000); }
function checkListLimit(ip) { return checkLimit(dlListLimits, ip, 10000); }

router.get('api/status/:id/backups', (req, res) => {
  const ins = im.get(req.params.id);
  if (!ins) return fail(res, 404, '实例不存在');
  const lim = checkListLimit(req.socket.remoteAddress);
  if (lim.blocked) return fail(res, 429, `请求过于频繁,请 ${lim.retryIn} 秒后再试`);
  ok(res, { backups: B.listBackups(im.instanceDir(ins)).map(b => ({ name: b.name, size: b.size, mtime: b.mtime })) });
});

router.get('api/status/:id/backup/:name', (req, res) => {
  const ins = im.get(req.params.id);
  if (!ins) return fail(res, 404, '实例不存在');
  let file = null;
  try { file = safeJoin(B.backupsDir(im.instanceDir(ins)), req.params.name); }
  catch { return fail(res, 404, '备份不存在'); }
  // 先校验文件存在,再扣限流配额(404 不占次数)
  if (!file.toLowerCase().endsWith('.zip') || !fs.existsSync(file)) return fail(res, 404, '备份不存在');
  const lim = checkDlLimit(req.socket.remoteAddress);
  if (lim.blocked) return fail(res, 429, `下载过于频繁,请 ${lim.retryIn} 秒后再试`);
  const st = fs.statSync(file);
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': st.size,
    'Content-Disposition': 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(path.basename(file))
  });
  fs.createReadStream(file).pipe(res);
});

// 实时存档(仅地图):现场打包当前世界下载
router.get('api/status/:id/save', async (req, res) => {
  const ins = im.get(req.params.id);
  if (!ins) return fail(res, 404, '实例不存在');
  const dir = im.instanceDir(ins);
  const worlds = B.worldFolders(dir, im.readProps(ins).props['level-name']);
  if (worlds.length === 0) return fail(res, 404, '未找到世界文件夹');
  // 校验通过后再扣限流配额
  const lim = checkDlLimit(req.socket.remoteAddress);
  if (lim.blocked) return fail(res, 429, `下载过于频繁,请 ${lim.retryIn} 秒后再试`);
  const tmpFile = path.join(TMP_DIR, 'save-' + uid(10) + '.zip');
  try {
    await im.createSaveZip(ins, tmpFile);
    const st = fs.statSync(tmpFile);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': st.size,
      'Content-Disposition': 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(ins.name + '-save.zip')
    });
    const stream = fs.createReadStream(tmpFile);
    stream.pipe(res);
    res.on('close', () => { try { fs.unlinkSync(tmpFile); } catch {} });
  } catch (e) {
    try { fs.rmSync(tmpFile, { force: true }); } catch {}
    fail(res, 500, '打包失败: ' + (e.message || e));
  }
});

// ---------- 认证 ----------
router.post('api/login', async (req, res) => {
  let body;
  try { body = await readJsonBody(req, 64 * 1024); }
  catch { return fail(res, 400, '请求格式错误'); }
  const name = String(body.username || '').trim();
  const pw = String(body.password || '');
  if (!name || !pw) return fail(res, 400, '请输入用户名和密码');
  const key = (req.socket.remoteAddress || '?') + '|' + name;
  const rate = auth.checkRate(key);
  if (rate.blocked) return fail(res, 429, `尝试次数过多,请 ${rate.retryIn} 秒后再试`);
  const user = auth.findUser(name);
  if (!user || !auth.verify(pw, user)) {
    return fail(res, 401, '用户名或密码错误');
  }
  auth.resetRate(key);
  const token = auth.createSession(user);
  auth.setCookie(res, token);
  json(res, 200, { ok: true, name: user.name, role: user.role, mustChange: !!user.must_change });
});

router.post('api/logout', (req, res) => {
  const cookie = req.headers.cookie || '';
  const m = /(?:^|;\s*)token=([^;]+)/.exec(cookie);
  if (m) { try { auth.destroy(decodeURIComponent(m[1])); } catch {} }
  auth.clearCookie(res);
  ok(res, {});
});

router.get('api/me', (req, res) => {
  if (!req.session) return fail(res, 401, '未登录');
  const user = auth.findUser(req.session.name);
  ok(res, { name: req.session.name, role: req.session.role, mustChange: !!(user && user.must_change) });
});

// ---------- 管理后台 ----------
function admin(fn) {
  return (req, res) => {
    if (!auth.requireAuth(req, res)) return;
    if (fn._admin && !auth.requireAdmin(req, res)) return;
    Promise.resolve()
      .then(() => fn(req, res))
      .catch(e => { try { fail(res, (e && e.status) || 500, (e && e.message) || '服务器错误'); } catch {} });
  };
}
admin.admin = (fn) => { fn._admin = true; return admin(fn); };

// 总览
router.get('api/admin/overview', admin(async (req, res) => {
  const java = await im.javaList();
  ok(res, {
    version: VERSION,
    instances: im.overview(),
    java: java.map(j => ({ path: j.path, major: j.major, label: j.label })),
    lanIPs: getLanIPs(),
    panel: {
      host: config.panel.host, port: config.panel.port, background: config.panel.background,
      heroTitle: config.panel.heroTitle, heroSlogan: config.panel.heroSlogan, heroImage: config.panel.heroImage,
      ipList: config.panel.ipList, glassColor: config.panel.glassColor, glassOpacity: config.panel.glassOpacity
    }
  });
}));

// Java
router.get('api/admin/java', admin(async (req, res) => {
  ok(res, { java: (await im.javaList()).map(j => ({ path: j.path, major: j.major, label: j.label })) });
}));
router.post('api/admin/java/scan', admin(async (req, res) => {
  ok(res, { java: (await im.javaList(true)).map(j => ({ path: j.path, major: j.major, label: j.label })) });
}));
// 深度查找:全盘遍历 + 注册表(异步,轮询状态)
router.post('api/admin/java/deep', admin((req, res) => {
  im.deepScan();
  ok(res, { scanning: true });
}));
router.get('api/admin/java/status', admin((req, res) => {
  ok(res, {
    scanning: im.deepScanning,
    java: (im.javaCache || []).map(j => ({ path: j.path, major: j.major, label: j.label }))
  });
}));

// 实例:创建 / 导入 / 删除
router.post('api/admin/instances', admin(async (req, res) => {
  const body = await readJsonBody(req, 64 * 1024);
  const ins = im.create({ name: body.name });
  ok(res, { instance: im.overview().find(i => i.id === ins.id) });
}));

// 整合包导入:方式1 body 为 zip 原始流(?name=xx);方式2 ?name=xx&path=服务器本地路径
router.post('api/admin/instances/import', admin(async (req, res) => {
  const name = req.query.name || '';
  const localPath = req.query.path || '';
  if (!name) return fail(res, 400, '缺少实例名称(?name=)');
  // 临时文件在 finally 统一清理:导入失败/上传中断也不能留下几百 MB 的残留
  let tempFile = null;
  try {
    if (localPath) {
      // 服务器本地路径导入
      const abs = safeResolve(ROOT, localPath);
      if (!abs) return fail(res, 403, '仅允许导入面板目录内的文件');
      if (!fs.existsSync(abs)) return fail(res, 404, '文件不存在: ' + localPath);
      tempFile = path.join(TMP_DIR, uid(10) + path.extname(abs));
      fs.copyFileSync(abs, tempFile);
    } else {
      // 浏览器上传
      const ct = (req.headers['content-type'] || '').toLowerCase();
      if (!/zip|octet-stream|gzip|x-tar/.test(ct)) return fail(res, 400, '请上传 .zip / .tar.gz 整合包');
      tempFile = path.join(TMP_DIR, uid(10) + '.zip');
      const maxSize = (config.maxUploadMB || 4096) * 1024 * 1024;
      if (rejectTooLarge(req, res, maxSize)) return;
      try { await pipeToFile(req, tempFile, maxSize); }
      catch (e) { return fail(res, (e && e.status) || 400, (e && e.message) || '上传失败'); }
    }
    const ins = await im.importModpack({ name, tempFile });
    ok(res, { instance: im.overview().find(i => i.id === ins.id) });
  } catch (e) {
    fail(res, 400, (e && e.message) || '导入失败');
  } finally {
    if (tempFile) { try { fs.rmSync(tempFile, { force: true }); } catch {} }
  }
}));

router.delete('api/admin/instances/:id', admin(async (req, res) => {
  try { im.remove(req.params.id); ok(res, {}); }
  catch (e) { fail(res, 400, e.message); }
}));

// 实例控制
const CTRL = {
  start: 'start', stop: 'stop', restart: 'restart', kill: 'kill'
};
for (const [route, method] of Object.entries(CTRL)) {
  router.post(`api/admin/instances/:id/${route}`, admin(async (req, res) => {
    try {
      const r = await im[method](req.params.id);
      ok(res, { ...r, status: 'ok' });
    } catch (e) { fail(res, 400, e.message); }
  }));
}

// 实例配置
router.get('api/admin/instances/:id/config', admin(async (req, res) => {
  const ins = im.get(req.params.id);
  if (!ins) return fail(res, 404, '实例不存在');
  const { name, dir, javaPath, javaRequirement, xms, xmx, jvmArgs, serverJar, autoStart, eula, pid, startedAt } = ins;
  ok(res, {
    config: { name, dir, javaPath, javaRequirement, xms, xmx, jvmArgs, serverJar, autoStart, eula },
    runtime: { pid, startedAt, status: im.status(ins), jar: im.resolveJar(ins) }
  });
}));

router.put('api/admin/instances/:id/config', admin(async (req, res) => {
  const ins = im.get(req.params.id);
  if (!ins) return fail(res, 404, '实例不存在');
  const body = await readJsonBody(req, 64 * 1024);
  const allow = ['name', 'javaPath', 'javaRequirement', 'xms', 'xmx', 'jvmArgs', 'serverJar', 'autoStart', 'eula'];
  for (const k of allow) {
    if (k in body) {
      if (k === 'autoStart' || k === 'eula') ins[k] = !!body[k];
      else ins[k] = String(body[k] ?? '');
    }
  }
  // 备份设置
  if ('backupEnabled' in body) ins.backupEnabled = !!body.backupEnabled;
  if ('backupInterval' in body) ins.backupInterval = Math.max(1, parseInt(body.backupInterval, 10) || 60);
  if ('backupMax' in body) ins.backupMax = Math.max(1, parseInt(body.backupMax, 10) || 10);
  if ('backupPattern' in body) ins.backupPattern = String(body.backupPattern || '').slice(0, 100);
  // 实例名留空时回退为目录名
  if (!String(ins.name || '').trim()) ins.name = ins.dir;
  ins.updatedAt = now();
  im.save();
  ok(res, { config: { name: ins.name, javaPath: ins.javaPath, javaRequirement: ins.javaRequirement, xms: ins.xms, xmx: ins.xmx, jvmArgs: ins.jvmArgs, serverJar: ins.serverJar, autoStart: ins.autoStart, eula: ins.eula, backupEnabled: ins.backupEnabled, backupInterval: ins.backupInterval, backupMax: ins.backupMax, backupPattern: ins.backupPattern } });
}));

// ---------- 备份管理(管理员) ----------
const B = require('./lib/backup');
router.get('api/admin/instances/:id/backups', admin((req, res) => {
  const ins = im.get(req.params.id);
  if (!ins) return fail(res, 404, '实例不存在');
  ok(res, {
    backups: B.listBackups(im.instanceDir(ins)),
    config: { enabled: ins.backupEnabled, interval: ins.backupInterval, max: ins.backupMax, pattern: ins.backupPattern }
  });
}));
router.post('api/admin/instances/:id/backups', admin(async (req, res) => {
  let body = {};
  try { body = await readJsonBody(req, 16 * 1024); } catch {}
  try {
    const r = await im.createBackup(req.params.id, { isAuto: false, name: body.name });
    ok(res, { backup: r });
  } catch (e) { fail(res, 400, e.message); }
}));
router.delete('api/admin/instances/:id/backups/:name', admin((req, res) => {
  try {
    im.deleteBackup(req.params.id, req.params.name);
    ok(res, {});
  } catch (e) { fail(res, 400, e.message); }
}));
// 管理员下载备份(不限流)
router.get('api/admin/instances/:id/backups/:name/download', admin((req, res) => {
  const ins = im.get(req.params.id);
  if (!ins) return fail(res, 404, '实例不存在');
  try {
    const file = safeJoin(B.backupsDir(im.instanceDir(ins)), req.params.name);
    if (!file.toLowerCase().endsWith('.zip') || !fs.existsSync(file)) return fail(res, 404, '备份不存在');
    const st = fs.statSync(file);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': st.size,
      'Content-Disposition': 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(path.basename(file))
    });
    fs.createReadStream(file).pipe(res);
  } catch (e) { fail(res, 400, e.message); }
}));

// server.properties 可视化配置
router.get('api/admin/instances/:id/properties', admin((req, res) => {
  const ins = im.get(req.params.id);
  if (!ins) return fail(res, 404, '实例不存在');
  ok(res, im.readProps(ins));
}));

router.put('api/admin/instances/:id/properties', admin(async (req, res) => {
  const ins = im.get(req.params.id);
  if (!ins) return fail(res, 404, '实例不存在');
  let body;
  try { body = await readJsonBody(req, 256 * 1024); }
  catch { return fail(res, 400, '请求格式错误'); }
  const patch = body.patch || body;
  if (typeof patch !== 'object' || Array.isArray(patch)) return fail(res, 400, '参数错误');
  for (const k of Object.keys(patch)) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(k)) return fail(res, 400, '非法配置键: ' + k);
    patch[k] = String(patch[k]);
  }
  im.applyProps(ins, patch);
  ok(res, im.readProps(ins));
}));

// 日志
router.get('api/admin/instances/:id/log', admin((req, res) => {
  const ins = im.get(req.params.id);
  if (!ins) return fail(res, 404, '实例不存在');
  ok(res, { lines: im.logLines(ins.id), status: im.status(ins) });
}));

// 控制台 SSE 流
router.get('api/admin/instances/:id/stream', admin((req, res) => {
  const ins = im.get(req.params.id);
  if (!ins) return fail(res, 404, '实例不存在');
  const kill = hub.subscribe(res, ins.id);
  // 回放最近日志
  const lines = im.logLines(ins.id);
  for (const line of lines.slice(-400)) {
    try { res.write(`event: line\ndata: ${JSON.stringify({ id: ins.id, line })}\n\n`); } catch { break; }
  }
  const st = im.stats.get(ins.id);
  res.write(`event: status\ndata: ${JSON.stringify({ id: ins.id, status: im.status(ins), pid: ins.pid })}\n\n`);
  if (st) res.write(`event: stats\ndata: ${JSON.stringify({ id: ins.id, cpu: st.cpu, mem: st.mem })}\n\n`);
  req.on('close', kill);
}));

// 控制台命令
router.post('api/admin/instances/:id/command', admin(async (req, res) => {
  const body = await readJsonBody(req, 16 * 1024);
  try { im.command(req.params.id, body.cmd); ok(res, {}); }
  catch (e) { fail(res, 400, e.message); }
}));

// ---------- 文件管理 ----------
function fileRoot(req) {
  const ins = im.get(req.params.id);
  if (!ins) return null;
  return im.instanceDir(ins);
}

router.get('api/admin/instances/:id/files', admin(async (req, res) => {
  const root = fileRoot(req);
  if (!root) return fail(res, 404, '实例不存在');
  try { ok(res, await F.listDir(root, req.query.path || '')); }
  catch (e) { fail(res, 400, e.message); }
}));

router.get('api/admin/instances/:id/file', admin(async (req, res) => {
  const root = fileRoot(req);
  if (!root) return fail(res, 404, '实例不存在');
  try { ok(res, { content: await F.readFile(root, req.query.path || '', 8 * 1024 * 1024) }); }
  catch (e) { fail(res, 400, e.message); }
}));

router.put('api/admin/instances/:id/file', admin(async (req, res) => {
  const root = fileRoot(req);
  if (!root) return fail(res, 404, '实例不存在');
  const body = await readJsonBody(req, 8 * 1024 * 1024);
  try { await F.writeFile(root, req.query.path || '', body.content ?? ''); ok(res, {}); }
  catch (e) { fail(res, 400, e.message); }
}));

router.post('api/admin/instances/:id/upload', admin((req, res) => {
  const root = fileRoot(req);
  if (!root) return fail(res, 404, '实例不存在');
  const dir = req.query.path || '';
  const filename = req.query.filename || uid(8);
  const rel = (dir + '/' + filename).replace(/\/+/g, '/');
  const maxSize = (config.maxUploadMB || 4096) * 1024 * 1024;
  if (rejectTooLarge(req, res, maxSize)) return;
  F.uploadStream(root, rel, req, maxSize)
    .then(size => ok(res, { size }))
    .catch(e => fail(res, (e && e.status) || 400, e.message));
}));

router.get('api/admin/instances/:id/download', admin((req, res) => {
  const root = fileRoot(req);
  if (!root) return fail(res, 404, '实例不存在');
  try {
    const file = require('./lib/util').safeJoin(root, req.query.path || '');
    if (!fs.existsSync(file)) return fail(res, 404, '文件不存在');
    const st = fs.statSync(file);
    if (st.isDirectory()) return fail(res, 400, '不能下载目录');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': st.size,
      'Content-Disposition': 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(path.basename(file))
    });
    fs.createReadStream(file).pipe(res);
  } catch (e) { fail(res, 400, e.message); }
}));

router.post('api/admin/instances/:id/mkdir', admin(async (req, res) => {
  const root = fileRoot(req);
  if (!root) return fail(res, 404, '实例不存在');
  const body = await readJsonBody(req, 16 * 1024);
  try { await F.mkdir(root, body.path || ''); ok(res, {}); }
  catch (e) { fail(res, 400, e.message); }
}));

router.post('api/admin/instances/:id/rename', admin(async (req, res) => {
  const root = fileRoot(req);
  if (!root) return fail(res, 404, '实例不存在');
  const body = await readJsonBody(req, 16 * 1024);
  try { await F.rename(root, body.path || '', body.newName); ok(res, {}); }
  catch (e) { fail(res, 400, e.message); }
}));

router.post('api/admin/instances/:id/delete', admin(async (req, res) => {
  const root = fileRoot(req);
  if (!root) return fail(res, 404, '实例不存在');
  const body = await readJsonBody(req, 16 * 1024);
  try { await F.remove(root, body.path || ''); ok(res, {}); }
  catch (e) { fail(res, 400, e.message); }
}));

router.post('api/admin/instances/:id/extract', admin(async (req, res) => {
  const root = fileRoot(req);
  if (!root) return fail(res, 404, '实例不存在');
  const body = await readJsonBody(req, 16 * 1024);
  try { await F.extract(root, body.path || ''); ok(res, {}); }
  catch (e) { fail(res, 400, e.message); }
}));

// ---------- 系统设置 ----------
// 允许作为背景/首页图片的扩展名(防止把 users.db 等敏感文件指到公开的 /bg、/hero 路由)
const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

router.get('api/admin/settings', admin((req, res) => {
  ok(res, {
    panel: {
      host: config.panel.host, port: config.panel.port, background: config.panel.background,
      heroTitle: config.panel.heroTitle, heroSlogan: config.panel.heroSlogan, heroImage: config.panel.heroImage,
      ipList: config.panel.ipList, glassColor: config.panel.glassColor, glassOpacity: config.panel.glassOpacity
    },
    maxUploadMB: config.maxUploadMB,
    users: req.session.role === 'admin' ? auth.list() : undefined
  });
}));

// IP 池:添加 / 删除自定义 IP
function isValidIPv4(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || '').trim());
  if (!m) return false;
  return m.slice(1).every(o => parseInt(o, 10) <= 255);
}

router.post('api/admin/ips', admin(async (req, res) => {
  const body = await readJsonBody(req, 16 * 1024);
  const ip = String(body.ip || '').trim();
  if (!isValidIPv4(ip)) return fail(res, 400, 'IP 格式不正确');
  if (!config.panel.ipList.includes(ip)) {
    config.panel.ipList.push(ip);
    saveConfig(config);
  }
  ok(res, { ipList: config.panel.ipList });
}));

router.delete('api/admin/ips/:ip', admin(async (req, res) => {
  const ip = req.params.ip;
  if (!config.panel.ipList.includes(ip)) return fail(res, 404, 'IP 不在列表中');
  config.panel.ipList = config.panel.ipList.filter(x => x !== ip);
  saveConfig(config);
  ok(res, { ipList: config.panel.ipList });
}));

router.put('api/admin/settings', admin(async (req, res) => {
  const body = await readJsonBody(req, 64 * 1024);
  if ('background' in body) {
    const rel = String(body.background || '');
    const abs = safeResolve(ROOT, rel);
    if (abs && IMG_EXT.has(path.extname(abs).toLowerCase()) && fs.existsSync(abs)) {
      config.panel.background = rel; saveConfig(config);
    }
  }
  // 首页 A 标题 / C 标语
  if ('heroTitle' in body) { config.panel.heroTitle = String(body.heroTitle || '').slice(0, 60); saveConfig(config); }
  if ('heroSlogan' in body) { config.panel.heroSlogan = String(body.heroSlogan || '').slice(0, 120); saveConfig(config); }
  // 首页 B 图片(指定面板目录内路径;'' 表示跟随背景)
  if ('heroImage' in body) {
    const rel = String(body.heroImage || '');
    if (rel === '') { config.panel.heroImage = ''; saveConfig(config); }
    else {
      const abs = safeResolve(ROOT, rel);
      if (abs && IMG_EXT.has(path.extname(abs).toLowerCase()) && fs.existsSync(abs)) {
        config.panel.heroImage = rel; saveConfig(config);
      } else return fail(res, 400, '图片路径不存在');
    }
  }
  // 毛玻璃颜色 / 透明度
  if ('glassColor' in body) {
    if (!/^#[0-9a-fA-F]{6}$/.test(String(body.glassColor || ''))) return fail(res, 400, '颜色格式应为 #RRGGBB');
    config.panel.glassColor = String(body.glassColor); saveConfig(config);
  }
  if ('glassOpacity' in body) {
    const o = parseFloat(body.glassOpacity);
    if (isNaN(o) || o < 0.02 || o > 0.6) return fail(res, 400, '透明度应在 0.02 ~ 0.6 之间');
    config.panel.glassOpacity = o; saveConfig(config);
  }
  ok(res, { panel: config.panel });
}));

// 上传首页展示图片(B)
router.post('api/admin/hero-image', admin(async (req, res) => {
  const ct = (req.headers['content-type'] || '').toLowerCase();
  const ext = ct.includes('png') ? '.png' : ct.includes('webp') ? '.webp' : ct.includes('gif') ? '.gif' : '.jpg';
  const file = path.join(BG_DIR, 'hero-' + uid(8) + ext);
  const maxSize = 20 * 1024 * 1024;
  if (rejectTooLarge(req, res, maxSize)) return;
  try { await pipeToFile(req, file, maxSize); }
  catch (e) { return fail(res, (e && e.status) || 400, (e && e.message) || '上传失败'); }
  config.panel.heroImage = path.relative(ROOT, file).replace(/\\/g, '/');
  saveConfig(config);
  ok(res, { heroImage: config.panel.heroImage, url: '/hero?v=' + now() });
}));

// 上传背景图片
router.post('api/admin/background', admin(async (req, res) => {
  const ct = (req.headers['content-type'] || '').toLowerCase();
  const ext = ct.includes('png') ? '.png' : ct.includes('webp') ? '.webp' : ct.includes('gif') ? '.gif' : '.jpg';
  const file = path.join(BG_DIR, 'bg-' + uid(8) + ext);
  const maxSize = 20 * 1024 * 1024;
  if (rejectTooLarge(req, res, maxSize)) return;
  try { await pipeToFile(req, file, maxSize); }
  catch (e) { return fail(res, (e && e.status) || 400, (e && e.message) || '上传失败'); }
  config.panel.background = path.relative(ROOT, file).replace(/\\/g, '/');
  saveConfig(config);
  ok(res, { background: config.panel.background, url: '/bg?v=' + now() });
}));

// 修改密码(SQLite 存储,scrypt 哈希)
router.post('api/admin/password', admin(async (req, res) => {
  const body = await readJsonBody(req, 64 * 1024);
  if (!body.new || String(body.new).length < 6) return fail(res, 400, '新密码至少 6 位');
  try {
    auth.changePassword(req.session.name, body.old || '', String(body.new));
    ok(res, {});
  } catch (e) { fail(res, 403, e.message); }
}));

// 用户管理(仅管理员)
router.get('api/admin/users', admin.admin(async (req, res) => {
  ok(res, { users: auth.list() });
}));
router.post('api/admin/users', admin.admin(async (req, res) => {
  const body = await readJsonBody(req, 64 * 1024);
  const name = String(body.name || '').trim();
  if (!/^[A-Za-z0-9_\u4e00-\u9fa5]{2,20}$/.test(name)) return fail(res, 400, '用户名需 2-20 位(字母/数字/下划线/中文)');
  if (!body.password || String(body.password).length < 6) return fail(res, 400, '密码至少 6 位');
  try {
    auth.createUser(name, String(body.password), body.role);
    ok(res, { users: auth.list() });
  } catch (e) { fail(res, 400, e.message); }
}));
router.delete('api/admin/users/:name', admin.admin(async (req, res) => {
  const name = req.params.name;
  const user = auth.findUser(name);
  if (!user) return fail(res, 404, '用户不存在');
  if (name === req.session.name) return fail(res, 400, '不能删除当前登录用户');
  if (user.role === 'admin' && auth.list().filter(u => u.role === 'admin').length === 1) return fail(res, 400, '至少保留一个管理员');
  auth.deleteUser(name);
  ok(res, { users: auth.list() });
}));

// 重启面板(脱离式拉起新进程)
router.post('api/admin/restart', admin((req, res) => {
  ok(res, { message: '面板正在重启,请稍候刷新页面...' });
  setTimeout(() => {
    const child = spawn(process.execPath, [__filename], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    setTimeout(() => process.exit(0), 300);
  }, 300);
}));

// /admin 路径:进入后台管理(与首页共用前端,由前端路由决定视图)
const serveIndex = (req, res) => {
  const file = path.join(WEB_DIR, 'index.html');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache'
  });
  fs.createReadStream(file).pipe(res);
};
router.get('admin', serveIndex);
router.get('admin/', serveIndex);

// 静态资源(最后匹配)
router.get('*', staticServe(WEB_DIR));

// ---------- 工具 ----------
// 读取并解析 JSON 请求体;格式错误抛出带 status=400 的错误,由统一兜底返回 400 而非 500
async function readJsonBody(req, limit) {
  const raw = await readBody(req, limit);
  try { return JSON.parse(raw.toString('utf8')); }
  catch { throw Object.assign(new Error('请求格式错误'), { status: 400 }); }
}

// 上传预检:请求头声明的大小超限直接 413,不进入读流(浏览器能正常收到错误提示,
// 而不是连接被重置后只看到网络错误)
function rejectTooLarge(req, res, maxSize) {
  const len = parseInt(req.headers['content-length'] || '0', 10);
  if (len > maxSize) {
    res.setHeader('Connection', 'close');
    fail(res, 413, `文件超过大小限制(最大 ${Math.round(maxSize / 1024 / 1024)} MB)`);
    // 暂停读取让响应先送达,随后断开,避免半截上传悬挂占用连接
    req.pause();
    setTimeout(() => { try { req.destroy(); } catch {} }, 2000);
    return true;
  }
  return false;
}

function pipeToFile(req, file, maxSize) {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(file);
    let size = 0;
    let tooBig = false;
    req.on('data', c => {
      size += c.length;
      if (size > maxSize && !tooBig) {
        tooBig = true;
        ws.destroy(); req.destroy();
        // Windows 下需等写入句柄关闭才能删除半截文件
        ws.on('close', () => { try { fs.unlink(file, () => {}); } catch {} });
        reject(Object.assign(new Error('文件超过大小限制'), { status: 413 }));
      }
    });
    ws.on('error', reject);
    ws.on('finish', () => resolve(size));
    req.pipe(ws);
  });
}

// ---------- HTTP 服务器 ----------
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('X-Powered-By', 'MCSLite');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
  router.handle(req, res);
});

server.on('clientError', (err, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {} });

// auth 中间件先跑:在路由分发前解析会话
const origHandle = router.handle.bind(router);
router.handle = (req, res) => {
  auth.middleware()(req, res, () => origHandle(req, res));
};

// 监听端口(带 EADDRINUSE 重试,解决面板自重启时端口未及时释放)
function listenWithRetry(attempt = 0) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && attempt < 20) {
      console.log(`[面板] 端口 ${config.panel.port} 被占用,500ms 后重试 (${attempt + 1}/20)...`);
      setTimeout(() => listenWithRetry(attempt + 1), 500);
    } else {
      console.error('[面板] 启动失败: ' + (e.message || e));
      process.exit(1);
    }
  });
  server.listen(config.panel.port, config.panel.host, () => {
    console.log(`========================================`);
    console.log(`  MCSLite v${VERSION} Minecraft 服务器管理面板`);
    console.log(`  本机访问:  http://127.0.0.1:${config.panel.port}`);
    console.log(`  局域网访问: http://${getLanIPs()[0] || '?'}:${config.panel.port}`);
    console.log(`  默认账号:  admin / admin123 (首次登录请修改密码!)`);
    console.log(`========================================`);
    // 预热 Java 检测
    im.ensureJava().then(() => {
      console.log(`  Java 检测完成,共发现 ${(im.javaCache || []).length} 个 Java 运行时`);
      im.startAuto();
    });
    for (const ins of im.instances) {
      if (im.isRunning(ins)) im.probeOnce(ins);
    }
  });
}
listenWithRetry();

// 优雅退出
let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[面板] 收到 ${sig},正在退出...`);
  (async () => {
    // 退出前落盘所有配置,确保不丢
    try { im.save(); saveConfig(config); } catch {}
    // 停止所有运行中的实例(面板自重启走 /api/admin/restart 的 detached 拉起,不经过这里;
    // 重启后新进程会按 pid 收养仍在运行的服务端)
    const running = im.instances.filter(i => im.isRunning(i));
    for (const ins of running) {
      console.log(`[面板] 停止实例 ${ins.name}`);
      try { await im.stop(ins.id); } catch {}
    }
    try { server.close(); } catch {}
    setTimeout(() => process.exit(0), 500);
  })();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => { try { console.error('[面板] 未捕获异常:', e && e.stack || e); } catch {} });
process.on('unhandledRejection', (e) => { try { console.error('[面板] 未处理拒绝:', e && e.stack || e); } catch {} });
