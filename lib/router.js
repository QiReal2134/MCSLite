'use strict';
// 极简 HTTP 路由器 + 静态文件服务(零依赖)
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { json, fail, safeResolve } = require('./util');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.log': 'text/plain; charset=utf-8', '.properties': 'text/plain; charset=utf-8',
  '.toml': 'text/plain; charset=utf-8', '.yml': 'text/plain; charset=utf-8',
  '.zip': 'application/zip', '.gz': 'application/gzip', '.jar': 'application/java-archive',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4'
};

function createRouter() {
  const routes = []; // {method, pattern, handler}
  const server = {
    // 注册路由,支持 :param 与 * 通配
    add(method, pattern, handler) {
      const parts = pattern.split('/').filter(Boolean);
      routes.push({ method, parts, handler });
      return server;
    },
    get(p, h) { return server.add('GET', p, h); },
    post(p, h) { return server.add('POST', p, h); },
    put(p, h) { return server.add('PUT', p, h); },
    delete(p, h) { return server.add('DELETE', p, h); },
    handle(req, res) {
      const u = new URL(req.url, 'http://x');
      const segs = u.pathname.split('/').filter(Boolean);
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const params = matchRoute(r.parts, segs);
        if (!params) continue;
        req.params = params;
        req.query = Object.fromEntries(u.searchParams);
        return r.handler(req, res);
      }
      fail(res, 404, '接口不存在: ' + req.method + ' ' + u.pathname);
    }
  };
  return server;
}

// 路由段解码:畸形百分号编码返回 null(按不匹配处理),避免 URIError 打挂请求
function decodeSeg(s) {
  try { return decodeURIComponent(s); } catch { return null; }
}

// 路由段匹配:支持 :param 与尾通配 * ('*' 匹配零个或多个剩余段)
function matchRoute(parts, segs) {
  const params = {};
  const w = parts.indexOf('*');
  if (w === -1) {
    if (parts.length !== segs.length) return null;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.startsWith(':')) {
        const v = decodeSeg(segs[i]);
        if (v === null) return null;
        params[p.slice(1)] = v;
      }
      else if (p !== segs[i]) return null;
    }
    return params;
  }
  if (segs.length < w) return null;
  for (let i = 0; i < w; i++) {
    const p = parts[i];
    if (p.startsWith(':')) {
      const v = decodeSeg(segs[i]);
      if (v === null) return null;
      params[p.slice(1)] = v;
    }
    else if (p !== segs[i]) return null;
  }
  return params;
}

// 静态文件服务,root 之外一律 403
function staticServe(root) {
  return (req, res) => {
    const { URL } = require('url');
    const u = new URL(req.url, 'http://x');
    let p;
    try { p = decodeURIComponent(u.pathname); }
    catch { fail(res, 400, '非法路径'); return; }
    if (p === '/') p = '/index.html';
    // 边界按目录分隔符判断,防止兄弟目录前缀(如 webbak)绕过
    const file = safeResolve(root, '.' + p);
    if (!file) { fail(res, 403, '禁止访问'); return; }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { fail(res, 404, '文件不存在'); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': st.size,
        // index/app/style 不缓存,保证前端更新即时生效;其余静态资源可缓存
        'Cache-Control': (p === '/index.html' || p === '/app.js' || p === '/style.css') ? 'no-cache' : 'public, max-age=3600'
      });
      fs.createReadStream(file).pipe(res);
    });
  };
}

module.exports = { createRouter, staticServe, MIME };
