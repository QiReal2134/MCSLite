'use strict';
// 文件管理:列目录 / 读 / 写 / 上传 / 下载 / 重命名 / 删除 / 解压
// 所有操作都被限制在实例目录内,防止路径穿越
// 常规操作使用 fs.promises 异步实现,避免大目录/大文件阻塞事件循环
const fs = require('fs');
const path = require('path');
const fsp = fs.promises;
const { safeJoin, runCmd } = require('./util');

const BANNED_NAMES = ['.', '..', '.git', '.DS_Store'];

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico', '.bmp']);

async function listDir(root, rel) {
  const dir = safeJoin(root, rel);
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch (e) { throw new Error('无法读取目录: ' + (e.message || e)); }
  const out = [];
  for (const e of entries) {
    if (BANNED_NAMES.includes(e.name)) continue;
    let size = 0, mtime = 0;
    try {
      const st = await fsp.stat(path.join(dir, e.name));
      size = st.size; mtime = st.mtimeMs;
    } catch {}
    out.push({
      name: e.name,
      dir: e.isDirectory(),
      size, mtime,
      img: !e.isDirectory() && IMAGE_EXT.has(path.extname(e.name).toLowerCase())
    });
  }
  out.sort((a, b) => (a.dir === b.dir) ? a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) : (a.dir ? -1 : 1));
  return { path: normalizeRel(rel), entries: out };
}

function normalizeRel(rel) {
  const p = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  return p ? '/' + p : '/';
}

async function readFile(root, rel, maxSize = 8 * 1024 * 1024) {
  const file = safeJoin(root, rel);
  const st = await fsp.stat(file);
  if (st.isDirectory()) throw new Error('这是目录');
  if (st.size > maxSize) throw new Error('文件过大,请下载后编辑');
  return fsp.readFile(file, 'utf8');
}

async function writeFile(root, rel, content) {
  const file = safeJoin(root, rel);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  // 先写临时文件再原子替换,避免写一半的文件被服务端读取;失败时清理临时文件
  const tmp = file + '.mcs-tmp';
  try {
    await fsp.writeFile(tmp, content);
    await fsp.rename(tmp, file);
  } catch (e) {
    try { await fsp.unlink(tmp); } catch {}
    throw e;
  }
  return true;
}

function uploadStream(root, rel, stream, maxSize) {
  return new Promise((resolve, reject) => {
    let file;
    try { file = safeJoin(root, rel); }
    catch (e) { reject(e); return; }
    fsp.mkdir(path.dirname(file), { recursive: true }).then(() => {
      const ws = fs.createWriteStream(file);
      let size = 0;
      let tooBig = false;
      stream.on('data', c => {
        size += c.length;
        if (maxSize && size > maxSize && !tooBig) {
          tooBig = true;
          ws.destroy(); stream.destroy();
          // Windows 下需等写入句柄关闭才能删除半截文件
          ws.on('close', () => { fsp.unlink(file).catch(() => {}); });
          reject(Object.assign(new Error('文件超过大小限制'), { status: 413 }));
        }
      });
      ws.on('error', reject);
      ws.on('finish', () => resolve(size));
      stream.pipe(ws);
    }).catch(reject);
  });
}

async function mkdir(root, rel) {
  const dir = safeJoin(root, rel);
  await fsp.mkdir(dir, { recursive: true });
  return true;
}

async function rename(root, rel, newName) {
  if (!newName || newName.includes('/') || newName.includes('\\') || BANNED_NAMES.includes(newName)) {
    throw new Error('非法名称');
  }
  const from = safeJoin(root, rel);
  const to = safeJoin(root, path.join(path.dirname(rel), newName));
  if (from === to) return true;
  try { await fsp.rename(from, to); }
  catch (e) {
    // rename 失败(如 Windows 下文件被占用)时,单文件回退为复制+删除
    const st = await fsp.stat(from).catch(() => null);
    if (st && st.isFile()) { await fsp.copyFile(from, to); await fsp.unlink(from); }
    else throw e;
  }
  return true;
}

async function remove(root, rel) {
  const target = safeJoin(root, rel);
  let st;
  try { st = await fsp.stat(target); }
  catch { throw new Error('路径不存在'); }
  if (st.isDirectory()) await fsp.rm(target, { recursive: true, force: true });
  else await fsp.unlink(target);
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
// 同步实现:调用方(instances.js)多处同步使用,且扫描范围有严格深度限制
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
