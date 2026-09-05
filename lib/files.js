'use strict';
// 文件管理:列目录 / 读 / 写 / 上传 / 下载 / 重命名 / 删除 / 解压
// 所有操作都被限制在实例目录内,防止路径穿越
const fs = require('fs');
const path = require('path');
const { safeJoin, runCmd, fail } = require('./util');

const BANNED_NAMES = ['.', '..', '.git', '.DS_Store'];

function listDir(root, rel) {
  const dir = safeJoin(root, rel);
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { throw new Error('无法读取目录: ' + (e.message || e)); }
  const out = [];
  for (const e of entries) {
    if (BANNED_NAMES.includes(e.name)) continue;
    let size = 0, mtime = 0;
    try {
      const st = fs.statSync(path.join(dir, e.name));
      size = st.size; mtime = st.mtimeMs;
    } catch {}
    out.push({ name: e.name, dir: e.isDirectory(), size, mtime });
  }
  out.sort((a, b) => (a.dir === b.dir) ? a.name.localeCompare(b.name) : (a.dir ? -1 : 1));
  return { path: normalizeRel(rel), entries: out };
}

function normalizeRel(rel) {
  const p = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  return p ? '/' + p : '/';
}

function readFile(root, rel, maxSize = 8 * 1024 * 1024) {
  const file = safeJoin(root, rel);
  const st = fs.statSync(file);
  if (st.isDirectory()) throw new Error('这是目录');
  if (st.size > maxSize) throw new Error('文件过大,请下载后编辑');
  return fs.readFileSync(file, 'utf8');
}

function writeFile(root, rel, content) {
  const file = safeJoin(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return true;
}

function uploadStream(root, rel, stream, maxSize) {
  return new Promise((resolve, reject) => {
    const file = safeJoin(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const ws = fs.createWriteStream(file);
    let size = 0;
    let tooBig = false;
    stream.on('data', c => {
      size += c.length;
      if (maxSize && size > maxSize) { tooBig = true; ws.destroy(); stream.destroy(); reject(new Error('文件超过大小限制')); }
    });
    ws.on('error', reject);
    ws.on('finish', () => resolve(size));
    stream.pipe(ws);
  });
}

function mkdir(root, rel) {
  const dir = safeJoin(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  return true;
}

function rename(root, rel, newName) {
  if (!newName || newName.includes('/') || newName.includes('\\') || BANNED_NAMES.includes(newName)) {
    throw new Error('非法名称');
  }
  const from = safeJoin(root, rel);
  const to = safeJoin(root, path.join(path.dirname(rel), newName));
  if (from === to) return true;
  fs.renameSync(from, to);
  return true;
}

function remove(root, rel) {
  const target = safeJoin(root, rel);
  if (!fs.existsSync(target)) throw new Error('路径不存在');
  const st = fs.statSync(target);
  if (st.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
  else fs.unlinkSync(target);
  return true;
}

// 解压 zip / tar.gz 到同目录(支持 zip、tar、tar.gz)
async function extract(root, rel) {
  const file = safeJoin(root, rel);
  if (!fs.existsSync(file)) throw new Error('文件不存在: ' + rel);
  const ext = path.extname(file).toLowerCase();
  const dir = path.dirname(file);
  const isTar = ext === '.gz' || ext === '.tgz' || file.endsWith('.tar.gz');
  const isZip = ext === '.zip';
  if (!isTar && !isZip) throw new Error('仅支持 .zip / .tar.gz / .tgz');
  if (process.platform === 'win32') {
    if (isZip) {
      // 优先 bsdtar(Windows 10+ 自带),回退 PowerShell
      const r = await runCmd('tar', ['-xf', file, '-C', dir], { timeout: 300000 });
      if (r.code === 0) return true;
      const r2 = await runCmd('powershell', ['-NoProfile', '-Command',
        `Expand-Archive -LiteralPath '${file.replace(/'/g, "''")}' -DestinationPath '${dir.replace(/'/g, "''")}' -Force`],
        { timeout: 300000 });
      if (r2.code !== 0) throw new Error('解压失败: ' + (r2.stderr || r2.stdout || '未知错误').slice(0, 500));
      return true;
    }
    // tar.gz
    const r = await runCmd('tar', ['-xzf', file, '-C', dir], { timeout: 300000 });
    if (r.code !== 0) throw new Error('解压失败: ' + (r.stderr || r.stdout || '').slice(0, 500));
    return true;
  }
  // Linux:zip 用 unzip,tar.gz 用 tar
  if (isZip) {
    const r = await runCmd('unzip', ['-o', '-q', file, '-d', dir], { timeout: 600000 });
    if (r.code !== 0) throw new Error('解压失败: ' + (r.stderr || r.stdout || '').slice(0, 500));
    return true;
  }
  const r = await runCmd('tar', ['-xzf', file, '-C', dir], { timeout: 600000 });
  if (r.code !== 0) throw new Error('解压失败: ' + (r.stderr || r.stdout || '').slice(0, 500));
  return true;
}

// 查找服务端 jar:仅根目录(+ Paper 的 versions/ 目录),排除 plugins/mods/cache 等子目录
function findServerJars(root) {
  const jars = [];
  const EXCLUDE = new Set(['plugins', 'mods', 'libraries', 'cache', 'config', 'world', 'logs', 'backups',
    'crash-reports', 'stats', 'advancements', 'datapacks', 'versions_backup', 'plugins-update',
    '.git', '.idea', '.vscode', 'node_modules', 'update', 'reports']);
  const scan = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (EXCLUDE.has(e.name.toLowerCase())) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        // 根目录仅深入 versions/(Paper 服务端目录);versions 内任意子目录继续(最多两层)
        if (depth === 0 ? e.name.toLowerCase() === 'versions' : depth <= 2) scan(p, depth + 1);
      } else if (e.name.toLowerCase().endsWith('.jar')) {
        const rel = path.relative(root, p).replace(/\\/g, '/');
        const score = /(server|paper|spigot|fabric-server-launch|forge|mohist|purpur|bungeecord|velocity|vanilla|leaves|folia|pufferfish|cat[-_]?server|minecraft_server|patina)/i.test(e.name) ? 1 : 0;
        jars.push({ path: rel, name: e.name, score });
      }
    }
  };
  scan(root, 0);
  jars.sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name));
  return jars;
}

// 异步计算目录总大小(并发受限,不阻塞事件循环)
async function dirSize(dir, concurrency = 8) {
  const fsp = fs.promises;
  const queue = [dir];
  const seen = new Set();
  let total = 0;
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const d = queue[next++];
      if (seen.has(d)) continue;
      seen.add(d);
      let entries;
      try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { queue.push(p); continue; }
        try { const st = await fsp.stat(p); if (st.isFile()) total += st.size; } catch {}
      }
    }
  };
  const n = Math.max(1, Math.min(concurrency, 8));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return total;
}

module.exports = { listDir, readFile, writeFile, uploadStream, mkdir, rename, remove, extract, findServerJars, normalizeRel, dirSize };
