'use strict';
// 认证:账号密码存 SQLite(本地 users.db),scrypt 哈希 + 随机盐,安全性极高(零依赖)
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { fail, sha256 } = require('./util');

const SESSION_TTL = 7 * 24 * 3600 * 1000; // 7 天
// scrypt 强度参数(新密码使用;旧数据按各自存储的参数校验)
const SCRYPT_DEFAULT = { N: 16384, r: 8, p: 1 };

class Auth {
  constructor(dataDir) {
    this.dbFile = path.join(dataDir, 'users.db');
    this.loginAttempts = new Map();
    this.open();
    this.migrateFromJson(dataDir);
    this.ensureAdmin();
  }

  open() {
    this.db = new DatabaseSync(this.dbFile);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'admin',
      salt TEXT NOT NULL,
      hash TEXT NOT NULL,
      must_change INTEGER NOT NULL DEFAULT 0,
      scrypt_n INTEGER NOT NULL DEFAULT 16384,
      scrypt_r INTEGER NOT NULL DEFAULT 8,
      scrypt_p INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    )`);
    // 会话表:只存 token 的 sha256,库文件泄漏也无法直接拿去冒充登录。
    // 必须在 prepare 之前建好,否则 prepare 会直接报 no such table
    this.db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      exp INTEGER NOT NULL
    )`);
    this.stmt = {
      find: this.db.prepare('SELECT * FROM users WHERE name = ?'),
      all: this.db.prepare('SELECT id, name, role, must_change, created_at FROM users ORDER BY id'),
      insert: this.db.prepare('INSERT INTO users (name, role, salt, hash, must_change, scrypt_n, scrypt_r, scrypt_p, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      update: this.db.prepare('UPDATE users SET role = ?, salt = ?, hash = ?, must_change = ?, scrypt_n = ?, scrypt_r = ?, scrypt_p = ? WHERE name = ?'),
      remove: this.db.prepare('DELETE FROM users WHERE name = ?'),
      count: this.db.prepare('SELECT COUNT(*) AS c FROM users'),
      // 会话落盘:面板重启(含「重启面板」按钮)不再把所有人踢下线
      sessPut: this.db.prepare('INSERT OR REPLACE INTO sessions (token_hash, name, role, exp) VALUES (?, ?, ?, ?)'),
      sessGet: this.db.prepare('SELECT * FROM sessions WHERE token_hash = ?'),
      sessDel: this.db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
      sessDropExpired: this.db.prepare('DELETE FROM sessions WHERE exp < ?')
    };
    this.loadSessions();
  }

  // 启动时清掉已过期的会话行
  loadSessions() {
    try { this.stmt.sessDropExpired.run(Date.now()); } catch {}
  }

  close() { try { this.db.close(); } catch {} }

  // 迁移旧 users.json(保留原 salt/hash,密码无需重置)
  migrateFromJson(dataDir) {
    const jsonFile = path.join(dataDir, 'users.json');
    if (!fs.existsSync(jsonFile)) return;
    try {
      const users = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
      if (Array.isArray(users)) {
        const ins = this.db.prepare('INSERT OR IGNORE INTO users (name, role, salt, hash, must_change, scrypt_n, scrypt_r, scrypt_p, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
        for (const u of users) {
          if (!u || !u.name || !u.salt || !u.hash) continue;
          ins.run(u.name, u.role === 'operator' ? 'operator' : 'admin', u.salt, u.hash, u.mustChange ? 1 : 0, SCRYPT_DEFAULT.N, SCRYPT_DEFAULT.r, SCRYPT_DEFAULT.p, Date.now());
        }
      }
      // 迁移后改名备份,避免重复导入
      fs.renameSync(jsonFile, jsonFile + '.bak');
      console.log('[auth] 已从 users.json 迁移账号到 SQLite (users.db)');
    } catch (e) {
      console.error('[auth] 迁移 users.json 失败:', e && e.message);
    }
  }

  // 空库时创建默认管理员
  ensureAdmin() {
    const { c } = this.stmt.count.get();
    if (c === 0) {
      const salt = crypto.randomBytes(16).toString('hex');
      const { N, r, p } = SCRYPT_DEFAULT;
      const hash = this.scrypt('admin123', salt, N, r, p);
      this.stmt.insert.run('admin', 'admin', salt, hash, 1, N, r, p, Date.now());
      console.log('[auth] 已创建默认管理员 admin / admin123 (首次登录请修改密码)');
    }
  }

  // scrypt 哈希(可指定强度参数)
  scrypt(pw, salt, N, r, p) {
    return crypto.scryptSync(String(pw), salt, 64, { N, r, p }).toString('hex');
  }

  hash(pw, salt) {
    const { N, r, p } = SCRYPT_DEFAULT;
    return this.scrypt(pw, salt, N, r, p);
  }

  verify(pw, user) {
    if (!user) return false;
    const h = this.scrypt(pw, user.salt, user.scrypt_n || SCRYPT_DEFAULT.N, user.scrypt_r || SCRYPT_DEFAULT.r, user.scrypt_p || SCRYPT_DEFAULT.p);
    const a = Buffer.from(h, 'hex'), b = Buffer.from(user.hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // 用户不存在时也走一次等价的 scrypt:否则「查无此人」几乎瞬时返回、
  // 存在的用户要算约 100ms,响应时间就成了用户名枚举的旁路
  burnScrypt(pw) {
    try { this.scrypt(pw, 'mcs-lite-timing-pad', SCRYPT_DEFAULT.N, SCRYPT_DEFAULT.r, SCRYPT_DEFAULT.p); } catch {}
  }

  findUser(name) {
    return this.stmt.find.get(String(name || ''));
  }

  list() {
    return this.stmt.all.all().map(u => ({ name: u.name, role: u.role, mustChange: !!u.must_change, createdAt: u.created_at }));
  }

  createUser(name, password, role) {
    if (this.findUser(name)) throw new Error('用户已存在');
    const salt = crypto.randomBytes(16).toString('hex');
    const { N, r, p } = SCRYPT_DEFAULT;
    const hash = this.scrypt(String(password), salt, N, r, p);
    this.stmt.insert.run(name, role === 'operator' ? 'operator' : 'admin', salt, hash, 0, N, r, p, Date.now());
    return true;
  }

  deleteUser(name) {
    const r = this.stmt.remove.run(String(name));
    return r.changes > 0;
  }

  // 设置新密码(可选强制下次修改)
  setPassword(name, newPw, mustChange = false) {
    const user = this.findUser(name);
    if (!user) throw new Error('用户不存在');
    const salt = crypto.randomBytes(16).toString('hex');
    const { N, r, p } = SCRYPT_DEFAULT;
    const hash = this.scrypt(String(newPw), salt, N, r, p);
    this.stmt.update.run(user.role, salt, hash, mustChange ? 1 : 0, N, r, p, name);
    return true;
  }

  // 校验旧密码后改密
  changePassword(name, oldPw, newPw) {
    const user = this.findUser(name);
    if (!user) throw new Error('用户不存在');
    if (!this.verify(oldPw, user)) throw new Error('原密码错误');
    this.setPassword(name, newPw, false);
    return true;
  }

  // ---------- 会话(落盘 SQLite,面板重启不掉线) ----------
  tokenHash(token) { return sha256(String(token || '')); }

  createSession(user) {
    const token = crypto.randomBytes(32).toString('hex');
    const exp = Date.now() + SESSION_TTL;
    try { this.stmt.sessPut.run(this.tokenHash(token), user.name, user.role, exp); } catch {}
    return token;
  }

  getSession(token) {
    if (!token) return null;
    try {
      const row = this.stmt.sessGet.get(this.tokenHash(token));
      if (!row) return null;
      if (Date.now() > row.exp) { this.destroy(token); return null; }
      return { name: row.name, role: row.role, exp: row.exp };
    } catch { return null; }
  }

  destroy(token) {
    try { this.stmt.sessDel.run(this.tokenHash(token)); } catch {}
  }

  // 用户被删除/改名后,其已签发的会话立即失效
  destroySessionsOf(name) {
    try { this.db.prepare('DELETE FROM sessions WHERE name = ?').run(String(name)); } catch {}
  }

  // 限流:每个 key(IP+用户名) 60 秒内最多 5 次
  checkRate(key) {
    const k = String(key || '?');
    const now = Date.now();
    let rec = this.loginAttempts.get(k);
    if (!rec || now > rec.resetAt) {
      rec = { count: 0, resetAt: now + 60000 };
      // 伪造用户名刷接口时防止 Map 无限增长
      if (this.loginAttempts.size > 2000) this.loginAttempts.delete(this.loginAttempts.keys().next().value);
      this.loginAttempts.set(k, rec);
    }
    rec.count++;
    if (rec.count > 5) {
      rec.resetAt = now + 60000;
      return { blocked: true, retryIn: Math.ceil((rec.resetAt - now) / 1000) };
    }
    return { blocked: false };
  }

  resetRate(key) { this.loginAttempts.delete(String(key || '?')); }

  // 中间件:解析 cookie 中的会话
  middleware() {
    return (req, res, next) => {
      const cookie = req.headers.cookie || '';
      const m = /(?:^|;\s*)token=([^;]+)/.exec(cookie);
      // 畸形百分号编码(如 token=%)不能让请求挂死,按无会话处理
      let token = null;
      if (m) { try { token = decodeURIComponent(m[1]); } catch { token = m[1]; } }
      req.session = this.getSession(token);
      next();
    };
  }

  requireAuth(req, res) {
    if (!req.session) { fail(res, 401, '未登录或会话已过期'); return false; }
    return true;
  }

  requireAdmin(req, res) {
    if (!req.session) { fail(res, 401, '未登录或会话已过期'); return false; }
    if (req.session.role !== 'admin') { fail(res, 403, '需要管理员权限'); return false; }
    return true;
  }

  // Secure 只在确实走 HTTPS 时加:面板本身是明文 HTTP,直连时加了会导致浏览器不回传 cookie
  cookieAttrs(req) {
    let secure = false;
    try {
      secure = !!(req && (req.socket && req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'));
    } catch {}
    return secure ? '; Secure' : '';
  }

  setCookie(res, token, req) {
    res.setHeader('Set-Cookie', `token=${token}; HttpOnly; Path=/; SameSite=Strict${this.cookieAttrs(req)}; Max-Age=${Math.floor(SESSION_TTL / 1000)}`);
  }

  clearCookie(res, req) {
    res.setHeader('Set-Cookie', `token=; HttpOnly; Path=/; SameSite=Strict${this.cookieAttrs(req)}; Max-Age=0`);
  }
}

module.exports = { Auth };
