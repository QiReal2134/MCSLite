'use strict';
// SSE(Server-Sent Events)通道管理:控制台日志与状态推送
const { json } = require('./util');

class SSEHub {
  constructor() { this.clients = new Set(); }
  // 订阅,返回取消函数
  subscribe(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(': connected\n\n');
    const client = { res, alive: true };
    this.clients.add(client);
    const ping = setInterval(() => { try { client.res.write(': ping\n\n'); } catch {} }, 20000);
    const kill = () => { this.clients.delete(client); clearInterval(ping); };
    reqOnClose(client.res, kill);
    return kill;
  }
  send(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of [...this.clients]) {
      try { c.res.write(payload); } catch { this.clients.delete(c); }
    }
  }
  get size() { return this.clients.size; }
}

function reqOnClose(res, fn) {
  res.on('close', fn);
  // Node >= 16:close 事件在 socket 断开时触发
}

// 事件名常量
const EV = {
  LINE: 'line', STATUS: 'status', STATS: 'stats', PLAYERS: 'players', SYSTEM: 'system'
};

module.exports = { SSEHub, EV };
