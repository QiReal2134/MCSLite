'use strict';
// 通用工具:零依赖
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function now() { return Date.now(); }

function uid(len = 8) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);
}

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

function formatBytes(n) {
  if (!n || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
}

function formatUptime(ms) {
  if (!ms || ms <= 0) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}天${h}小时`;
  if (h > 0) return `${h}小时${m}分`;
  if (m > 0) return `${m}分${s % 60}秒`;
  return `${s}秒`;
}

// 解析 rel 并确保位于 base 之内;越界返回 null(边界按目录分隔符判断,防前缀绕过)
function safeResolve(base, rel) {
  const b = path.resolve(base);
  const p = path.resolve(b, String(rel ?? ''));
  if (p !== b && !p.startsWith(b + path.sep)) return null;
  return p;
}

// 保证 target 位于 root 之内,防止路径穿越
function safeJoin(root, rel) {
  const p = safeResolve(root, String(rel || '').replace(/^[/\\]+/, ''));
  if (!p) throw new Error('非法路径');
  return p;
}

// 同 safeJoin,但额外拒绝指向 root 自身:删除/改名等破坏性操作必须先经此校验,
// 否则 rel 为 '' 或 '.' 时会把整个实例目录当成目标
function safeJoinChild(root, rel) {
  const b = path.resolve(root);
  const p = safeJoin(root, rel);
  if (p === b) throw new Error('不能对实例根目录执行该操作');
  return p;
}

// 读取 JSON 文件,不存在/损坏返回默认值
function readJson(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return def; }
}

function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// 运行命令并捕获输出(不使用 shell,args 数组)
function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    let out = '', err = '';
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, ...opts });
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: String(e && e.message || e) });
    }
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, opts.timeout || 15000);
    child.stdout.on('data', d => { out += d; if (out.length > 200000) out = out.slice(-200000); });
    child.stderr.on('data', d => { err += d; if (err.length > 200000) err = err.slice(-200000); });
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, stdout: out, stderr: err || String(e.message || e) }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); });
  });
}

// 简单异步 JSON body(限制大小)
function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer'
  });
  res.end(body);
}

function fail(res, code, msg) { json(res, code, { ok: false, error: msg }); }

function ok(res, obj) { json(res, 200, { ok: true, ...obj }); }

module.exports = {
  sleep, now, uid, sha256, formatBytes, formatUptime,
  safeResolve, safeJoin, safeJoinChild, readJson, writeJson, runCmd, readBody, json, fail, ok
};
