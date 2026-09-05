'use strict';
// 备份:定时/手动备份世界(仅地图),zip 存储于实例目录 backups/ 文件夹
const fs = require('fs');
const path = require('path');
const { runCmd } = require('./util');

const BACKUP_DIR = 'backups';
const MANUAL_PREFIX = 'manual-';

// 名称模式替换: {y} 年 {m} 月 {d} 日 {h} 时 {min} 分
function renderPattern(pattern, date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const map = {
    '{y}': String(date.getFullYear()),
    '{m}': p(date.getMonth() + 1),
    '{d}': p(date.getDate()),
    '{h}': p(date.getHours()),
    '{min}': p(date.getMinutes())
  };
  return String(pattern || 'auto-{y}{m}{d}-{h}{min}').replace(/\{(y|m|d|h|min)\}/g, (k) => map[k]);
}

function backupsDir(instanceDir) {
  return path.join(instanceDir, BACKUP_DIR);
}

// 列出备份(时间升序)
function listBackups(instanceDir) {
  const dir = backupsDir(instanceDir);
  const out = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.toLowerCase().endsWith('.zip')) continue;
      try {
        const st = fs.statSync(path.join(dir, e.name));
        out.push({ name: e.name, size: st.size, mtime: st.mtimeMs });
      } catch {}
    }
  } catch {}
  out.sort((a, b) => a.mtime - b.mtime);
  return out;
}

// 世界文件夹列表(level-name + _nether/_the_end)
function worldFolders(instanceDir, levelName) {
  const name = String(levelName || 'world').replace(/[/\\]/g, '');
  const candidates = [name];
  for (const s of ['_nether', '_the_end']) {
    if (fs.existsSync(path.join(instanceDir, name + s))) candidates.push(name + s);
  }
  return candidates.filter(d => fs.existsSync(path.join(instanceDir, d)));
}

// 压缩世界文件夹到 zip(零依赖,bsdtar;回退 PowerShell)
async function zipWorlds(instanceDir, folders, zipFile) {
  if (folders.length === 0) throw new Error('未找到世界文件夹');
  fs.mkdirSync(path.dirname(zipFile), { recursive: true });
  if (process.platform === 'win32') {
    const args = ['-a', '-cf', zipFile, '-C', instanceDir, ...folders];
    const r = await runCmd('tar', args, { timeout: 600000 });
    if (r.code !== 0) {
      const paths = folders.map(f => `'${path.join(instanceDir, f).replace(/'/g, "''")}'`).join(',');
      const r2 = await runCmd('powershell', ['-NoProfile', '-Command',
        `Compress-Archive -Path ${paths} -DestinationPath '${zipFile.replace(/'/g, "''")}' -Force`], { timeout: 600000 });
      if (r2.code !== 0) throw new Error('备份失败: ' + (r2.stderr || r2.stdout || '未知错误').slice(0, 300));
    }
    return zipFile;
  }
  // Linux/macOS:GNU tar 不支持 zip 格式(-a 会产出名为 .zip 的 tar),须用 zip 命令
  const r = await runCmd('zip', ['-r', '-q', zipFile, ...folders], { timeout: 600000, cwd: instanceDir });
  if (r.code !== 0) {
    throw new Error('备份失败: ' + (r.stderr || r.stdout || '未知错误').slice(0, 300) +
      (r.code === -1 || /not found|No such file/i.test(r.stderr || '') ? '(未找到 zip 命令,请先安装: apt install zip / yum install zip)' : ''));
  }
  return zipFile;
}

// 安全备份名(仅文件名,不含路径)
function safeBackupName(name) {
  return String(name || 'backup').replace(/[\\/:*?"<>|\r\n]/g, '_').trim().slice(0, 80) || 'backup';
}

module.exports = { BACKUP_DIR, MANUAL_PREFIX, renderPattern, backupsDir, listBackups, worldFolders, zipWorlds, safeBackupName };
