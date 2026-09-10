/* ═══════════ MCSLite 前端逻辑(零依赖,原生 JS) ═══════════ */
'use strict';

/* ---------- 工具 ---------- */
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtBytes(n) {
  if (!n || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
}

function fmtUptime(sec) {
  if (!sec || sec <= 0) return '—';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}天${h}时`;
  if (h > 0) return `${h}时${m}分`;
  if (m > 0) return `${m}分${sec % 60}秒`;
  return `${sec}秒`;
}

// 解析内存字符串:2048M / 2G / 512MB -> 字节
function parseMem(s) {
  if (!s) return 0;
  const m = /^([\d.]+)\s*([KMGT]?)B?$/i.exec(String(s).trim());
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const u = (m[2] || '').toUpperCase();
  const mult = { K: 1024, M: 1024 * 1024, G: 1024 * 1024 * 1024, T: 1024 * 1024 * 1024 * 1024 }[u] || 1;
  return n * mult;
}

function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

/* ---------- API ---------- */
async function api(method, url, body, raw) {
  const opts = { method, headers: {} };
  let res;
  if (raw !== undefined) {
    // 原始字节上传(文件)
    opts.body = raw;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  try {
    res = await fetch(url, opts);
  } catch (e) {
    throw new Error('网络错误,请检查面板是否在运行');
  }
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) { try { data = await res.json(); } catch { } }
  if (!res.ok) {
    throw new Error((data && data.error) || `请求失败 (${res.status})`);
  }
  return data;
}

const get = (u) => api('GET', u);
const post = (u, b, raw) => api('POST', u, b, raw);
const put = (u, b) => api('PUT', u, b);
const del = (u, b) => api('DELETE', u, b);

/* ---------- Toast ---------- */
function toast(msg, type) {
  const el = document.createElement('div');
  el.className = 'toast-item' + (type ? ' ' + type : '');
  el.textContent = msg;
  $('#toast').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 350); }, 3200);
}

/* ---------- Modal ---------- */
function openModal(html, onMount) {
  closeModal();
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `<div class="modal">${html}</div>`;
  mask.addEventListener('click', (e) => { if (e.target === mask) closeModal(); });
  document.getElementById('modalRoot').appendChild(mask);
  const modal = $('.modal', mask);
  if (onMount) onMount(modal, mask);
  return { modal, mask, close: closeModal };
}

function closeModal() {
  const root = document.getElementById('modalRoot');
  root.innerHTML = '';
}

function confirmDialog(title, text, danger) {
  return new Promise((resolve) => {
    const { modal, mask } = openModal(`
      <h3>${esc(title)}</h3>
      <p class="hint">${esc(text)}</p>
      <div class="modal-actions">
        <button class="btn" data-act="no">取消</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="yes">确认</button>
      </div>`);
    $$('.modal-actions .btn', modal).forEach(b => {
      b.onclick = () => { closeModal(); resolve(b.dataset.act === 'yes'); };
    });
  });
}

/* ---------- 状态 ---------- */
const state = {
  user: null,
  instances: [],
  java: [],
  lanIPs: [],
  panel: {},
  currentId: null,
  tab: 'overview',
  filePath: '/',
  fileEntries: [],
  fileFilter: '',
  fileSort: { key: 'name', dir: 1 },
  sse: null,
  playerTimer: null,
  overviewTimer: null,
  consoleAutoScroll: true,
  bgVer: Date.now(),
  hasBg: false,   // 是否配置了背景图(否则用 CSS 渐变)
  hero: { title: '', slogan: '', hasImage: false },
  navPage: 'instances',
  ipList: [],
  pendingInstanceId: null,
  detailId: null,
  detailTimer: null
};

/* ---------- 视图切换 ---------- */
function showView(name) {
  ['playerView', 'detailView', 'loginView', 'adminView'].forEach(v => {
    document.getElementById(v).classList.toggle('hidden', v !== name);
  });
  if (name === 'playerView') startPlayerLoop();
  else stopPlayerLoop();
}

/* ═══════════════════ 背景 ═══════════════════ */
// 未设置背景图时 url 为空:此时完全走 CSS 渐变,不发任何图片请求
function setBg(url) {
  const root = document.documentElement;
  if (url) {
    root.style.setProperty('--bg-img', `url('${url}')`);
    root.classList.add('has-bg-img');
  } else {
    root.style.removeProperty('--bg-img');
    root.classList.remove('has-bg-img');
  }
}
// 背景图固定用 /bg:服务端按 mtime 发 ETag 并带 no-cache,浏览器每次只做一次 304 校验。
// 之前是 /bg?v=<时间戳>,每次开页面都是新地址,缓存完全命中不了,几 MB 的图每次重下
function bgUrl() { return state.hasBg ? '/bg' : ''; }
// 换过背景图后用带时间戳的地址刷一次,平时保持稳定地址以命中缓存
function bumpBg() {
  state.bgVer = Date.now();
  setBg(state.hasBg ? ('/bg?v=' + state.bgVer) : '');
}
// 面板配置里带 background 时同步背景图状态(空 = 用默认渐变)
function applyPanelBg(panel) {
  if (panel && 'background' in panel) {
    state.hasBg = !!panel.background;
    setBg(bgUrl());
  }
}
// 有背景图就渲染 <img>,没有就用渐变块(不能给 <img> 空的 src,那会把当前页面再请求一遍)
function bgImgHtml(attrs = '') {
  const u = bgUrl();
  return u ? `<img src="${u}" ${attrs} loading="lazy" decoding="async" data-err="hide">` : '';
}

// 毛玻璃颜色:根据配置的纯色 + 透明度生成 CSS 变量(无渐变)
function applyGlass(color, opacity) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(String(color || '#ffffff'));
  const hex = m ? m[1] : 'ffffff';
  const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
  const o = Math.max(0.02, Math.min(0.6, parseFloat(opacity) || 0.08));
  const root = document.documentElement.style;
  root.setProperty('--glass-bg', `rgba(${r},${g},${b},${o})`);
  // 强背景(弹窗/Toast):深色毛玻璃,带玻璃色微调,保证浅色文字可读
  const dr = Math.round(r * 0.12 + 14), dg = Math.round(g * 0.12 + 18), db = Math.round(b * 0.12 + 30);
  root.setProperty('--glass-bg-strong', `rgba(${dr},${dg},${db},${Math.min(0.88, o * 9 + 0.15).toFixed(3)})`);
  root.setProperty('--glass-border', `rgba(${r},${g},${b},${Math.min(0.55, o * 2.5).toFixed(3)})`);
}

// IP 池下拉选项(仅管理员添加的 IP;去掉自动检测/默认选项)
function ipOptions(curIp) {
  const list = state.ipList || [];
  let html = `<option value="" ${!curIp ? 'selected' : ''}>不绑定 IP</option>`;
  for (const ip of list) {
    html += `<option value="${esc(ip)}" ${curIp === ip ? 'selected' : ''}>${esc(ip)}</option>`;
  }
  if (curIp && !list.includes(curIp)) {
    html += `<option value="${esc(curIp)}" selected>${esc(curIp)} (不在列表中)</option>`;
  }
  return html;
}

// 关闭所有已打开的玻璃下拉
function closeAllGlassMenus() {
  $$('.gs-menu').forEach(m => { m.style.display = 'none'; });
  $$('.glass-select').forEach(w => w.classList.remove('open'));
}
// 全局只挂一次:点击下拉外部统一关闭(避免每个下拉各挂一个监听器导致泄漏)
document.addEventListener('click', (e) => {
  if (e.target.closest && e.target.closest('.glass-select')) return;
  closeAllGlassMenus();
});

// CSP 禁止内联 onerror 属性:img 加载失败统一在此委托处理
// (资源 error 事件不冒泡,须用捕获阶段监听)
// data-err="hide" → 隐藏图片;data-err="msg" → 替换为提示文字
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!img || img.tagName !== 'IMG') return;
  if (img.dataset.err === 'msg') {
    const tip = document.createElement('div');
    tip.className = 'muted';
    tip.textContent = '图片无法加载';
    img.replaceWith(tip);
  } else if (img.dataset.err === 'hide') {
    img.style.display = 'none';
  }
}, true);

// 把区域内所有 <select> 升级为玻璃下拉(原生弹出层无法加模糊;原 select 保留隐藏,值同步)
function upgradeSelects(root) {
  if (!root) return;
  $$('select', root).forEach(sel => {
    if (sel.dataset.gsUpgraded) return;
    sel.dataset.gsUpgraded = '1';
    const wrap = document.createElement('div');
    wrap.className = 'glass-select' + (sel.className ? ' ' + sel.className : '');
    const value = document.createElement('div');
    value.className = 'gs-value';
    const label = document.createElement('span');
    const caret = document.createElement('span');
    caret.className = 'gs-caret';
    caret.textContent = '▾';
    value.appendChild(label);
    value.appendChild(caret);
    const menu = document.createElement('div');
    menu.className = 'gs-menu';
    menu.style.display = 'none';
    const renderOpts = () => {
      menu.innerHTML = '';
      Array.from(sel.options).forEach(o => {
        const d = document.createElement('div');
        d.className = 'gs-option' + (o.selected ? ' sel' : '');
        d.textContent = o.textContent;
        d.dataset.v = o.value;
        d.onclick = (e) => {
          e.stopPropagation();
          sel.value = d.dataset.v;
          label.textContent = d.textContent;
          $$('.gs-option', menu).forEach(x => x.classList.toggle('sel', x === d));
          closeAllGlassMenus();
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        };
        menu.appendChild(d);
      });
    };
    const updateLabel = () => {
      const o = sel.options[sel.selectedIndex];
      label.textContent = o ? o.textContent : '';
    };
    value.onclick = (e) => {
      e.stopPropagation();
      const isOpen = menu.style.display === 'block';
      closeAllGlassMenus();
      if (!isOpen) {
        renderOpts();
        menu.style.display = 'block';
        wrap.classList.add('open');
        $$('.gs-option', menu).forEach(x => x.classList.toggle('sel', x.dataset.v === sel.value));
        const cur = $('.gs-option.sel', menu);
        if (cur) cur.scrollIntoView({ block: 'nearest' });
      }
    };
    updateLabel();
    wrap.appendChild(value);
    wrap.appendChild(menu);
    sel.style.display = 'none';
    sel.parentNode.insertBefore(wrap, sel);
  });
}

/* ═══════════════════ 玩家视图 ═══════════════════ */
function startPlayerLoop() {
  stopPlayerLoop();
  loadPlayer();
  state.playerTimer = setInterval(loadPlayer, 3000);
  const tick = () => { $('#pvClock').textContent = new Date().toLocaleString('zh-CN', { hour12: false }); };
  tick();
  state.playerTimer2 = setInterval(tick, 1000);
}
function stopPlayerLoop() {
  clearInterval(state.playerTimer);
  clearInterval(state.playerTimer2);
}

async function loadPlayer() {
  try {
    const data = await get('/api/status');
    $('#pvVer').textContent = 'v' + data.version;
    state.hero = data.hero || state.hero;
    state.hasBg = !!data.hasBg;
    setBg(bgUrl());
    if (data.glass) applyGlass(data.glass.color, data.glass.opacity);
    renderHero(data);
    renderPlayerGrid(data);
  } catch (e) {
    // 面板未就绪时静默
  }
}

function renderHero(d) {
  const hero = $('#pvHero');
  const first = d.instances.find(i => i.ping && i.ping.online) || d.instances[0] || null;
  const on = d.instances.some(i => i.status === 'running');
  // A 标题 / C 标语 / B 图片:优先管理员设定,留空自动(固定字号,见 CSS)
  const h = state.hero || {};
  const title = h.title || (first ? first.name : 'MCSLite 服务器');
  const slogan = h.slogan || (first && first.ping && first.ping.motd
    ? first.ping.motd
    : (on ? '欢迎来到我们的 Minecraft 世界' : '暂无运行中的服务器'));
  const imgSrc = h.hasImage ? '/hero' : bgUrl();   // 稳定地址 + ETag 协商,避免每次重下
  hero.innerHTML = `
    <div class="hero glass">
      <div class="hero-title">${esc(title)}</div>
      <div class="hero-sub">${esc(slogan)}</div>
    </div>
    ${imgSrc ? `<div class="hero-img-panel">
      <img src="${imgSrc}" alt="服务器图片" loading="lazy" decoding="async" data-err="hide">
    </div>` : ''}`;
}

function renderPlayerGrid(d) {
  const grid = $('#pvGrid');
  const instCards = d.instances.map(i => {
    const on = i.status === 'running';
    const p = i.ping && i.ping.online ? i.ping : null;
    const players = p ? p.players : 0;
    const maxP = p ? p.maxPlayers : 0;
    const samples = (p && p.sample && p.sample.length) ? p.sample : [];
    const sampleNames = samples.map(s => s.name || s);
    const addr = (i.ip || d.system.lanIPs[0] || '127.0.0.1') + ':' + i.port;
    // 实例占用:CPU / 内存(相对 Xmx)/ 硬盘
    const cpu = on ? i.cpu : 0;
    const mem = on ? i.mem : 0;
    const memCap = parseMem(i.xmx);
    const memPct = (on && memCap > 0) ? Math.min(100, Math.round(mem / memCap * 100)) : 0;
    const memText = on ? (fmtBytes(mem) + (memCap > 0 ? ' / ' + i.xmx : '')) : '—';
    const diskText = i.disk != null ? fmtBytes(i.disk) : (i.diskScanning ? '扫描中…' : '—');
    return `
    <div class="card inst-card" data-id="${esc(i.id)}">
      <div class="pv-card-title">${esc(i.name)} <span class="badge ${on ? '' : 'off'}">${on ? '运行中' : '已停止'}</span></div>
      ${on ? `
        <div class="kv"><span class="k">在线玩家</span><span class="v">${players} / ${maxP}</span></div>
        <div class="kv"><span class="k">版本</span><span class="v">${esc(p ? p.version : '—')}</span></div>
        <div class="kv"><span class="k">地址</span><span class="v">${esc(addr)}</span></div>
        <div class="kv"><span class="k">运行时长</span><span class="v">${fmtUptime(Math.floor(i.uptime / 1000))}</span></div>
      ` : `<div class="hero-empty muted">服务器未运行</div>`}
      <div class="divider"></div>
      <div class="pv-card-title" style="font-size:12.5px;color:var(--muted);margin-bottom:6px">实例占用</div>
      <div class="stat-row"><span class="stat-label">CPU</span><div class="bar ${barClass(cpu)}"><i style="width:${Math.min(100, cpu)}%"></i></div><span class="stat-val">${on ? cpu + '%' : '—'}</span></div>
      <div class="stat-row"><span class="stat-label">内存</span>${memCap > 0 && on ? `<div class="bar ${barClass(memPct)}"><i style="width:${memPct}%"></i></div>` : '<div class="bar"><i style="width:0%"></i></div>'}<span class="stat-val">${esc(memText)}</span></div>
      <div class="stat-row"><span class="stat-label">硬盘</span><span class="v" style="font-size:12px">${esc(diskText)}</span><span class="stat-val" style="width:0"></span></div>
      ${samples.length ? `<div style="margin-top:10px"><div class="muted" style="font-size:12px;margin-bottom:4px">在线玩家:</div>${sampleNames.map(n => `<span class="player-chip">${esc(n)}</span>`).join('')}</div>` : ''}
      <div class="manage-link">查看详情 ></div>
    </div>`;
  }).join('');

  grid.innerHTML = `
    <div class="card">
      <div class="pv-card-title">服务器实例 <span class="badge">${d.instances.length} 个</span></div>
      ${d.instances.length ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px">${instCards}</div>`
        : '<div class="hero-empty muted">尚未创建任何服务器实例</div>'}
    </div>`;

  // 点击实例卡片 → 进入公开的玩家详情页(无需登录)
  $$('.inst-card', grid).forEach(card => {
    card.onclick = () => showDetail(card.dataset.id);
  });
}

/* ═══════════════════ 玩家·服务器详情(公开,普通玩家可见) ═══════════════════ */
function showDetail(id) {
  state.detailId = id;
  state.detailTimer && clearInterval(state.detailTimer);
  stopPlayerLoop();
  showView('detailView');
  loadDetail();
  state.detailTimer = setInterval(loadDetail, 3000);
}

function leaveDetail() {
  clearInterval(state.detailTimer);
  state.detailId = null;
  showView('playerView');
}

$('#btnDetailBack').onclick = leaveDetail;

async function loadDetail() {
  const id = state.detailId;
  if (!id) return;
  try {
    const data = await get('/api/status/' + id);
    renderDetail(data.instance || {}, !!data.publicDownload);
  } catch (e) {
    $('#dtContent').innerHTML = `<div class="card"><div class="muted">${esc(e.message)}</div></div>`;
  }
}

function renderDetail(i, canDownload) {
  const el = $('#dtContent');
  const on = i.status === 'running';
  const p = i.ping && i.ping.online ? i.ping : null;
  const addr = (i.ip || '127.0.0.1') + ':' + i.port;
  const tps = on ? (i.tps != null ? i.tps.toFixed(1) : '—') : '—';
  const rtt = p && p.rtt != null ? Math.round(p.rtt) + 'ms' : '—';
  const players = on ? (p ? p.players : '—') : '—';
  const maxP = on && p ? p.maxPlayers : 0;
  const diskText = i.disk != null ? fmtBytes(i.disk) : (i.diskScanning ? '扫描中…' : '—');
  const sample = (p && p.sample && p.sample.length) ? p.sample : [];
  const playerRows = sample.map(pl => {
    const name = pl.name || pl;
    return `
      <div class="player-row">
        <img class="avatar" src="${avatarFallback(name)}" loading="lazy" alt="">
        <span class="p-name">${esc(name)}</span>
        ${pl.admin ? `<span class="badge op">管理员</span>` : `<span class="badge">玩家</span>`}
      </div>`;
  }).join('');
  $('#dtStatus').innerHTML = `<span class="dot ${on ? 'on' : 'off'}"></span> ${on ? '运行中' : '已停止'}`;
  el.innerHTML = `
    <div class="hero-row">
      <div class="hero glass">
        <div class="hero-title">${esc(i.name)}</div>
        <div class="hero-sub">${esc(p ? p.motd : (on ? '欢迎来到我们的世界' : '服务器未运行'))}</div>
      </div>
      ${bgUrl() ? `<div class="hero-img-panel">${bgImgHtml('alt=""')}</div>` : ''}
    </div>
    <div class="stat-cards">
      <div class="card stat-mini"><div class="v" style="color:${(on && i.tps != null && i.tps < 18) ? 'var(--warn)' : ''}">${tps}</div><div class="l">TPS</div></div>
      <div class="card stat-mini"><div class="v">${esc(rtt)}</div><div class="l">Ping</div></div>
      <div class="card stat-mini"><div class="v">${players} <span style="font-size:13px">/ ${maxP}</span></div><div class="l">人数</div></div>
      <div class="card stat-mini"><div class="v">${esc(p ? p.version : '—')}</div><div class="l">版本</div></div>
      <div class="card stat-mini"><div class="v" style="font-size:15px">${esc(addr)}</div><div class="l">服务器地址</div></div>
      <div class="card stat-mini"><div class="v">${on ? i.cpu.toFixed(1) + '%' : '—'}</div><div class="l">CPU</div></div>
      <div class="card stat-mini"><div class="v">${on ? fmtBytes(i.mem) : '—'}</div><div class="l">内存</div></div>
      <div class="card stat-mini"><div class="v">${esc(diskText)}</div><div class="l">硬盘</div></div>
    </div>
    <div class="ov-title">在线玩家 (${sample.length})</div>
    <div class="card">
      ${sample.length ? playerRows : (on ? '<div class="hero-empty muted">暂无玩家在线</div>' : '<div class="hero-empty muted">服务器未运行</div>')}
    </div>
    ${canDownload ? `<div class="ov-title">存档下载</div>
    <div class="card" id="dtBackups"><div class="muted">加载中...</div></div>` : ''}`;
  if (canDownload) loadPlayerBackups(i.id);
}

// 玩家详情页:备份列表 + 实时存档下载(每 IP 120 秒限 1 次)
async function loadPlayerBackups(id) {
  const box = $('#dtBackups');
  try {
    const data = await get(`/api/status/${id}/backups`);
    const rows = (data.backups || []).map(b => `
      <div class="player-row">
        <span class="p-name mono">${esc(b.name)}</span>
        <span class="muted" style="font-size:12px">${fmtBytes(b.size)} · ${new Date(b.mtime).toLocaleString('zh-CN', { hour12: false })}</span>
        <button class="btn btn-sm" data-dl="${esc(b.name)}">下载</button>
      </div>`).join('');
    box.innerHTML = `
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
        <button class="btn btn-primary btn-sm" id="dtLiveSave">下载实时存档 (仅地图)</button>
        <span class="muted" style="font-size:12px">限流:每 IP 120 秒 1 次</span>
      </div>
      ${rows ? `<div style="border-top:1px dashed rgba(255,255,255,.1);padding-top:6px">${rows}</div>` : '<div class="hero-empty muted">暂无备份</div>'}`;
    $('#dtLiveSave', box).onclick = () => { window.location = `/api/status/${id}/save`; };
    $$('[data-dl]', box).forEach(b => b.onclick = () => { window.location = `/api/status/${id}/backup/${encodeURIComponent(b.dataset.dl)}`; });
  } catch (e) {
    box.innerHTML = `<div class="muted">${esc(e.message)}</div>`;
  }
}

function barClass(v) {
  if (v >= 90) return 'crit';
  if (v >= 70) return 'warn';
  return '';
}

function copyText(t) {
  const ta = document.createElement('textarea');
  ta.value = t;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch { }
  ta.remove();
}

/* ═══════════════════ 登录 ═══════════════════ */
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#loginBtn');
  btn.disabled = true; btn.textContent = '登录中...';
  $('#loginErr').classList.add('hidden');
  try {
    const data = await post('/api/login', { username: $('#loginUser').value.trim(), password: $('#loginPass').value });
    state.user = { name: data.name, role: data.role };
    toast('欢迎回来,' + data.name, 'ok');
    await enterAdmin();
  } catch (err) {
    const el = $('#loginErr');
    el.textContent = err.message;
    el.classList.remove('hidden');
  } finally {
    btn.disabled = false; btn.textContent = '登 录';
  }
});

/* ═══════════════════ 管理后台(通过地址栏 /admin 进入) ═══════════════════ */
$('#btnBackPlayer').onclick = () => { history.replaceState(null, '', '/'); showView('playerView'); };
$('#btnBackPlayer2').onclick = () => { history.replaceState(null, '', '/'); showView('playerView'); };

async function tryEnterAdmin() {
  try {
    const me = await get('/api/me');
    state.user = me;
    await enterAdmin();
  } catch {
    showView('loginView');
  }
}

async function enterAdmin() {
  history.replaceState(null, '', '/admin');
  showView('adminView');
  try {
    const data = await get('/api/admin/overview');
    state.instances = data.instances || [];
    state.java = data.java || [];
    state.lanIPs = data.lanIPs || [];
    state.panel = data.panel || {};
    state.ipList = (data.panel && data.panel.ipList) || [];
    applyGlass(state.panel.glassColor, state.panel.glassOpacity);
    applyPanelBg(state.panel);
    renderSidebar();
    // 优先打开玩家页点击的实例
    const want = state.pendingInstanceId;
    state.pendingInstanceId = null;
    if (want && state.instances.some(i => i.id === want)) selectInstance(want);
    else if (state.instances.length > 0) selectInstance(state.instances[0].id);
    else showGlobalPage('instances');
    startOverviewLoop();
  } catch (e) {
    if (e.message.includes('未登录') || e.message.includes('会话')) { showView('loginView'); }
    else toast(e.message, 'err');
  }
}

function startOverviewLoop() {
  clearInterval(state.overviewTimer);
  state.overviewTimer = setInterval(async () => {
    try {
      const data = await get('/api/admin/overview');
      state.instances = data.instances || [];
      state.java = data.java || [];
      state.lanIPs = data.lanIPs || [];
      state.panel = data.panel || {};
      applyPanelBg(state.panel);
      renderSidebar();
      if (state.currentId) {
        const cur = state.instances.find(i => i.id === state.currentId);
        if (cur) {
          renderInstanceHeader(cur);
          if (state.tab === 'overview') renderOverview(cur);
        }
      }
      if (state.navPage === 'ip') renderIpPage(true);
      if (state.navPage === 'java' && $('#pageJava').innerHTML.includes('扫描中')) renderJavaPage();
    } catch { }
  }, 3000);
}

function renderSidebar() {
  const list = $('#instanceList');
  list.innerHTML = state.instances.length ? state.instances.map(i => `
    <div class="instance-item ${i.id === state.currentId ? 'active' : ''}" data-id="${esc(i.id)}">
      <span class="mini-dot ${i.status}"></span>
      <span class="i-name">${esc(i.name)}</span>
      ${i.status === 'running' ? `<span class="muted" style="font-size:11px">${i.ping && i.ping.online ? (i.ping.players || 0) + '人' : '…'}</span>` : ''}
    </div>`).join('')
    : '<div class="muted" style="font-size:12px;padding:6px 4px">暂无实例</div>';
  $$('.instance-item', list).forEach(el => {
    el.onclick = () => selectInstance(el.dataset.id);
  });
}

function selectInstance(id) {
  state.currentId = id;
  state.tab = 'overview';
  closeConsoleStream();
  renderSidebar();
  showGlobalPage('instances');
  const page = $('#instancePage');
  page.classList.remove('hidden');
  $$('.tab', page).forEach(t => t.classList.toggle('active', t.dataset.tab === 'overview'));
  switchTab('overview');
  const cur = state.instances.find(i => i.id === id);
  if (cur) renderInstanceHeader(cur);
}

// 四大板块:instances(实例管理)/ java / ip / settings(设置)
function showGlobalPage(name) {
  state.navPage = name || 'instances';
  const pages = { java: 'pageJava', ip: 'pageIp', settings: 'pageSettings' };
  for (const [key, id] of Object.entries(pages)) {
    $('#' + id).classList.toggle('hidden', key !== name);
  }
  const instPage = $('#instancePage');
  instPage.classList.toggle('hidden', name !== 'instances');
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.nav === name));
  if (name === 'java') renderJavaPage();
  else if (name === 'ip') renderIpPage();
  else if (name === 'settings') renderSettingsPage();
  else if (name === 'instances') renderInstancesEmpty();
}

// 实例管理空状态(未选中实例时)——重建完整骨架以免破坏标签结构
function renderInstancesEmpty() {
  const page = $('#instancePage');
  if (state.currentId) return;
  page.classList.remove('hidden');
  page.innerHTML = `
    <div id="instanceHeader" class="glass pad" style="display:none"></div>
    <div class="tabs glass" style="display:none">
      <button class="tab active" data-tab="overview">概览</button>
      <button class="tab" data-tab="console">控制台</button>
      <button class="tab" data-tab="files">文件管理</button>
      <button class="tab" data-tab="backups">备份</button>
      <button class="tab" data-tab="config">配置</button>
    </div>
    <div id="tabOverview" class="tab-pane"></div>
    <div id="tabConsole" class="tab-pane hidden">
      <div class="console-toolbar">
        <input id="consoleInput" type="text" placeholder="输入指令,如 list / op" autocomplete="off">
        <button id="btnConsoleSend" class="btn btn-primary">发送</button>
      </div>
      <div id="consoleBox" class="console glass"></div>
    </div>
    <div id="tabFiles" class="tab-pane hidden"></div>
    <div id="tabBackups" class="tab-pane hidden"></div>
    <div id="tabConfig" class="tab-pane hidden"></div>
    <div class="card" style="padding:44px;text-align:center">
      <div class="ov-title" style="justify-content:center;margin:12px 0 6px">实例管理</div>
      <div class="muted" style="margin-bottom:20px">暂无实例,创建或导入后开始管理</div>
      <button class="btn btn-primary" id="ieCreate">+ 新建 / 导入整合包</button>
    </div>`;
  $('#ieCreate', page).onclick = openImportWizard;
}

$$('.nav-item').forEach(b => {
  b.onclick = () => { closeConsoleStream(); showGlobalPage(b.dataset.nav); };
});

/* ---------- 实例头部 ---------- */
function renderInstanceHeader(cur) {
  const el = $('#instanceHeader');
  const running = cur.status === 'running';
  const p = cur.ping && cur.ping.online ? cur.ping : null;
  const tpsTxt = running ? (cur.tps != null ? 'TPS ' + cur.tps.toFixed(1) : 'TPS —') : '';
  const rttTxt = p && p.rtt != null ? 'Ping ' + Math.round(p.rtt) + 'ms' : '';
  const pplTxt = running && p ? (p.players || 0) + '人' : '';
  const extra = [tpsTxt, rttTxt, pplTxt].filter(Boolean).join(' · ');
  el.innerHTML = `
    <span class="dot ${running ? 'on' : 'off'}"></span>
    <h2>${esc(cur.name)}</h2>
    <div class="muted" style="font-size:12px">${running ? '运行中 · PID ' + cur.pid : '已停止'}${extra ? ' · ' + extra : ''} · ${esc(cur.java)} · ${esc(cur.jar || '未设置 jar')}</div>
    <div class="actions">
      ${running ? `
        <button class="btn btn-sm btn-ok" data-act="restart">重启</button>
        <button class="btn btn-sm" data-act="stop">停止</button>
        <button class="btn btn-sm btn-danger" data-act="kill">强制结束</button>`
      : `<button class="btn btn-sm btn-primary" data-act="start">启动</button>`}
      <button class="btn btn-sm" data-act="settings">实例设置</button>
      <button class="btn btn-sm btn-danger" data-act="delete">删除</button>
    </div>`;
  $$('.actions .btn', el).forEach(b => {
    b.onclick = async () => {
      const act = b.dataset.act;
      if (act === 'start') doAction('start');
      else if (act === 'stop') { if (await confirmDialog('停止服务器', '将发送 stop 指令,等待服务端安全退出。确认停止?')) doAction('stop'); }
      else if (act === 'restart') { if (await confirmDialog('重启服务器', '将停止并重新启动服务端。确认重启?')) doAction('restart'); }
      else if (act === 'kill') { if (await confirmDialog('强制结束', '将立即强制终止进程,可能造成存档损坏!确认?' , true)) doAction('kill'); }
      else if (act === 'settings') openInstanceSettings(cur.id);
      else if (act === 'delete') {
        if (cur.status === 'running') { toast('请先停止服务器再删除', 'err'); return; }
        if (await confirmDialog('删除实例', `将删除实例「${cur.name}」及其全部文件,此操作不可恢复!确认?`, true)) {
          try { await del('/api/admin/instances/' + cur.id); toast('已删除', 'ok'); refreshOverview(); } catch (e) { toast(e.message, 'err'); }
        }
      }
    };
  });
}

async function doAction(act) {
  try {
    await post(`/api/admin/instances/${state.currentId}/${act}`);
    toast(act === 'start' ? '启动指令已发送' : '操作成功', 'ok');
    refreshOverview();
    if (act === 'start' && state.tab === 'console') openConsoleStream();
  } catch (e) { toast(e.message, 'err'); }
}

async function refreshOverview() {
  try {
    const data = await get('/api/admin/overview');
    state.instances = data.instances || [];
    renderSidebar();
    const cur = state.instances.find(i => i.id === state.currentId);
    if (cur) renderInstanceHeader(cur);
    if (state.tab === 'overview' && cur) renderOverview(cur);
  } catch { }
}

/* ---------- Tab 切换 ---------- */
$$('.tab').forEach(t => {
  t.onclick = () => switchTab(t.dataset.tab);
});
// 事件委托:空状态重建的标签页也能点击
document.getElementById('instancePage').addEventListener('click', (e) => {
  const t = e.target.closest('.tab[data-tab]');
  if (t) switchTab(t.dataset.tab);
});

function switchTab(tab) {
  state.tab = tab;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  ['overview', 'console', 'files', 'backups', 'config'].forEach(n => {
    $('#tab' + n[0].toUpperCase() + n.slice(1)).classList.toggle('hidden', n !== tab);
  });
  const cur = state.instances.find(i => i.id === state.currentId);
  if (!cur) return;
  if (tab === 'overview') renderOverview(cur);
  else if (tab === 'console') initConsole();
  else if (tab === 'files') renderFiles();
  else if (tab === 'backups') renderBackups();
  else if (tab === 'config') renderConfig();
}

/* ---------- 备份 Tab ---------- */
async function renderBackups() {
  const el = $('#tabBackups');
  const id = state.currentId;
  el.innerHTML = '<div class="muted">加载中...</div>';
  try {
    const data = await get(`/api/admin/instances/${id}/backups`);
    const cfg = data.config || {};
    const rows = (data.backups || []).map(b => `
      <tr>
        <td class="mono">${esc(b.name)}</td>
        <td>${fmtBytes(b.size)}</td>
        <td class="muted" style="font-size:12px">${new Date(b.mtime).toLocaleString('zh-CN', { hour12: false })}</td>
        <td>
          <div class="factions" style="justify-content:flex-end">
            <button class="faction" data-dl="${esc(b.name)}">下载</button>
            <button class="faction del" data-del="${esc(b.name)}">删除</button>
          </div>
        </td>
      </tr>`).join('');
    el.innerHTML = `
      <div class="cfg-section">
        <div class="ov-title">自动备份设置</div>
        <div class="card">
          <div class="cfg-grid">
            <div class="cfg-item"><label>启用定时备份</label><input type="checkbox" id="bkEnabled" ${cfg.enabled ? 'checked' : ''}></div>
            <div class="cfg-item"><label>间隔(分钟)</label><input type="number" id="bkInterval" value="${cfg.interval || 60}" min="1"></div>
            <div class="cfg-item"><label>最大自动备份数</label><input type="number" id="bkMax" value="${cfg.max || 10}" min="1"></div>
            <div class="cfg-item"><label>命名模式</label><input type="text" id="bkPattern" value="${esc(cfg.pattern || 'auto-{y}{m}{d}-{h}{min}')}" placeholder="auto-{y}{m}{d}-{h}{min}"></div>
          </div>
          <div style="margin-top:12px;display:flex;gap:10px;align-items:center">
            <button class="btn btn-primary btn-sm" id="bkSave">保存备份设置</button>
            <span class="muted" style="font-size:12px">命名模式:{y}年 {m}月 {d}日 {h}时 {min}分</span>
          </div>
        </div>
      </div>
      <div class="cfg-section">
        <div class="ov-title">手动备份</div>
        <div class="card">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <input id="bkManualName" type="text" placeholder="备份名称(留空=按时间)" style="width:220px;padding:8px 12px;border-radius:10px;border:1px solid var(--glass-border);background:rgba(0,0,0,.3);color:var(--text)">
            <button class="btn btn-primary btn-sm" id="bkManual">立即备份</button>
          </div>
          <div class="hint" style="margin-top:8px">手动备份不会计入最大数量,不会被自动清理</div>
        </div>
      </div>
      <div class="cfg-section">
        <div class="ov-title">备份列表 (${(data.backups || []).length})</div>
        <div class="card">
          ${rows ? `<div class="file-table-wrap glass" style="overflow:auto"><table class="file-table">
            <thead><tr><th>名称</th><th>大小</th><th>时间</th><th style="text-align:right">操作</th></tr></thead>
            <tbody>${rows}</tbody></table></div>` : '<div class="hero-empty muted">暂无备份</div>'}
        </div>
      </div>`;
    $('#bkSave', el).onclick = async () => {
      try {
        await put(`/api/admin/instances/${id}/config`, {
          backupEnabled: $('#bkEnabled', el).checked,
          backupInterval: $('#bkInterval', el).value,
          backupMax: $('#bkMax', el).value,
          backupPattern: $('#bkPattern', el).value.trim()
        });
        toast('备份设置已保存', 'ok');
        renderBackups();
      } catch (e) { toast(e.message, 'err'); }
    };
    $('#bkManual', el).onclick = async () => {
      const name = $('#bkManualName', el).value.trim();
      const btn = $('#bkManual', el);
      btn.disabled = true; btn.textContent = '备份中...';
      try {
        const r = await post(`/api/admin/instances/${id}/backups`, { name });
        toast('备份完成: ' + r.backup.name, 'ok');
        $('#bkManualName', el).value = '';
        renderBackups();
      } catch (e) { toast(e.message, 'err'); }
      finally { btn.disabled = false; btn.textContent = '立即备份'; }
    };
    $$('[data-dl]', el).forEach(b => b.onclick = () => { window.location = `/api/admin/instances/${id}/backups/${encodeURIComponent(b.dataset.dl)}/download`; });
    $$('[data-del]', el).forEach(b => b.onclick = async () => {
      if (!await confirmDialog('删除备份', '确定删除备份 ' + b.dataset.del + '?', true)) return;
      try { await del(`/api/admin/instances/${id}/backups/${encodeURIComponent(b.dataset.del)}`); toast('已删除', 'ok'); renderBackups(); }
      catch (e) { toast(e.message, 'err'); }
    });
  } catch (e) {
    el.innerHTML = `<div class="muted">${esc(e.message)}</div>`;
  }
}

/* ---------- 概览 Tab ---------- */
function renderOverview(cur) {
  const el = $('#tabOverview');
  const on = cur.status === 'running';
  const p = cur.ping && cur.ping.online ? cur.ping : null;
  const addr = (cur.ip || state.lanIPs[0] || '127.0.0.1') + ':' + cur.port;
  const cpu = on ? cur.cpu : 0;
  const mem = on ? cur.mem : 0;
  const diskText = cur.disk != null ? fmtBytes(cur.disk) : (cur.diskScanning ? '扫描中…' : '—');
  // TPS / Ping / 人数
  const tps = on ? (cur.tps != null ? cur.tps.toFixed(1) : '—') : '—';
  const rtt = p && p.rtt != null ? Math.round(p.rtt) + 'ms' : '—';
  const players = on ? (p ? p.players : '—') : '—';
  const maxP = on && p ? p.maxPlayers : 0;
  const sample = (p && p.sample && p.sample.length) ? p.sample : [];
  const sampleNames = sample.map(s => s.name || s);
  // 在线玩家列表:头像 + 名字 + 管理员/玩家徽章
  const playerRows = sample.map(pl => {
    const name = pl.name || pl;
    return `
      <div class="player-row">
        <img class="avatar" src="${avatarFallback(name)}" loading="lazy" alt="">
        <span class="p-name">${esc(name)}</span>
        ${pl.admin ? `<span class="badge op">管理员</span>` : `<span class="badge">玩家</span>`}
      </div>`;
  }).join('');
  el.innerHTML = `
    <div class="stat-cards">
      <div class="card stat-mini"><div class="v" style="color:${on ? 'var(--ok)' : '#888'}">${on ? '运行中' : '已停止'}</div><div class="l">状态</div></div>
      <div class="card stat-mini"><div class="v" style="color:${(on && cur.tps != null && cur.tps < 18) ? 'var(--warn)' : ''}">${tps}</div><div class="l">TPS</div></div>
      <div class="card stat-mini"><div class="v">${esc(rtt)}</div><div class="l">Ping</div></div>
      <div class="card stat-mini"><div class="v">${players} <span style="font-size:13px">/ ${maxP}</span></div><div class="l">人数</div></div>
      <div class="card stat-mini"><div class="v">${on ? cpu.toFixed(1) + '%' : '—'}</div><div class="l">进程 CPU</div></div>
      <div class="card stat-mini"><div class="v">${on ? fmtBytes(mem) : '—'}</div><div class="l">进程内存</div></div>
      <div class="card stat-mini"><div class="v">${esc(diskText)}</div><div class="l">硬盘占用</div></div>
      <div class="card stat-mini"><div class="v">${on ? fmtUptime(Math.floor((Date.now() - (cur.startedAt || Date.now())) / 1000)) : '—'}</div><div class="l">运行时长</div></div>
      <div class="card stat-mini"><div class="v" style="font-size:15px">${esc(addr)}</div><div class="l">服务器地址</div></div>
    </div>
    <div class="ov-title">在线玩家 (${sample.length})</div>
    <div class="card">
      ${sample.length ? playerRows : (on ? '<div class="hero-empty muted">暂无玩家在线</div>' : '<div class="hero-empty muted">服务器未运行</div>')}
    </div>
    <div class="ov-title">服务器信息</div>
    <div class="card">
      <div class="kv"><span class="k">状态</span><span class="v">${on ? '运行中 (PID ' + cur.pid + ')' : '已停止'}</span></div>
      <div class="kv"><span class="k">版本</span><span class="v">${esc(p ? p.version : '—')}</span></div>
      <div class="kv"><span class="k">MOTD</span><span class="v">${esc(p ? p.motd : '—')}</span></div>
      <div class="kv"><span class="k">在线玩家</span><span class="v">${p ? sampleNames.length ? sampleNames.map(n => esc(n)).join(', ') : '无' : '—'}</span></div>
      <div class="kv"><span class="k">硬盘占用</span><span class="v">${esc(diskText)}${cur.xmx ? ' · 内存上限 ' + esc(cur.xmx) : ''}</span></div>
      <div class="kv"><span class="k">监听地址</span><span class="v">${esc(cur.ip || '0.0.0.0')}:${cur.port}</span></div>
      <div class="kv"><span class="k">服务端 jar</span><span class="v">${esc(cur.jar || '—')}</span></div>
      <div class="kv"><span class="k">Java</span><span class="v">${esc(cur.java)}</span></div>
    </div>`;
}

// 头像加载失败时的首字母头像(纯色底 + 首字母)
function avatarFallback(name) {
  const ch = (name || '?').charAt(0).toUpperCase();
  const hue = (String(name) || '').split('').reduce((s, c) => s + c.charCodeAt(0), 0) % 360;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48'><rect width='48' height='48' rx='8' fill='hsl(${hue},45%,30%)'/><text x='24' y='32' font-size='24' fill='#fff' text-anchor='middle' font-family='sans-serif'>${ch}</text></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

/* ---------- 控制台 Tab ---------- */
function initConsole() {
  const box = $('#consoleBox');
  box.innerHTML = '<div class="c-line dim">正在连接控制台...</div>';
  $('#consoleInput').value = '';
  openConsoleStream();
  box.scrollTop = box.scrollHeight;
}

function openConsoleStream() {
  closeConsoleStream();
  const box = $('#consoleBox');
  const es = new EventSource(`/api/admin/instances/${state.currentId}/stream`);
  state.sse = es;
  es.onopen = () => { };
  es.addEventListener('line', (ev) => {
    try {
      const d = JSON.parse(ev.data);
      if (d.id !== state.currentId) return;
      appendConsoleLine(d.line);
    } catch { }
  });
  es.addEventListener('status', (ev) => {
    try {
      const d = JSON.parse(ev.data);
      if (d.id !== state.currentId) return;
      appendConsoleLine(`[面板] 服务端状态: ${d.status === 'running' ? '运行中 (PID ' + d.pid + ')' : '已停止'}`, 'info');
    } catch { }
  });
  es.onerror = () => {
    // 自动重连由 EventSource 处理
  };
}

function closeConsoleStream() {
  if (state.sse) { try { state.sse.close(); } catch { } state.sse = null; }
}

function appendConsoleLine(line, cls) {
  const box = $('#consoleBox');
  const div = document.createElement('div');
  div.className = 'c-line' + (cls ? ' ' + cls : '');
  div.textContent = line;
  // 简单着色:含 ERROR/WARN/INFO 关键词
  if (!cls) {
    if (/ERROR|Exception|致命|错误|Failed|Error/.test(line)) div.className = 'c-line err';
    else if (/WARN|警告|WARNING/.test(line)) div.className = 'c-line warn';
    else if (/INFO|信息|Done|准备|启动|stopping|Stopping/.test(line)) div.className = 'c-line info';
  }
  box.appendChild(div);
  // 限制行数
  while (box.children.length > 2000) box.removeChild(box.firstChild);
  if (state.consoleAutoScroll) box.scrollTop = box.scrollHeight;
}

function sendConsoleCommand() {
  const input = $('#consoleInput');
  const cmd = input.value.trim();
  if (!cmd) return;
  input.value = '';
  post(`/api/admin/instances/${state.currentId}/command`, { cmd })
    .then(() => { })
    .catch(e => toast(e.message, 'err'));
}
$('#btnConsoleSend').onclick = sendConsoleCommand;
$('#consoleInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendConsoleCommand(); });
$('#consoleBox').addEventListener('scroll', () => {
  const box = $('#consoleBox');
  state.consoleAutoScroll = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
});

/* ---------- 文件管理 Tab ---------- */
async function renderFiles() {
  const el = $('#tabFiles');
  // 骨架屏:避免白屏等待
  el.innerHTML = `<div class="files-skeleton glass">
    <div class="sk-bar"></div>
    <div class="sk-row w60"></div>
    <div class="sk-row"></div>
    <div class="sk-row w80"></div>
    <div class="sk-row"></div>
    <div class="sk-row w70"></div>
  </div>`;
  try {
    const data = await get(`/api/admin/instances/${state.currentId}/files?path=${encodeURIComponent(state.filePath)}`);
    state.fileEntries = data.entries || [];
    renderFileList(data);
  } catch (e) {
    el.innerHTML = `<div class="muted">${esc(e.message)}</div>`;
  }
}

// 当前端内排序与过滤(纯客户端,不重复请求)
function fileView(entries) {
  const kw = (state.fileFilter || '').toLowerCase();
  let list = kw ? entries.filter(f => f.name.toLowerCase().includes(kw)) : entries.slice();
  const s = state.fileSort || { key: 'name', dir: 1 };
  list.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1; // 目录始终在前
    let r = 0;
    if (s.key === 'size') r = a.size - b.size;
    else if (s.key === 'mtime') r = a.mtime - b.mtime;
    else r = a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
    return r * s.dir;
  });
  return list;
}

function renderFileList(data) {
  const el = $('#tabFiles');
  const segs = data.path.split('/').filter(Boolean);
  const crumbs = ['<a data-p="/">根目录</a>'];
  let acc = '';
  segs.forEach((s, i) => {
    acc += '/' + s;
    crumbs.push('<span>/</span><a data-p="' + esc(acc) + '">' + esc(s) + '</a>');
  });
  const s = state.fileSort || { key: 'name', dir: 1 };
  const arrow = (key) => s.key === key ? (s.dir > 0 ? ' ▲' : ' ▼') : '';
  const list = fileView(state.fileEntries || []);
  const rows = list.map(fileRowHtml).join('');

  el.innerHTML = `
    <div class="file-toolbar">
      <div class="crumb">${crumbs.join('')}</div>
      <div style="flex:1"></div>
      <input id="fileFilter" class="field field-sm" type="text" placeholder="过滤当前目录..." value="${esc(state.fileFilter || '')}" autocomplete="off">
      <button class="btn btn-sm" id="btnUpload">↑ 上传文件</button>
      <button class="btn btn-sm" id="btnNewFolder">新建文件夹</button>
      <button class="btn btn-sm" id="btnNewFile">新建文件</button>
      <button class="btn btn-sm btn-ghost" id="btnRefreshFiles">刷新</button>
    </div>
    <div id="uploadBar" class="upload-bar hidden">
      <div class="upload-info muted" id="uploadInfo"></div>
      <div class="bar"><i id="uploadPct" style="width:0%"></i></div>
    </div>
    <div class="file-table-wrap glass" style="overflow:auto">
      <table class="file-table">
        <thead><tr>
          <th class="sortable" data-key="name">名称${arrow('name')}</th>
          <th>类型</th>
          <th class="sortable" data-key="size">大小${arrow('size')}</th>
          <th class="sortable" data-key="mtime">修改时间${arrow('mtime')}</th>
          <th style="text-align:right">操作</th>
        </tr></thead>
        <tbody id="fileRows">${rows || '<tr><td colspan="5" class="muted">' + (state.fileFilter ? '无匹配项' : '空目录') + '</td></tr>'}</tbody>
      </table>
    </div>
    <div class="muted" style="font-size:12px;margin-top:6px">共 ${list.length} 项${state.fileFilter ? `(过滤自 ${state.fileEntries.length} 项)` : ''}</div>`;

  // 面包屑
  $$('.crumb a', el).forEach(a => {
    a.onclick = () => { state.filePath = a.dataset.p; state.fileFilter = ''; renderFiles(); };
  });
  // 过滤(仅重绘表格主体,不重新请求)
  $('#fileFilter', el).oninput = (e) => {
    state.fileFilter = e.target.value.trim();
    const kw = state.fileFilter.toLowerCase();
    const view = fileView(state.fileEntries || []);
    const tb = $('#fileRows', el);
    tb.innerHTML = view.map(fileRowHtml).join('') || '<tr><td colspan="5" class="muted">无匹配项</td></tr>';
    bindFileNames(tb);
    bindFileActions(tb);
  };
  // 排序
  $$('th.sortable', el).forEach(th => {
    th.onclick = () => {
      const key = th.dataset.key;
      if (s.key === key) s.dir = -s.dir; else { state.fileSort = { key, dir: 1 }; }
      renderFileList(data);
    };
  });
  // 双击/点击文件名
  bindFileNames(el);
  // 操作按钮
  bindFileActions(el);

  $('#btnUpload', el).onclick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = () => { if (input.files.length) uploadFiles(Array.from(input.files)); };
    input.click();
  };
  $('#btnNewFolder', el).onclick = () => promptText('新建文件夹', '', '请输入文件夹名称', async (name) => {
    if (!name) return;
    try { await post(`/api/admin/instances/${state.currentId}/mkdir`, { path: joinPath(state.filePath, name) }); renderFiles(); }
    catch (e) { toast(e.message, 'err'); }
  });
  $('#btnNewFile', el).onclick = () => promptText('新建文件', '', '请输入文件名(含扩展名)', async (name) => {
    if (!name) return;
    try { await put(`/api/admin/instances/${state.currentId}/file?path=${encodeURIComponent(joinPath(state.filePath, name))}`, { content: '' }); renderFiles(); }
    catch (e) { toast(e.message, 'err'); }
  });
  $('#btnRefreshFiles', el).onclick = renderFiles;
}

// 文件列表单行 HTML(完整列表与过滤重绘共用,操作列保持一致)
function fileRowHtml(f) {
  const size = f.dir ? '—' : fmtBytes(f.size);
  const time = f.mtime ? new Date(f.mtime).toLocaleString('zh-CN', { hour12: false }) : '—';
  return `<tr>
    <td><span class="fname" data-kind="${f.dir ? 'dir' : 'file'}" data-name="${esc(f.name)}">${esc(f.name)}</span></td>
    <td>${f.dir ? '目录' : '文件'}</td>
    <td class="mono">${size}</td>
    <td class="muted" style="font-size:12px">${time}</td>
    <td><div class="factions">
      ${!f.dir ? `<button class="faction" data-act="download" data-name="${esc(f.name)}">下载</button>
      <button class="faction" data-act="edit" data-name="${esc(f.name)}">编辑</button>` : ''}
      ${f.img ? `<button class="faction" data-act="preview" data-name="${esc(f.name)}">预览</button>` : ''}
      ${!f.dir && (f.name.toLowerCase().endsWith('.zip') || f.name.toLowerCase().endsWith('.gz') || f.name.toLowerCase().endsWith('.tgz')) ? `<button class="faction" data-act="extract" data-name="${esc(f.name)}">解压</button>` : ''}
      <button class="faction" data-act="rename" data-name="${esc(f.name)}">重命名</button>
      <button class="faction del" data-act="delete" data-name="${esc(f.name)}">删除</button>
    </div></td>
  </tr>`;
}

// 绑定文件操作按钮(下载/编辑/预览/解压/重命名/删除);过滤重绘时复用
function bindFileActions(scope) {
  $$('.faction', scope).forEach(b => {
    b.onclick = async () => {
      const act = b.dataset.act;
      const name = b.dataset.name;
      const p = joinPath(state.filePath, name);
      if (act === 'download') window.location = `/api/admin/instances/${state.currentId}/download?path=${encodeURIComponent(p)}`;
      else if (act === 'edit') openFileEditor(name);
      else if (act === 'preview') previewImage(name);
      else if (act === 'extract') {
        if (await confirmDialog('解压文件', `将解压 ${name} 到当前目录,确认?`)) {
          try { await post(`/api/admin/instances/${state.currentId}/extract`, { path: p }); toast('解压完成', 'ok'); renderFiles(); }
          catch (e) { toast(e.message, 'err'); }
        }
      }
      else if (act === 'rename') openRename(name);
      else if (act === 'delete') {
        if (await confirmDialog('删除', `确定删除 ${name}?${name.endsWith('.zip') || name.endsWith('.jar') ? '' : ' 此操作不可恢复!'}`, true)) {
          try { await post(`/api/admin/instances/${state.currentId}/delete`, { path: p }); toast('已删除', 'ok'); renderFiles(); }
          catch (e) { toast(e.message, 'err'); }
        }
      }
    };
  });
}

// 绑定文件名点击(进入目录/打开编辑器);过滤重绘时复用
function bindFileNames(scope) {
  $$('.fname', scope).forEach(f => {
    f.onclick = () => {
      const name = f.dataset.name;
      if (f.dataset.kind === 'dir') {
        state.filePath = (state.filePath === '/' ? '' : state.filePath) + '/' + name;
        state.fileFilter = '';
        renderFiles();
      } else {
        openFileEditor(name);
      }
    };
  });
}

function joinPath(dir, name) {
  return (dir === '/' ? '' : dir) + '/' + name;
}

// 带进度的上传(XHR 支持上传进度;fetch 没有)
function uploadXHR(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { try { resolve(JSON.parse(xhr.responseText)); } catch { resolve(null); } }
      else {
        let m = '上传失败';
        try { m = JSON.parse(xhr.responseText).error || m; } catch {}
        reject(new Error(m));
      }
    };
    xhr.onerror = () => reject(new Error('网络错误'));
    xhr.send(file);
  });
}

// 多文件顺序上传,共享进度条
async function uploadFiles(files) {
  const el = $('#tabFiles');
  const bar = $('#uploadBar', el);
  const info = $('#uploadInfo', el);
  const pct = $('#uploadPct', el);
  if (!bar) return renderFiles();
  bar.classList.remove('hidden');
  let done = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    info.textContent = `上传 ${i + 1}/${files.length}:${f.name}(${fmtBytes(f.size)})`;
    pct.style.width = '0%';
    try {
      await uploadXHR(
        `/api/admin/instances/${state.currentId}/upload?path=${encodeURIComponent(state.filePath)}&filename=${encodeURIComponent(f.name)}`,
        f,
        (loaded, total) => { pct.style.width = Math.round(loaded / total * 100) + '%'; }
      );
      done++;
    } catch (e) {
      toast(`${f.name} 上传失败: ${e.message}`, 'err');
    }
  }
  bar.classList.add('hidden');
  if (done > 0) toast(`已上传 ${done}/${files.length} 个文件`, 'ok');
  renderFiles();
}

function uploadFile(file) { return uploadFiles([file]); }

// 图片预览(同源 <img>,自动携带会话)
function previewImage(name) {
  const url = `/api/admin/instances/${state.currentId}/download?path=${encodeURIComponent(joinPath(state.filePath, name))}`;
  const { modal } = openModal(`
    <h3>${esc(name)}</h3>
    <div class="img-preview"><img src="${url}" alt="${esc(name)}" loading="lazy" decoding="async" data-err="msg"></div>
    <div class="modal-actions"><button class="btn" id="pvClose">关闭</button></div>`);
  $('#pvClose', modal).onclick = closeModal;
}

function openFileEditor(name) {
  const p = joinPath(state.filePath, name);
  let dirty = false;
  const { modal } = openModal(`
    <h3>编辑 ${esc(name)} <span id="feMeta" class="muted" style="font-size:12px;font-weight:400"></span></h3>
    <textarea id="fileEditor" class="field file-editor" spellcheck="false"></textarea>
    <div class="modal-actions">
      <span id="feState" class="muted" style="flex:1;text-align:left;font-size:12px"></span>
      <button class="btn" id="feCancel">关闭</button>
      <button class="btn btn-primary" id="feSave">保存 (Ctrl+S)</button>
    </div>`);
  const ta = $('#fileEditor', modal);
  const meta = $('#feMeta', modal);
  const stateEl = $('#feState', modal);
  const saveBtn = $('#feSave', modal);

  const updateMeta = () => {
    const lines = ta.value ? ta.value.split('\n').length : 0;
    const size = new Blob([ta.value]).size;
    meta.textContent = `· ${lines} 行 · ${fmtBytes(size)}`;
  };
  const markDirty = () => {
    if (!dirty) { dirty = true; stateEl.textContent = '● 未保存'; }
    updateMeta();
  };

  const save = async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中...';
    try {
      await put(`/api/admin/instances/${state.currentId}/file?path=${encodeURIComponent(p)}`, { content: ta.value });
      dirty = false;
      stateEl.textContent = '已保存 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
      toast('已保存', 'ok');
    } catch (e) { toast(e.message, 'err'); }
    saveBtn.disabled = false;
    saveBtn.textContent = '保存 (Ctrl+S)';
  };

  saveBtn.onclick = save;
  $('#feCancel', modal).onclick = async () => {
    // 有未保存改动时确认,防误关丢失
    if (dirty && !(await confirmDialog('放弃修改', '有未保存的修改,确定放弃并关闭?', true))) return;
    closeModal();
  };
  ta.addEventListener('input', markDirty);
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
    if (e.key === 'Tab') {
      // Tab 插入两个空格,保持缩进习惯
      e.preventDefault();
      ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
      markDirty();
    }
  });

  stateEl.textContent = '加载中...';
  get(`/api/admin/instances/${state.currentId}/file?path=${encodeURIComponent(p)}`)
    .then(d => {
      ta.value = d.content ?? '';
      dirty = false;
      stateEl.textContent = '';
      updateMeta();
      ta.focus();
    })
    .catch(e => { toast(e.message, 'err'); closeModal(); });
}

function openRename(name) {
  promptText('重命名', name, '请输入新名称', async (newName) => {
    if (!newName || newName === name) return;
    try {
      await post(`/api/admin/instances/${state.currentId}/rename`, { path: joinPath(state.filePath, name), newName });
      renderFiles();
    } catch (e) { toast(e.message, 'err'); }
  });
}

function promptText(title, value, hint, onOk) {
  const { modal } = openModal(`
    <h3>${esc(title)}</h3>
    <input id="ptInput" class="field" type="text" value="${esc(value)}" style="width:100%">
    <div class="hint">${esc(hint)}</div>
    <div class="modal-actions">
      <button class="btn" id="ptCancel">取消</button>
      <button class="btn btn-primary" id="ptOk">确定</button>
    </div>`);
  const input = $('#ptInput', modal);
  input.focus(); input.select();
  $('#ptCancel', modal).onclick = closeModal;
  const done = () => { const v = input.value.trim(); closeModal(); onOk(v); };
  $('#ptOk', modal).onclick = done;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); });
}

/* ---------- 可视化配置 Tab ---------- */
// server.properties 键名汉化(参考 MCSM 风格;未收录的键显示英文原名)
const PROP_LABELS = {
  'server-ip': { label: '服务器 IP', hint: '留空=监听所有网卡' },
  'server-port': { label: '服务器端口', hint: '玩家连接端口,默认 25565' },
  'online-mode': { label: '正版验证', hint: '开启后仅正版账号可进入' },
  'white-list': { label: '白名单', hint: '开启后仅白名单玩家可进入' },
  'enforce-whitelist': { label: '强制白名单', hint: '自动踢出不在白名单的玩家' },
  'max-players': { label: '最大玩家数' },
  'view-distance': { label: '视距(区块)', hint: '服务器向玩家发送的区块范围' },
  'simulation-distance': { label: '模拟距离', hint: '服务器模拟活动的区块范围' },
  'render-distance': { label: '渲染距离' },
  'motd': { label: '服务器欢迎语 (MOTD)', hint: '服务器列表显示的标语' },
  'difficulty': { label: '难度', hint: 'peaceful/休闲 easy/简单 normal/普通 hard/困难' },
  'gamemode': { label: '默认游戏模式', hint: 'survival/生存 creative/创造 adventure/冒险 spectator/旁观' },
  'pvp': { label: '允许 PVP', hint: '玩家间互相伤害' },
  'allow-flight': { label: '允许飞行', hint: '开启后不会被飞行检测踢出' },
  'allow-nether': { label: '允许下界' },
  'spawn-monsters': { label: '生成怪物' },
  'spawn-animals': { label: '生成动物' },
  'spawn-npcs': { label: '生成村民' },
  'spawn-protection': { label: '出生点保护半径', hint: '出生点周围不可破坏的方块范围' },
  'generate-structures': { label: '生成结构', hint: '村庄、神殿等建筑' },
  'level-name': { label: '世界文件夹名' },
  'level-seed': { label: '世界种子' },
  'level-type': { label: '世界类型', hint: 'default/默认 flat/超平坦' },
  'hardcore': { label: '极限模式', hint: '死亡即封禁' },
  'enable-command-block': { label: '启用命令方块' },
  'enable-query': { label: '启用 Query', hint: '开启后在线玩家列表可完整获取' },
  'query.port': { label: 'Query 端口' },
  'enable-rcon': { label: '启用 RCON', hint: '远程控制协议' },
  'rcon.port': { label: 'RCON 端口' },
  'rcon.password': { label: 'RCON 密码' },
  'enable-status': { label: '服务器列表显示', hint: '在服务器列表中可见' },
  'hide-online-players': { label: '隐藏玩家列表' },
  'enforce-secure-profile': { label: '强制安全档案', hint: '要求玩家使用安全的皮肤档案' },
  'prevent-proxy-connections': { label: '禁止代理连接' },
  'use-native-transport': { label: '原生传输', hint: 'Linux 下提升网络性能' },
  'network-compression-threshold': { label: '网络压缩阈值', hint: '-1=禁用压缩' },
  'max-tick-time': { label: '最大 Tick 时间(ms)', hint: '-1=不限制,超时自动重启' },
  'entity-broadcast-range-percentage': { label: '实体广播范围(%)' },
  'tick-rate': { label: 'Tick 速率', hint: '默认 3' },
  'player-idle-timeout': { label: '挂机踢出时间(分)', hint: '0=不踢出' },
  'op-permission-level': { label: 'OP 权限等级', hint: '1-4,4=最高' },
  'function-permission-level': { label: '函数权限等级' },
  'rate-limit': { label: '聊天速率限制' },
  'max-world-size': { label: '最大世界半径', hint: '0-29999984' },
  'max-build-height': { label: '最大建筑高度' },
  'sync-chunk-writes': { label: '同步区块写入', hint: '防止区块数据丢失' },
  'snooper-enabled': { label: '遥测数据上报' },
  'broadcast-rcon-to-ops': { label: 'RCON 指令广播给 OP' },
  'broadcast-console-to-ops': { label: '控制台指令广播给 OP' },
  'spawn-tnt-explosion-decay': { label: 'TNT 爆炸衰减' }
};

// 标准 server.properties 默认值(文件缺失时按此显示,保存时一并写入)
const PROP_DEFAULTS = {
  'server-ip': '', 'server-port': '25565', 'online-mode': 'true',
  'motd': '我的世界服务器', 'max-players': '20', 'max-world-size': '29999984',
  'max-build-height': '256', 'view-distance': '10', 'simulation-distance': '10',
  'render-distance': '10', 'spawn-protection': '16', 'tick-rate': '3',
  'difficulty': 'normal', 'gamemode': 'survival', 'level-type': 'default',
  'level-name': 'world', 'level-seed': '', 'generate-structures': 'true',
  'allow-nether': 'true', 'allow-flight': 'false', 'spawn-npcs': 'true',
  'spawn-monsters': 'true', 'spawn-animals': 'true', 'pvp': 'true',
  'hardcore': 'false', 'enable-command-block': 'false', 'enable-status': 'true',
  'enable-query': 'false', 'query.port': '25565', 'enable-rcon': 'false',
  'rcon.port': '25575', 'rcon.password': '', 'broadcast-console-to-ops': 'true',
  'broadcast-rcon-to-ops': 'true', 'op-permission-level': '4', 'function-permission-level': '2',
  'player-idle-timeout': '0', 'enforce-secure-profile': 'true', 'prevent-proxy-connections': 'false',
  'hide-online-players': 'false', 'max-tick-time': '60000', 'network-compression-threshold': '256',
  'rate-limit': '0', 'sync-chunk-writes': 'true', 'entity-broadcast-range-percentage': '100',
  'use-native-transport': 'true', 'white-list': 'false', 'enforce-whitelist': 'false',
  'spawn-tnt-explosion-decay': 'true'
};

const PROP_META = {
  boolean: new Set(['online-mode', 'white-list', 'enforce-whitelist', 'spawn-monsters', 'spawn-animals',
    'generate-structures', 'allow-flight', 'enable-command-block', 'hardcore', 'enable-query', 'enable-rcon',
    'snooper-enabled', 'hide-online-players', 'enforce-secure-profile', 'prevent-proxy-connections',
    'use-native-transport', 'sync-chunk-writes', 'pvp', 'allow-nether', 'spawn-npcs', 'broadcast-rcon-to-ops',
    'broadcast-console-to-ops', 'enable-status', 'spawn-tnt-explosion-decay']),
  enum: {
    gamemode: ['survival', 'creative', 'adventure', 'spectator'],
    difficulty: ['peaceful', 'easy', 'normal', 'hard'],
    'level-type': ['default', 'flat', 'largebiomes', 'amplified', 'single_biome_surface'],
    'render-distance': ['2', '3', '4', '5', '6', '8', '10', '12', '14', '16', '20', '24', '28', '32'],
    'view-distance': ['2', '3', '4', '5', '6', '8', '10', '12', '14', '16', '20', '24', '28', '32'],
    'simulation-distance': ['4', '5', '6', '8', '10', '12', '14', '16', '20', '24'],
    'max-players': ['5', '10', '20', '30', '50', '100', '200', '500', '1000'],
    'spawn-protection': ['0', '1', '5', '10', '16', '32'],
    'op-permission-level': ['0', '1', '2', '3', '4'],
    'function-permission-level': ['0', '1', '2', '3', '4'],
    'network-compression-threshold': ['-1', '128', '256', '512', '1024'],
    'max-tick-time': ['-1', '60000', '120000', '300000'],
    'entity-broadcast-range-percentage': ['10', '25', '50', '75', '100', '150', '200'],
    'tick-rate': ['1', '2', '3', '4', '5', '10', '20']
  }
};

async function renderConfig() {
  const el = $('#tabConfig');
  el.innerHTML = '<div class="muted">加载中...</div>';
  try {
    const data = await get(`/api/admin/instances/${state.currentId}/properties`);
    const ins = await get(`/api/admin/instances/${state.currentId}/config`);
    renderConfigForm(data, ins.config);
  } catch (e) {
    el.innerHTML = `<div class="muted">${esc(e.message)}</div>`;
  }
}

function renderConfigForm(props, cfg) {
  const el = $('#tabConfig');
  const curIp = props.props['server-ip'] || '';
  const curPort = props.props['server-port'] || '25565';
  const entries = Object.entries(props.props).sort((a, b) => a[0].localeCompare(b[0]));
  const groups = [
    { title: '网络与绑定', keys: ['server-ip', 'server-port', 'online-mode', 'enable-query', 'query.port', 'enable-rcon', 'rcon.port', 'rcon.password', 'broadcast-console-to-ops', 'broadcast-rcon-to-ops', 'enforce-secure-profile', 'prevent-proxy-connections', 'use-native-transport', 'network-compression-threshold', 'enable-status'] },
    { title: '玩家与白名单', keys: ['max-players', 'white-list', 'enforce-whitelist', 'hide-online-players', 'op-permission-level', 'function-permission-level', 'player-idle-timeout', 'rate-limit'] },
    { title: '游戏规则', keys: ['gamemode', 'difficulty', 'level-type', 'level-name', 'level-seed', 'motd', 'pvp', 'allow-flight', 'allow-nether', 'spawn-monsters', 'spawn-animals', 'spawn-npcs', 'spawn-protection', 'generate-structures', 'hardcore', 'enable-command-block', 'spawn-tnt-explosion-decay'] },
    { title: '性能与世界', keys: ['view-distance', 'simulation-distance', 'render-distance', 'max-tick-time', 'entity-broadcast-range-percentage', 'tick-rate', 'sync-chunk-writes', 'max-world-size', 'max-build-height'] },
    { title: '其他', keys: [] }
  ];
  const known = new Set(groups.flatMap(g => g.keys));
  const rest = entries.filter(([k]) => !known.has(k));
  groups[groups.length - 1].keys = rest.map(([k]) => k);

  const renderGroup = (g) => {
    const items = g.keys.filter(k => props.props[k] !== undefined || PROP_DEFAULTS[k] !== undefined).map(k => {
      const v = props.props[k] !== undefined ? props.props[k] : PROP_DEFAULTS[k];
      const meta = PROP_LABELS[k] || {};
      const title = meta.hint ? ` title="${esc(meta.hint)}"` : '';
      const labelHtml = `<label${title}><span class="cfg-label">${esc(meta.label || k)}</span>${meta.label ? `<span class="cfg-key">${esc(k)}</span>` : ''}</label>`;
      if (PROP_META.boolean.has(k)) {
        return `<div class="cfg-item">${labelHtml}<input type="checkbox" data-key="${esc(k)}" ${v === 'true' ? 'checked' : ''}></div>`;
      }
      const opts = PROP_META.enum[k];
      if (opts) {
        return `<div class="cfg-item">${labelHtml}<select data-key="${esc(k)}">${opts.map(o => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></div>`;
      }
      if (/^\d+$/.test(v)) {
        return `<div class="cfg-item">${labelHtml}<input type="number" data-key="${esc(k)}" value="${esc(v)}"></div>`;
      }
      return `<div class="cfg-item">${labelHtml}<input type="text" data-key="${esc(k)}" value="${esc(v)}"></div>`;
    }).join('');
    if (!items) return '';
    return `<div class="cfg-section"><div class="ov-title">${g.title}</div><div class="card"><div class="cfg-grid">${items}</div></div></div>`;
  };

  // 实例设置(Java / 内存 / jar / eula / 自启)
  const memOptions = ['512M', '1024M', '2048M', '3072M', '4096M', '6144M', '8192M', '12288M', '16384M'];
  const jarOpts = props.jars && props.jars.length ? props.jars : [];
  const memSel = (cur, id) => memOptions.map(o => `<option ${o === cur ? 'selected' : ''}>${o}</option>`).join('') + (memOptions.includes(cur) ? '' : `<option selected>${esc(cur)}</option>`);

  el.innerHTML = `
    <div class="cfg-section">
      <div class="ov-title">实例设置 (Java / 内存 / 启动参数)</div>
      <div class="card">
        <div class="cfg-grid">
          <div class="cfg-item"><label>Java 路径</label><select id="cfgJavaSel">
            <option value="" ${!cfg.javaPath ? 'selected' : ''}>自动 (按服务器版本)</option>
            ${state.java.map(j => `<option value="${esc(j.path)}" ${cfg.javaPath === j.path ? 'selected' : ''}>${esc(j.label)}</option>`).join('')}
          </select></div>
          <div class="cfg-item"><label>初始内存 (-Xms)</label><select id="cfgXms">${memSel(cfg.xms, 'xms')}</select></div>
          <div class="cfg-item"><label>最大内存 (-Xmx)</label><select id="cfgXmx">${memSel(cfg.xmx, 'xmx')}</select></div>
          <div class="cfg-item" style="grid-column:1/-1"><label>额外 JVM 参数</label><input type="text" id="cfgJvm" value="${esc(cfg.jvmArgs)}" placeholder="如: -XX:+UseG1GC -XX:+ParallelRefProcEnabled"></div>
          <div class="cfg-item"><label>服务端 jar</label><select id="cfgJar">
            <option value="">自动检测</option>
            ${jarOpts.map(j => `<option value="${esc(j)}" ${cfg.serverJar === j ? 'selected' : ''}>${esc(j)}</option>`).join('')}
          </select></div>
          <div class="cfg-item"><label>绑定 IP</label><select id="cfgIp">${ipOptions(curIp)}</select></div>
          <div class="cfg-item"><label>端口</label><input type="number" id="cfgPort" value="${esc(curPort)}" min="1" max="65535"></div>
          <div class="cfg-item"><label>同意 EULA (自动写入 eula=true)</label><input type="checkbox" id="cfgEula" ${cfg.eula ? 'checked' : ''}></div>
          <div class="cfg-item"><label>面板启动时自动开启</label><input type="checkbox" id="cfgAutoStart" ${cfg.autoStart ? 'checked' : ''}></div>
        </div>
        <div style="margin-top:14px;display:flex;gap:10px">
          <button class="btn btn-primary btn-sm" id="btnSaveInstanceCfg">保存实例设置</button>
          <span class="muted" style="font-size:12px;align-self:center">已检测 Java: ${state.java.length ? state.java.map(j => 'Java ' + j.major).join(' / ') : '无'}</span>
        </div>
      </div>
    </div>

    <div class="cfg-section">
      <div class="ov-title">server.properties 可视化配置 <span class="muted" style="font-weight:400;font-size:12px">修改后保存</span></div>
      <div id="cfgPropsGroups">${groups.map(renderGroup).join('')}</div>
      <div style="display:flex;gap:10px;align-items:center">
        <button class="btn btn-primary" id="btnSaveProps">保存全部配置</button>
        <button class="btn" id="btnAddKey">+ 添加自定义配置项</button>
        <span id="cfgSaveHint" class="muted" style="font-size:12px">重启生效</span>
      </div>
    </div>`;

  $('#btnSaveInstanceCfg', el).onclick = async () => {
    const body = {
      javaRequirement: 'auto',
      javaPath: $('#cfgJavaSel', el).value,
      xms: $('#cfgXms', el).value,
      xmx: $('#cfgXmx', el).value,
      jvmArgs: $('#cfgJvm', el).value.trim(),
      serverJar: $('#cfgJar', el).value,
      eula: $('#cfgEula', el).checked,
      autoStart: $('#cfgAutoStart', el).checked
    };
    try {
      await put(`/api/admin/instances/${state.currentId}/config`, body);
      // 同时保存 IP 绑定到 server.properties
      await put(`/api/admin/instances/${state.currentId}/properties`, {
        patch: { 'server-ip': $('#cfgIp', el).value, 'server-port': $('#cfgPort', el).value || '25565' }
      });
      toast('实例设置已保存', 'ok');
      refreshOverview();
    } catch (e) { toast(e.message, 'err'); }
  };

  $('#btnSaveProps', el).onclick = async () => {
    const patch = {};
    $$('[data-key]', el).forEach(input => {
      const k = input.dataset.key;
      if (input.type === 'checkbox') patch[k] = input.checked ? 'true' : 'false';
      else patch[k] = input.value;
    });
    try {
      await put(`/api/admin/instances/${state.currentId}/properties`, { patch });
      toast('配置已保存', 'ok');
      refreshOverview();
    } catch (e) { toast(e.message, 'err'); }
  };

  upgradeSelects(el);

  $('#btnAddKey', el).onclick = () => promptText('添加配置项', '', '格式: 键名=值,如 max-entity-cramming=25', async (kv) => {
    if (!kv || !kv.includes('=')) return;
    const idx = kv.indexOf('=');
    const k = kv.slice(0, idx).trim();
    const v = kv.slice(idx + 1).trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(k)) return toast('非法键名', 'err');
    try {
      await put(`/api/admin/instances/${state.currentId}/properties`, { patch: { [k]: v } });
      toast('已添加', 'ok');
      renderConfig();
    } catch (e) { toast(e.message, 'err'); }
  });
}

/* ---------- 实例设置弹窗 ---------- */
async function openInstanceSettings(id) {
  try {
    const data = await get(`/api/admin/instances/${id}/config`);
    const cfg = data.config;
    // 读取当前 IP/端口 与 扫描到的 jar 列表
    let curIp = '', curPort = '25565', jars = [];
    try {
      const p = await get(`/api/admin/instances/${id}/properties`);
      curIp = p.props['server-ip'] || '';
      curPort = p.props['server-port'] || '25565';
      jars = p.jars || [];
    } catch { }
    const ipOpts = ipOptions(curIp);
    const jarOptions = `<option value="" ${!cfg.serverJar ? 'selected' : ''}>自动检测</option>` +
      jars.map(j => `<option value="${esc(j)}" ${cfg.serverJar === j ? 'selected' : ''}>${esc(j)}</option>`).join('') +
      (cfg.serverJar && !jars.includes(cfg.serverJar) ? `<option value="${esc(cfg.serverJar)}" selected>${esc(cfg.serverJar)} (文件已不存在)</option>` : '');
    const { modal } = openModal(`
      <h3>实例设置 — ${esc(cfg.name)}</h3>
      <label class="field"><span>实例名称</span><input id="isName" type="text" value="${esc(cfg.name)}"></label>
      <label class="field"><span>绑定 IP</span><select id="isIp">${ipOpts}</select><div class="hint">留空=不绑定</div></label>
      <label class="field"><span>端口</span><input id="isPort" type="number" value="${esc(curPort)}" min="1" max="65535"></label>
      <label class="field"><span>指定 Java</span><select id="isJavaSel">
        <option value="" ${!cfg.javaPath ? 'selected' : ''}>自动 (按服务器版本)</option>
        ${state.java.map(j => `<option value="${esc(j.path)}" ${cfg.javaPath === j.path ? 'selected' : ''}>${esc(j.label)}</option>`).join('')}
      </select><div class="hint">留空=自动</div></label>
      <label class="field"><span>初始内存 -Xms</span><select id="isXms">${['512M','1024M','2048M','4096M','8192M'].map(o => `<option ${cfg.xms === o ? 'selected' : ''}>${o}</option>`).join('')}</select></label>
      <label class="field"><span>最大内存 -Xmx</span><select id="isXmx">${['1024M','2048M','4096M','8192M','16384M'].map(o => `<option ${cfg.xmx === o ? 'selected' : ''}>${o}</option>`).join('')}</select></label>
      <label class="field"><span>额外 JVM 参数</span><input id="isJvm" type="text" value="${esc(cfg.jvmArgs)}" placeholder="-XX:+UseG1GC"></label>
      <label class="field"><span>服务端 jar</span><select id="isJar">${jarOptions}</select><div class="hint">已扫描目录下 ${jars.length} 个 jar,自动检测为最佳匹配</div></label>
      <label class="field" style="display:flex;align-items:center;gap:10px"><input id="isEula" type="checkbox" ${cfg.eula ? 'checked' : ''}> 同意 EULA</label>
      <label class="field" style="display:flex;align-items:center;gap:10px"><input id="isAutoStart" type="checkbox" ${cfg.autoStart ? 'checked' : ''}> 面板启动时自动开启</label>
      <div class="modal-actions">
        <button class="btn" id="isCancel">取消</button>
        <button class="btn btn-primary" id="isSave">保存</button>
      </div>`);
    upgradeSelects(modal);
    $('#isCancel', modal).onclick = closeModal;
    $('#isSave', modal).onclick = async () => {
      try {
        await put(`/api/admin/instances/${id}/config`, {
          name: $('#isName', modal).value.trim(),
          javaRequirement: 'auto',
          javaPath: $('#isJavaSel', modal).value,
          xms: $('#isXms', modal).value,
          xmx: $('#isXmx', modal).value,
          jvmArgs: $('#isJvm', modal).value.trim(),
          serverJar: $('#isJar', modal).value.trim(),
          eula: $('#isEula', modal).checked,
          autoStart: $('#isAutoStart', modal).checked
        });
        // 保存 IP 绑定
        await put(`/api/admin/instances/${id}/properties`, {
          patch: { 'server-ip': $('#isIp', modal).value, 'server-port': $('#isPort', modal).value || '25565' }
        });
        toast('已保存,IP 绑定重启服务器后生效', 'ok');
        closeModal();
        refreshOverview();
      } catch (e) { toast(e.message, 'err'); }
    };
  } catch (e) { toast(e.message, 'err'); }
}

/* ---------- 新建 / 导入 ---------- */
$('#btnAddInstance').onclick = openImportWizard;

function openImportWizard() {
  const { modal } = openModal(`
    <h3>新建 / 导入整合包</h3>
    <label class="field"><span>实例名称</span><input id="iwName" type="text" placeholder="如: 我的生存服"></label>
    <div class="ov-title" style="margin-top:8px">方式一:上传整合包文件 (.zip / .tar.gz)</div>
    <div class="upload-drop" id="iwDrop">
      <div style="font-size:13px;margin:6px 0">点击或拖拽选择文件</div>
      <div class="muted" style="font-size:12px" id="iwFileInfo">未选择文件</div>
    </div>
    <div class="divider"></div>
    <div class="ov-title">方式二:从服务器本地路径导入</div>
    <label class="field"><span>本机文件路径</span><input id="iwPath" type="text" placeholder="如: C:\\Users\\Administrator\\Downloads\\pack.zip"></label>
    <div class="modal-actions">
      <button class="btn" id="iwCancel">取消</button>
      <button class="btn btn-primary" id="iwGo">开始导入</button>
    </div>`);

  let file = null;
  const drop = $('#iwDrop', modal);
  const fileInfo = $('#iwFileInfo', modal);
  const pick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,.tar.gz,.tgz,.jar';
    input.onchange = () => { file = input.files[0]; fileInfo.textContent = file ? `${file.name} (${fmtBytes(file.size)})` : '未选择文件'; };
    input.click();
  };
  drop.onclick = pick;
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('drag'); };
  drop.ondragleave = () => drop.classList.remove('drag');
  drop.ondrop = (e) => {
    e.preventDefault(); drop.classList.remove('drag');
    if (e.dataTransfer.files[0]) { file = e.dataTransfer.files[0]; fileInfo.textContent = `${file.name} (${fmtBytes(file.size)})`; }
  };

  $('#iwCancel', modal).onclick = closeModal;
  $('#iwGo', modal).onclick = async () => {
    const name = $('#iwName', modal).value.trim();
    if (!name) return toast('请输入实例名称', 'err');
    const btn = $('#iwGo', modal);
    btn.disabled = true; btn.textContent = '导入中...';
    try {
      if (file) {
        await post(`/api/admin/instances/import?name=${encodeURIComponent(name)}`, undefined, file);
      } else {
        const p = $('#iwPath', modal).value.trim();
        if (!p) return toast('请选择上传文件或填写本地路径', 'err');
        await post(`/api/admin/instances/import?name=${encodeURIComponent(name)}&path=${encodeURIComponent(p)}`);
      }
      toast('整合包导入成功', 'ok');
      closeModal();
      await refreshAll();
    } catch (e) {
      toast('导入失败: ' + e.message, 'err');
      btn.disabled = false; btn.textContent = '开始导入';
    }
  };
}

async function refreshAll() {
  const data = await get('/api/admin/overview');
  state.instances = data.instances || [];
  state.java = data.java || [];
  state.lanIPs = data.lanIPs || [];
  state.panel = data.panel || {};
  state.ipList = (data.panel && data.panel.ipList) || [];
  applyGlass(state.panel.glassColor, state.panel.glassOpacity);
  applyPanelBg(state.panel);
  renderSidebar();
  if (state.instances.length > 0) {
    selectInstance(state.instances[0].id);
  }
}

/* ---------- Java 页 ---------- */
async function renderJavaPage() {
  const el = $('#pageJava');
  el.innerHTML = `<div class="card"><div class="muted">正在扫描 Java...</div></div>`;
  try {
    const data = await get('/api/admin/java');
    state.java = data.java || [];
    renderJavaList(el);
  } catch (e) { el.innerHTML = `<div class="card"><div class="muted">${esc(e.message)}</div></div>`; }
}

function renderJavaList(el) {
  const list = state.java.length ? state.java.map(j => `
    <div class="kv"><span class="k">${esc(j.label)}</span><span class="v">${j.major} · ${esc(j.path)}</span></div>`).join('')
    : '<div class="hero-empty muted">未检测到 Java,请安装 Java 8 / 17 / 21 或手动指定路径</div>';
  el.innerHTML = `
    <div class="ov-title">Java 运行时</div>
    <div class="card">
      ${list}
      <div style="margin-top:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-primary btn-sm" id="jpRescan">重新扫描</button>
        <button class="btn btn-sm" id="jpDeep">深度查找</button>
        <span class="muted" style="font-size:12px" id="jpHint">快速:注册表·常见目录·PATH·环境变量</span>
      </div>
    </div>`;
  $('#jpRescan', el).onclick = async () => {
    try {
      const data = await post('/api/admin/java/scan');
      state.java = data.java || [];
      renderJavaList(el);
      toast('扫描完成,发现 ' + state.java.length + ' 个 Java', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
  // 深度查找:全盘遍历 + 注册表,后台异步执行并轮询
  $('#jpDeep', el).onclick = async () => {
    const btn = $('#jpDeep', el);
    const hint = $('#jpHint', el);
    try {
      await post('/api/admin/java/deep');
      btn.disabled = true;
      btn.textContent = '深度查找中...';
      hint.textContent = '深度:全盘遍历·注册表·PATH·环境变量(较慢,请稍候)';
      const poll = setInterval(async () => {
        try {
          const st = await get('/api/admin/java/status');
          if (!st.scanning) {
            clearInterval(poll);
            state.java = st.java || [];
            renderJavaList(el);
            toast('深度查找完成,发现 ' + state.java.length + ' 个 Java', 'ok');
          }
        } catch { clearInterval(poll); }
      }, 2000);
    } catch (e) { toast(e.message, 'err'); }
  };
}

/* ---------- IP 管理页 ---------- */
function renderIpPage(silent) {
  const el = $('#pageIp');
  const ips = state.ipList || [];
  const insts = state.instances || [];
  const rows = insts.map(i => `
    <tr>
      <td>${esc(i.name)}</td>
      <td class="mono">${esc(i.ip || '未绑定')}</td>
      <td class="mono">${i.port}</td>
      <td>
        <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
          <select class="ipSel" data-id="${esc(i.id)}">${ipOptions(i.ip)}</select>
          <input type="number" class="ipPort" data-id="${esc(i.id)}" value="${i.port}" min="1" max="65535">
          <button class="btn btn-sm btn-primary ipSave" data-id="${esc(i.id)}">保存</button>
        </div>
      </td>
    </tr>`).join('');
  el.innerHTML = `
    <div class="ov-title">IP 管理</div>
    <div class="card">
      <div class="ov-title" style="margin-top:0">IP 池(实例绑定时只能从这里选择)</div>
      ${ips.length ? ips.map(ip => `
        <div class="ip-chip">${esc(ip)}<span class="copy del" data-ip="${esc(ip)}">删除</span></div>`).join('')
        : '<div class="hero-empty muted">尚未添加 IP,请先添加</div>'}
      <div style="margin-top:12px;display:flex;gap:8px;align-items:center">
        <input id="ipAdd" type="text" placeholder="如: 192.168.1.100" style="width:180px;padding:8px 12px;border-radius:10px;border:1px solid var(--glass-border);background:rgba(0,0,0,.3);color:var(--text);backdrop-filter:blur(10px)">
        <button class="btn btn-primary btn-sm" id="ipAddBtn">+ 添加 IP</button>
      </div>
      <div class="hint" style="margin-top:10px">写入 server.properties,重启生效</div>
    </div>
    <div class="ov-title">实例 IP 绑定</div>
    <div class="card">
      ${insts.length ? `
      <div class="file-table-wrap glass" style="overflow:auto">
        <table class="file-table">
          <thead><tr><th>实例</th><th>当前绑定</th><th>端口</th><th style="text-align:right">修改</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`
      : '<div class="hero-empty muted">暂无实例,请先到「实例管理」创建或导入整合包</div>'}
    </div>`;
  // 添加 IP
  $('#ipAddBtn', el).onclick = async () => {
    const input = $('#ipAdd', el);
    const ip = input.value.trim();
    if (!ip) return toast('请输入 IP', 'err');
    try {
      const data = await post('/api/admin/ips', { ip });
      state.ipList = data.ipList || [];
      renderIpPage();
      toast('已添加 ' + ip, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#ipAdd', el).addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#ipAddBtn', el).click(); });
  // 删除 IP
  $$('.ip-chip .copy.del', el).forEach(c => c.onclick = async () => {
    const ip = c.dataset.ip;
    const inUse = insts.some(i => i.ip === ip);
    if (!await confirmDialog('删除 IP', `确定从 IP 池删除 ${ip}?${inUse ? ' \n注意:有实例正在使用该 IP,删除后其绑定值保留但不再出现在下拉列表中。' : ''}`, true)) return;
    try {
      const data = await del('/api/admin/ips/' + encodeURIComponent(ip));
      state.ipList = data.ipList || [];
      renderIpPage();
      toast('已删除 ' + ip, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  });
  // 保存绑定
  $$('.ipSave', el).forEach(b => b.onclick = async () => {
    const id = b.dataset.id;
    const sel = $(`.ipSel[data-id="${id}"]`, el);
    const port = $(`.ipPort[data-id="${id}"]`, el).value;
    try {
      await put(`/api/admin/instances/${id}/properties`, { patch: { 'server-ip': sel.value, 'server-port': String(port || 25565) } });
      toast('已保存,重启生效', 'ok');
      refreshOverview();
    } catch (e) { toast(e.message, 'err'); }
  });
  upgradeSelects(el);
}

/* ---------- 设置页(外观 / 账号 / 关于 子标签) ---------- */
function renderSettingsPage() {
  const el = $('#pageSettings');
  el.innerHTML = `
    <div class="tabs glass" style="position:static">
      <button class="tab active" data-stab="appearance">外观与背景</button>
      <button class="tab" data-stab="account">账号与用户</button>
      <button class="tab" data-stab="about">关于与更新</button>
    </div>
    <div id="stabAppearance"></div>
    <div id="stabAccount" class="hidden"></div>
    <div id="stabAbout" class="hidden"></div>`;
  $$('.tab', el).forEach(t => {
    t.onclick = () => {
      $$('.tab', el).forEach(x => x.classList.toggle('active', x === t));
      $('#stabAppearance', el).classList.toggle('hidden', t.dataset.stab !== 'appearance');
      $('#stabAccount', el).classList.toggle('hidden', t.dataset.stab !== 'account');
      $('#stabAbout', el).classList.toggle('hidden', t.dataset.stab !== 'about');
      if (t.dataset.stab === 'appearance') renderAppearancePage($('#stabAppearance', el));
      if (t.dataset.stab === 'account') renderAccountPage($('#stabAccount', el));
      if (t.dataset.stab === 'about') renderAboutPage($('#stabAbout', el));
    };
  });
  renderAppearancePage($('#stabAppearance', el));
}

/* ---------- 外观页 ---------- */
function renderAppearancePage(el) {
  if (!el) return;
  const bg = state.panel.background || '';   // 空 = 用默认渐变背景
  const hero = state.panel.heroTitle !== undefined ? state.panel : { heroTitle: '', heroSlogan: '', heroImage: '' };
  el.innerHTML = `
    <div class="ov-title">首页展示设置 (A 标题 / B 图片 / C 标语)</div>
    <div class="card">
      <label class="field"><span>A · 首页标题(留空=自动显示实例名)</span><input id="hpTitle" type="text" value="${esc(hero.heroTitle || '')}" placeholder="如: 我的世界生存服" maxlength="60"></label>
      <label class="field"><span>C · 首页标语(留空=自动显示服务器 MOTD)</span><input id="hpSlogan" type="text" value="${esc(hero.heroSlogan || '')}" placeholder="如: 欢迎来到我们的世界" maxlength="120"></label>
      <div class="ov-title" style="margin:6px 0 8px;font-size:13.5px">B · 首页图片(留空=跟随背景)</div>
      <div style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">
        <div style="width:220px;border-radius:12px;overflow:hidden;border:1px solid var(--glass-border);flex-shrink:0">
          ${hero.heroImage
            ? `<img id="hpPreview" src="/hero?v=${Date.now()}" style="width:100%;aspect-ratio:16/10;object-fit:cover;display:block" loading="lazy" decoding="async" data-err="hide">`
            : `<div id="hpPreview" class="bg-preview no-img" style="aspect-ratio:16/10;border:0"></div>`}
        </div>
        <div style="flex:1;min-width:220px">
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <button class="btn btn-primary btn-sm" id="hpUpload">↑ 上传首页图片</button>
            <button class="btn btn-sm" id="hpClear">清除(跟随背景)</button>
          </div>
          <div class="hint" style="margin-top:8px">建议 16:9;未上传时跟随背景</div>
        </div>
      </div>
      <div style="margin-top:14px;display:flex;gap:10px;align-items:center">
        <button class="btn btn-primary" id="hpSave">保存首页设置</button>
        <span class="muted" style="font-size:12px">修改后玩家首页立即生效</span>
      </div>
    </div>

    <div class="ov-title">外观与背景</div>
    <div class="card">
      <div class="ov-title" style="margin-top:0">当前背景预览</div>
      <div class="bg-preview">
        ${bgUrl()
          ? `<img src="${bgUrl()}" loading="lazy" decoding="async" data-err="hide">`
          : '<div class="muted" style="display:flex;align-items:center;justify-content:center;height:200px;font-size:13px">默认渐变背景(零图片请求)</div>'}
      </div>
      <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn btn-primary btn-sm" id="apUpload">↑ 上传新背景</button>
        <button class="btn btn-sm" id="apReset">用默认渐变背景</button>
        <button class="btn btn-sm" id="apPickDefault">使用面板目录内的图片</button>
      </div>
      <div class="hint" style="margin-top:10px">默认是纯色加顶部一点渐变(最快,零图片请求);上传图片建议 1920×1080 且尽量压缩,大图会明显拖慢首屏</div>
    </div>

    <div class="ov-title">玩家端下载</div>
    <div class="card">
      <div class="cfg-item">
        <label>允许未登录玩家下载存档与备份</label>
        <input type="checkbox" id="pdToggle" ${state.panel.publicDownload ? 'checked' : ''}>
      </div>
      <div class="hint" style="margin-top:10px">
        关闭时「存档下载」只对已登录用户可见。世界存档与备份含玩家数据,
        且每次打包都会让在线服务端暂停保存并全量压缩,建议仅在确有必要时开放。
      </div>
    </div>`;
  $('#apUpload', el).onclick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      if (!input.files[0]) return;
      try {
        const data = await post('/api/admin/background', undefined, input.files[0]);
        state.panel.background = data.background;
        bumpBg();
        renderAppearancePage(el);
        toast('背景已更换', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    };
    input.click();
  };
  $('#apReset', el).onclick = async () => {
    try {
      await put('/api/admin/settings', { background: '' });
      state.panel.background = '';
      bumpBg();
      renderAppearancePage(el);
      toast('已恢复默认渐变背景', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#apPickDefault', el).onclick = () => {
    const { modal } = openModal(`
      <h3>选择背景图片</h3>
      <div class="hint">面板目录内路径,如 <b>web/bg.jpg</b></div>
      <label class="field"><span>相对路径</span><input id="bpPath" type="text" value="${esc(bg)}"></label>
      <div class="modal-actions"><button class="btn" data-act="no">取消</button><button class="btn btn-primary" data-act="yes">应用</button></div>`);
    $$('.modal-actions .btn', modal).forEach(b => {
      b.onclick = async () => {
        closeModal();
        if (b.dataset.act !== 'yes') return;
        const p = $('#bpPath', modal).value.trim();
        if (!p) return;
        try {
          await put('/api/admin/settings', { background: p });
          state.panel.background = p;
          bumpBg();
          toast('背景已更换', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      };
    });
  };

  // ---- 玩家端下载开关 ----
  $('#pdToggle', el).onchange = async (e) => {
    const on = e.target.checked;
    try {
      const data = await put('/api/admin/settings', { publicDownload: on });
      state.panel.publicDownload = !!data.panel.publicDownload;
      toast(on ? '已开放玩家端下载' : '已关闭玩家端下载(仅登录用户)', 'ok');
    } catch (err) {
      e.target.checked = !on;
      toast(err.message, 'err');
    }
  };

  // ---- A 标题 / C 标语 保存 ----
  $('#hpSave', el).onclick = async () => {
    try {
      const data = await put('/api/admin/settings', {
        heroTitle: $('#hpTitle', el).value.trim(),
        heroSlogan: $('#hpSlogan', el).value.trim()
      });
      state.panel.heroTitle = data.panel.heroTitle;
      state.panel.heroSlogan = data.panel.heroSlogan;
      toast('首页设置已保存', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
  // ---- B 首页图片 上传 ----
  $('#hpUpload', el).onclick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      if (!input.files[0]) return;
      try {
        const data = await post('/api/admin/hero-image', undefined, input.files[0]);
        state.panel.heroImage = data.heroImage;
        bumpBg();
        renderAppearancePage(el);
        toast('首页图片已更换', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    };
    input.click();
  };
  // ---- B 首页图片 清除(跟随背景) ----
  $('#hpClear', el).onclick = async () => {
    try {
      await put('/api/admin/settings', { heroImage: '' });
      state.panel.heroImage = '';
      bumpBg();
      renderAppearancePage(el);
      toast('已清除,首页图片将跟随背景', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };

  // ---- 毛玻璃颜色(纯色,无渐变) ----
  const glOpacity = Math.round((parseFloat(state.panel.glassOpacity) || 0.08) * 100);
  const glSection = document.createElement('div');
  glSection.innerHTML = `
    <div class="ov-title">玻璃毛玻璃颜色</div>
    <div class="card">
      <div style="display:flex;gap:20px;align-items:center;flex-wrap:wrap">
        <div>
          <div class="muted" style="font-size:12px;margin-bottom:6px">颜色</div>
          <input type="color" id="glColor" value="${esc(state.panel.glassColor || '#ffffff')}" style="width:60px;height:38px;border:none;border-radius:8px;background:transparent;cursor:pointer">
        </div>
        <div style="flex:1;min-width:200px">
          <div class="muted" style="font-size:12px;margin-bottom:6px">透明度: <b id="glOpacityVal">${glOpacity}%</b></div>
          <input type="range" id="glOpacity" min="2" max="60" value="${glOpacity}" style="width:100%">
        </div>
        <button class="btn btn-primary btn-sm" id="glSave">保存玻璃颜色</button>
      </div>
      <div class="hint" style="margin-top:10px">保存后全局生效</div>
    </div>`;
  el.appendChild(glSection);
  const glInput = $('#glColor', el), glRange = $('#glOpacity', el), glVal = $('#glOpacityVal', el);
  glRange.oninput = () => { glVal.textContent = glRange.value + '%'; applyGlass(glInput.value, glRange.value / 100); };
  glInput.oninput = () => applyGlass(glInput.value, glRange.value / 100);
  $('#glSave', el).onclick = async () => {
    try {
      const data = await put('/api/admin/settings', { glassColor: glInput.value, glassOpacity: parseFloat(glRange.value) / 100 });
      state.panel.glassColor = data.panel.glassColor;
      state.panel.glassOpacity = data.panel.glassOpacity;
      applyGlass(data.panel.glassColor, data.panel.glassOpacity);
      toast('玻璃颜色已保存', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
}

/* ---------- 账号页 ---------- */
async function renderAccountPage(el) {
  if (!el) return;
  const isAdmin = !!(state.user && state.user.role === 'admin');
  el.innerHTML = `
    <div class="ov-title">修改密码</div>
    <div class="card" style="max-width:420px">
      <label class="field"><span>原密码</span><input id="pwOld" type="password"></label>
      <label class="field"><span>新密码 (至少 6 位)</span><input id="pwNew" type="password"></label>
      <label class="field"><span>确认新密码</span><input id="pwNew2" type="password"></label>
      <button class="btn btn-primary" id="pwSave">保存新密码</button>
      ${state.user && state.user.mustChange ? '<div class="hint" style="color:#ffb300;margin-top:10px">您正在使用默认密码,为了服务器安全请立即修改!</div>' : ''}
    </div>
    ${isAdmin ? `
    <div class="ov-title">用户管理</div>
    <div class="card">
      <div class="muted" style="font-size:12px;margin-bottom:8px">
        管理员可管理用户与全部设置;操作员可使用面板所有功能。
      </div>
      <div id="userRows"><div class="muted">加载中...</div></div>
      <div class="divider"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <input id="nuName" class="field field-sm" type="text" placeholder="用户名" style="width:150px">
        <input id="nuPw" class="field field-sm" type="password" placeholder="密码 (至少 6 位)" style="width:150px">
        <select id="nuRole" class="field field-sm" style="width:110px">
          <option value="operator">操作员</option>
          <option value="admin">管理员</option>
        </select>
        <button class="btn btn-primary btn-sm" id="nuAdd">添加用户</button>
      </div>
    </div>` : ''}`;

  $('#pwSave', el).onclick = async () => {
    const old = $('#pwOld', el).value, n1 = $('#pwNew', el).value, n2 = $('#pwNew2', el).value;
    if (n1 !== n2) return toast('两次输入的新密码不一致', 'err');
    try {
      await post('/api/admin/password', { old, new: n1 });
      toast('密码已修改', 'ok');
      state.user.mustChange = false;
      $('#pwOld', el).value = $('#pwNew', el).value = $('#pwNew2', el).value = '';
    } catch (e) { toast(e.message, 'err'); }
  };

  if (!isAdmin) return;

  const renderUsers = (users) => {
    const box = $('#userRows', el);
    if (!box) return;
    box.innerHTML = users.length ? users.map(u => `
      <div class="player-row">
        <span class="p-name">${esc(u.name)}</span>
        <span class="badge ${u.role === 'admin' ? 'op' : ''}">${u.role === 'admin' ? '管理员' : '操作员'}</span>
        ${state.user && state.user.name === u.name ? '<span class="muted" style="font-size:12px">当前登录</span>' : ''}
        <span style="flex:1"></span>
        <button class="btn btn-sm btn-danger" data-del="${esc(u.name)}">删除</button>
      </div>`).join('') : '<div class="muted">暂无用户</div>';
    $$('[data-del]', box).forEach(b => {
      b.onclick = async () => {
        const name = b.dataset.del;
        if (!await confirmDialog('删除用户', `确定删除用户「${name}」?其登录会话将立即失效。`, true)) return;
        try {
          const data = await del('/api/admin/users/' + encodeURIComponent(name));
          renderUsers(data.users || []);
          toast('用户已删除', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      };
    });
  };
  try { renderUsers((await get('/api/admin/users')).users || []); }
  catch (e) { $('#userRows', el).innerHTML = `<div class="muted">${esc(e.message)}</div>`; }

  $('#nuAdd', el).onclick = async () => {
    const name = $('#nuName', el).value.trim();
    const password = $('#nuPw', el).value;
    const role = $('#nuRole', el).value;
    if (!name) return toast('请输入用户名', 'err');
    if (password.length < 6) return toast('密码至少 6 位', 'err');
    try {
      const data = await post('/api/admin/users', { name, password, role });
      renderUsers(data.users || []);
      $('#nuName', el).value = $('#nuPw', el).value = '';
      toast('用户已添加', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
}

/* ---------- 关于页 ---------- */
async function renderAboutPage(el) {
  if (!el) return;
  const ver = await get('/api/version').catch(() => ({ version: '?' }));
  el.innerHTML = `
    <div class="ov-title">关于</div>
    <div class="card">
      <div class="kv"><span class="k">版本</span><span class="v">v${esc(ver.version)}</span></div>
      <div class="kv"><span class="k">面板监听</span><span class="v">${esc(state.panel.host || '0.0.0.0')}:${esc(state.panel.port || 8333)}</span></div>
      <div class="kv"><span class="k">数据目录</span><span class="v">data/ (配置、用户、背景)</span></div>
      <div class="kv"><span class="k">实例目录</span><span class="v">servers/ (每个实例一个文件夹)</span></div>
      <div class="hint" style="margin-top:12px">零依赖,占用小。更新:备份 <b>data/</b>、<b>servers/</b>,替换 <b>server.js</b>、<b>lib/</b>、<b>web/</b></div>
      <div style="display:flex;gap:10px;margin-top:14px">
        <button class="btn btn-sm" id="abRestart">重启面板</button>
        <button class="btn btn-sm btn-danger" id="abLogout">退出登录</button>
      </div>
    </div>`;
  $('#abRestart', el).onclick = async () => {
    if (!await confirmDialog('重启面板', '面板将自动重启(约 2 秒),已运行的服务器不受影响。确认?')) return;
    try { await post('/api/admin/restart'); toast('正在重启...', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  };
  $('#abLogout', el).onclick = async () => {
    await post('/api/logout');
    state.user = null;
    closeConsoleStream();
    history.replaceState(null, '', '/');
    showView('playerView');
  };
}

/* ---------- 初始化 ---------- */
(async function init() {
  // 背景图等 /api 回来知道有没有配置再加载,避免默认配置下白下几 MB 图片
  setBg('');
  applyGlass('#ffffff', 0.08);
  // 路由:地址栏 /admin 进入后台,否则显示玩家视图
  const wantAdmin = location.pathname.startsWith('/admin');
  try {
    const me = await get('/api/me');
    state.user = me;
  } catch { }
  if (wantAdmin) tryEnterAdmin();
  else showView('playerView');
})();
