'use strict';
// Java 自动检测:扫描常见安装目录 + 环境变量,解析版本号
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runCmd } = require('./util');

// 解析 java -version 输出 -> 主版本号
// 现代格式: openjdk version "21.0.1"  旧格式: java version "1.8.0_381"
function parseJavaVersion(text) {
  const m = /version\s+"([^"]+)"/.exec(text);
  if (!m) return null;
  const v = m[1];
  if (v.startsWith('1.')) {
    const mm = /^1\.(\d+)/.exec(v);
    return mm ? parseInt(mm[1], 10) : null;
  }
  const mm = /^(\d+)/.exec(v);
  return mm ? parseInt(mm[1], 10) : null;
}

// 探测单个 java 可执行文件
async function probe(javaPath, cached) {
  if (cached && cached[javaPath]) return cached[javaPath];
  const r = await runCmd(javaPath, ['-version'], { timeout: 12000 });
  const major = parseJavaVersion(r.stdout || r.stderr);
  const info = { path: javaPath, major, raw: (r.stdout || r.stderr).split('\n')[0] || '' };
  if (major) info.label = `Java ${major} · ${path.basename(path.dirname(javaPath)) || javaPath}`;
  else info.label = javaPath;
  if (cached) cached[javaPath] = info;
  return info;
}

async function findInPath() {
  const which = process.platform === 'win32' ? 'where' : 'which';
  const r = await runCmd(which, ['java'], { timeout: 8000 });
  return r.code === 0 ? r.stdout.split(/\r?\n/).map(s => s.trim()).filter(s => s && s.toLowerCase().endsWith('.exe') === (process.platform === 'win32') || (process.platform !== 'win32' && s)) : [];
}

// Windows 注册表扫描:JavaSoft 安装器会写入 JavaHome(权威来源,32/64 位 + 用户级)
async function scanRegistry() {
  const out = new Set();
  if (process.platform !== 'win32') return out;
  const roots = [
    'HKLM\\SOFTWARE\\JavaSoft',
    'HKLM\\SOFTWARE\\WOW6432Node\\JavaSoft',
    'HKCU\\SOFTWARE\\JavaSoft',
    'HKCU\\SOFTWARE\\WOW6432Node\\JavaSoft'
  ];
  for (const root of roots) {
    try {
      const r = await runCmd('reg', ['query', root, '/s'], { timeout: 15000 });
      const re = /JavaHome\s+REG_\w+\s+(.+)$/i;
      for (const line of r.stdout.split(/\r?\n/)) {
        const m = re.exec(line.trim());
        if (m) {
          const home = m[1].trim();
          const exe = path.join(home, 'bin', 'java.exe');
          if (fs.existsSync(exe)) out.add(path.resolve(exe));
          // 某些结构: jre/bin/java
          const jre = path.join(home, 'jre', 'bin', 'java.exe');
          if (fs.existsSync(jre)) out.add(path.resolve(jre));
        }
      }
    } catch {}
  }
  return out;
}

// 递归深扫:在常见安装根目录下按深度限制查找 java.exe(不进入巨大无关目录)
async function deepScanDirs() {
  const out = new Set();
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  const roots = [];
  if (process.platform === 'win32') {
    roots.push('C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData');
    if (process.env.LOCALAPPDATA) {
      roots.push(
        path.join(process.env.LOCALAPPDATA, 'Programs'),
        path.join(process.env.LOCALAPPDATA, 'scoop', 'apps'),                 // scoop
        path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages') // winget
      );
    }
    if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, '.minecraft', 'runtime'));
    if (process.env.USERPROFILE) roots.push(process.env.USERPROFILE); // 用户目录顶层(如 C:\Users\X\Java)
  } else {
    roots.push('/usr/lib/jvm', '/usr/java', '/opt/java', '/opt/jdk', '/opt', '/Library/Java/JavaVirtualMachines');
  }
  const SKIP = new Set(['node_modules', '.git', 'AppData', '.minecraft', 'Windows', 'windows', 'Common Files', 'Microsoft.NET', 'Android', 'Unity', 'Epic Games', 'Steam', 'nodejs', 'Oracle', 'VirtualBox', 'Docker', 'ProgramData', '$RECYCLE.BIN', 'System Volume Information', 'Intel', 'NVIDIA Corporation', 'Google', 'Mozilla Firefox', 'Microsoft Edge', 'WindowsApps', 'OneDrive', 'Pictures', 'Videos', 'Music', 'Downloads', 'Documents', 'Desktop', '3D Objects', 'Contacts', 'Favorites', 'Links', 'Saved Games', 'Searches']);
  const walk = async (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (SKIP.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 6) await walk(p, depth + 1);
      } else if (e.name.toLowerCase() === exe && path.basename(dir).toLowerCase() === 'bin') {
        out.add(path.resolve(p));
      }
    }
  };
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    await walk(root, 0);
  }
  return out;
}

// 全量深度扫描(带缓存)
async function detectJava() {
  const cached = {};
  const found = [];
  const paths = new Set();

  // 1. PATH
  try {
    for (const p of await findInPath()) paths.add(p);
  } catch {}

  // 2. 注册表(Windows 权威来源)
  try {
    for (const p of await scanRegistry()) paths.add(p);
  } catch {}

  // 3. 递归深扫常见目录
  try {
    for (const p of await deepScanDirs()) paths.add(p);
  } catch {}

  // 4. 环境变量兜底
  for (const env of ['JAVA_HOME', 'JDK_HOME']) {
    if (process.env[env]) {
      const j = path.join(process.env[env], 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
      if (fs.existsSync(j)) paths.add(path.resolve(j));
    }
  }

  for (const p of paths) {
    try { const info = await probe(p, cached); if (info.major) found.push(info); } catch {}
  }

  // 去重 + 排序:主版本降序,同版本按路径
  const seen = new Set();
  const uniq = found.filter(f => {
    const k = f.path.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  uniq.sort((a, b) => (b.major - a.major) || a.path.localeCompare(b.path));
  return uniq;
}

// 按实例要求自动挑选 Java
// requirement: 'auto' | 8 | 16 | 17 | 21 | 'latest'
function pickJava(list, requirement) {
  if (!list || list.length === 0) return null;
  if (requirement === 'latest' || requirement === 'auto') {
    return list[0]; // 已按版本降序
  }
  const target = Number(requirement);
  // 首选精确匹配,否则选不低于目标的最低版本,否则最新
  const exact = list.find(j => j.major === target);
  if (exact) return exact;
  const higher = list.filter(j => j.major > target).sort((a, b) => a.major - b.major)[0];
  if (higher) return higher;
  return list[0];
}

// 全盘深度遍历:枚举所有本地固定盘,递归查找 java.exe(跳过符号链接防循环)
async function deepScanAllDrives() {
  const out = new Set();
  if (process.platform !== 'win32') {
    for (const p of await deepScanDirs()) out.add(p);
    return out;
  }
  // 枚举盘符
  const drives = [];
  for (let c = 65; c <= 90; c++) {
    const d = String.fromCharCode(c) + ':\\';
    try {
      const st = fs.statSync(d);
      if (st.isDirectory()) drives.push(d);
    } catch {}
  }
  const exe = 'java.exe';
  const SKIP = new Set(['Windows', 'windows', 'node_modules', '.git', '.cache', '.gradle', '.m2', 'AppData', '.minecraft', 'ProgramData', '$Recycle.Bin', '$RECYCLE.BIN', 'System Volume Information', 'Recovery', 'MSOCache', 'Intel', 'NVIDIA Corporation', 'AMD', 'OneDrive', 'Program Files\\Common Files', 'Common Files', 'WindowsApps', 'Microsoft Edge', 'Mozilla Firefox', 'Google', 'Steam', 'Epic Games', 'nodejs', 'VirtualBox', 'Docker', 'Unity', 'Android', 'Pictures', 'Videos', 'Music', 'Downloads', 'Documents', 'Desktop', 'Contacts', 'Favorites', 'Links', 'Saved Games', 'Searches', '3D Objects']);
  const walk = async (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isSymbolicLink()) continue; // 防循环
      if (SKIP.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 8) await walk(p, depth + 1);
      } else if (e.name.toLowerCase() === exe && path.basename(dir).toLowerCase() === 'bin') {
        out.add(path.resolve(p));
      }
    }
  };
  for (const d of drives) await walk(d, 0);
  return out;
}

// 深度查找:注册表 + 全盘遍历 + PATH + 环境变量(比常规扫描更彻底)
async function detectJavaDeep() {
  const cached = {};
  const found = [];
  const paths = new Set();
  try { for (const p of await findInPath()) paths.add(p); } catch {}
  try { for (const p of await scanRegistry()) paths.add(p); } catch {}
  try { for (const p of await deepScanAllDrives()) paths.add(p); } catch {}
  for (const env of ['JAVA_HOME', 'JDK_HOME']) {
    if (process.env[env]) {
      const j = path.join(process.env[env], 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
      if (fs.existsSync(j)) paths.add(path.resolve(j));
    }
  }
  for (const p of paths) {
    try { const info = await probe(p, cached); if (info.major) found.push(info); } catch {}
  }
  const seen = new Set();
  const uniq = found.filter(f => {
    const k = f.path.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  uniq.sort((a, b) => (b.major - a.major) || a.path.localeCompare(b.path));
  return uniq;
}

// Minecraft 版本 → 所需 Java 主版本(1.26+ 需要 Java 25)
function requiredJavaForMc(ver) {
  const parts = String(ver || '').split('.').map(n => parseInt(n, 10) || 0);
  const [ma, mi = 0, pa = 0] = parts;
  if (ma === 1) {
    if (mi >= 26) return 25;                      // 1.26+ → Java 25
    if (mi >= 21) return 21;                      // 1.21 - 1.25 → Java 21
    if (mi === 20) return pa >= 5 ? 21 : 17;      // 1.20.5+ → 21;1.20-1.20.4 → 17
    if (mi === 18 || mi === 19) return 17;        // 1.18 - 1.19 → 17
    if (mi === 17) return 16;                     // 1.17 → 16
    return 8;                                      // ≤ 1.16 → 8
  }
  if (ma >= 26) return 25;                        // 年份版本(26.x)
  if (ma >= 2) return 25;                         // 未来大版本
  return null;
}

module.exports = { detectJava, detectJavaDeep, pickJava, requiredJavaForMc, parseJavaVersion, probe };
