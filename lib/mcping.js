'use strict';
// Minecraft 服务器探测:现代协议 ping / 旧版 ping / Query 协议(零依赖)
const net = require('net');
const dgram = require('dgram');

// VarInt 编码
function writeVarInt(n) {
  const b = [];
  while (true) {
    if ((n & ~0x7F) === 0) { b.push(n); break; }
    b.push((n & 0x7F) | 0x80);
    n >>>= 7;
  }
  return Buffer.from(b);
}

function readVarInt(buf, off) {
  let v = 0, shift = 0;
  while (off < buf.length) {
    const b = buf[off++];
    v |= (b & 0x7F) << shift;
    if ((b & 0x80) === 0) return { value: v, off };
    shift += 7;
    if (shift > 35) break;
  }
  return { value: -1, off };
}

// 现代协议 ServerListPing:握手 + 状态请求
function modernPing(host, port, timeout) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.connect({ host, port, timeout });
    const chunks = [];
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { sock.destroy(); } catch {} resolve(v); } };

    sock.on('connect', () => {
      const hostBuf = Buffer.from(host, 'utf8');
      const handshake = Buffer.concat([
        writeVarInt(0x00),
        writeVarInt(47),                  // protocol version(旧版客户端常用)
        writeVarInt(hostBuf.length), hostBuf,
        Buffer.from([(port >> 8) & 0xFF, port & 0xFF]),
        writeVarInt(1)                    // next state: status
      ]);
      const handshakePacket = Buffer.concat([writeVarInt(handshake.length), handshake]);
      const req = writeVarInt(1);         // 状态请求包长度
      const reqPacket = Buffer.concat([req, Buffer.from([0x00])]);
      sock.write(Buffer.concat([handshakePacket, reqPacket]));
    });

    sock.on('data', d => {
      chunks.push(d);
      const buf = Buffer.concat(chunks);
      // 解析:VarInt 包长 + 0x00(包类型) + VarInt(JSON 长度) + JSON
      const { value: len, off: o1 } = readVarInt(buf, 0);
      if (len <= 0 || o1 < 0) return;
      if (buf.length < o1 + len) return;
      let jsonBuf;
      const { value: jl, off: jo } = readVarInt(buf, o1 + 1);
      if (jl > 0 && buf.length >= jo + jl) {
        jsonBuf = buf.slice(jo, jo + jl);          // 标准:跳过 JSON 长度 VarInt
      } else {
        jsonBuf = buf.slice(o1 + 1, o1 + len);      // 兼容:无 JSON 长度前缀
      }
      // 若首字节不是 '{'(某些实现),整体重试
      if (jsonBuf[0] !== 0x7B) jsonBuf = buf.slice(o1, o1 + len);
      const text = jsonBuf.toString('utf8');
      let obj = null;
      try { obj = JSON.parse(text); } catch { }
      if (obj) {
        const players = obj.players || {};
        const ver = obj.version || {};
        finish({
          online: true,
          version: ver.name || '未知版本',
          protocol: ver.protocol,
          motd: stripColors(obj.description),
          players: players.online != null ? players.online : 0,
          maxPlayers: players.max != null ? players.max : 0,
          sample: Array.isArray(players.sample) ? players.sample.map(s => ({ name: String(s.name || ''), uuid: String(s.id || '') })).filter(p => p.name) : [],
          proto: 'modern',
          rtt: Date.now() - t0
        });
      }
    });

    sock.on('timeout', () => finish({ online: false, error: 'timeout' }));
    sock.on('error', e => finish({ online: false, error: e.code || 'error' }));
    sock.on('close', () => finish({ online: false, error: 'closed' }));
    setTimeout(() => finish({ online: false, error: 'timeout' }), timeout || 4000);
  });
}

// 旧版 ping:发送 0xFE 0x01,响应 "§1\0motd\0online\0max"
function legacyPing(host, port, timeout) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.connect({ host, port, timeout });
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { sock.destroy(); } catch {} resolve(v); } };
    sock.on('connect', () => sock.write(Buffer.from([0xFE, 0x01])));
    sock.on('data', d => {
      const text = d.toString('utf16le');
      if (text.startsWith('§')) {
        const parts = text.split('\0');
        // parts: [§1, motd, online, max]
        finish({
          online: true,
          motd: stripColors(parts[1] || ''),
          players: parseInt(parts[2], 10) || 0,
          maxPlayers: parseInt(parts[3], 10) || 0,
          version: (parts[1] || '').match(/\((.+?)\)/)?.[1] || '旧版服务器',
          sample: [],
          proto: 'legacy',
          rtt: Date.now() - t0
        });
      } else finish({ online: false, error: 'bad-response' });
    });
    sock.on('timeout', () => finish({ online: false, error: 'timeout' }));
    sock.on('error', e => finish({ online: false, error: e.code || 'error' }));
    sock.on('close', () => finish({ online: false, error: 'closed' }));
    setTimeout(() => finish({ online: false, error: 'timeout' }), timeout || 4000);
  });
}

// 官方 Query 协议(GS4,UDP):握手取 token 后请求完整规则,提取玩家列表(需服务端 enable-query=true)
function queryPing(host, port, timeout) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = dgram.createSocket('udp4');
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { sock.close(); } catch {} resolve(v); } };
    const timer = setTimeout(() => finish({ online: false, error: 'timeout' }), timeout || 4000);
    const sid = Buffer.from([0x00, 0x00, 0x00, 0x00]); // session id
    // 握手: FE FD 09 + session(4)
    sock.send(Buffer.concat([Buffer.from([0xFE, 0xFD, 0x09]), sid]), port, host, () => {});
    sock.on('message', (buf) => {
      if (done || buf.length < 5) return;
      const payload = buf.slice(5); // 去掉 type(1) + session(4)
      if (buf[0] === 0x09) {
        // token 响应:challenge token 字符串
        const token = payload.toString('utf8').replace(/\0+$/, '').trim();
        if (!token) { clearTimeout(timer); finish({ online: false, error: 'bad-token' }); return; }
        // 完整请求: FE FD 00 + session(4) + token + padding(4)
        const req = Buffer.concat([
          Buffer.from([0xFE, 0xFD, 0x00]), sid,
          Buffer.from(token, 'utf8'),
          Buffer.from([0x00, 0x00, 0x00, 0x00])
        ]);
        sock.send(req, port, host, () => {});
        return;
      }
      if (buf[0] !== 0x00) return;
      // 完整响应: kv 键值段 + 0x00 0x01player_ 0x00 0x00 + 玩家名列表
      clearTimeout(timer);
      const text = payload.toString('latin1');
      const marker = '\x00\x01player_\x00\x00';
      const idx = text.indexOf(marker);
      if (idx < 0) { finish({ online: false, error: 'bad-query' }); return; }
      const kv = text.slice(0, idx).split('\x00');
      let motd = '', version = '', players = 0, maxPlayers = 0;
      for (let i = 0; i + 1 < kv.length; i += 2) {
        const k = kv[i], v = kv[i + 1];
        if (k === 'hostname') motd = v;
        else if (k === 'version') version = v;
        else if (k === 'numplayers') players = parseInt(v, 10) || 0;
        else if (k === 'maxplayers') maxPlayers = parseInt(v, 10) || 0;
      }
      const sample = text.slice(idx + marker.length).split('\x00')
        .filter(Boolean).map(name => ({ name, uuid: '' }));
      finish({ online: true, motd: stripColors(motd), version, players, maxPlayers, sample, proto: 'query', rtt: Date.now() - t0 });
    });
    sock.on('error', (e) => { clearTimeout(timer); finish({ online: false, error: e.code || 'error' }); });
  });
}

// 去掉 § 颜色码
function stripColors(s) {
  return String(s || '').replace(/\u00a7[0-9a-fk-or]/gi, '').replace(/§[0-9a-fk-or]/gi, '').trim();
}

// 综合探测:先现代,再旧版;query 单独可选
async function probeServer(host, port, opts = {}) {
  const timeout = opts.timeout || 4000;
  let r = await modernPing(host, port, timeout);
  if (!r.online || r.error) r = await legacyPing(host, port, timeout);
  if (r.online && opts.query !== false) {
    const q = await queryPing(host, port, timeout);
    if (q.online && q.sample && q.sample.length > 0) {
      r = { ...r, sample: q.sample, proto: 'query+' + (r.proto || '') };
    }
  }
  return r;
}

module.exports = { probeServer, modernPing, legacyPing, queryPing };
