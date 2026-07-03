/* OpenTerm frontend — command-driven Bloomberg-style market terminal */
'use strict';

/* ------------------------------------------------------------ helpers */

const $ = (sel) => document.querySelector(sel);
const el = (id) => document.getElementById(id);

async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

function fmtNum(x, dp = 2) {
  if (x == null || Number.isNaN(x)) return '—';
  return x.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
function fmtPrice(x) {
  if (x == null) return '—';
  const dp = Math.abs(x) >= 1000 ? 2 : Math.abs(x) >= 1 ? 2 : Math.abs(x) >= 0.01 ? 4 : 6;
  return fmtNum(x, dp);
}
function fmtBig(x) {
  if (x == null) return '—';
  const a = Math.abs(x);
  if (a >= 1e12) return fmtNum(x / 1e12) + 'T';
  if (a >= 1e9) return fmtNum(x / 1e9) + 'B';
  if (a >= 1e6) return fmtNum(x / 1e6) + 'M';
  if (a >= 1e3) return fmtNum(x / 1e3) + 'K';
  return fmtNum(x, 0);
}
function fmtPct(x, dp = 2) { return x == null ? '—' : fmtNum(x, dp) + '%'; }
function fmtRatio(x, dp = 2) { return x == null ? '—' : x.toLocaleString('en-US', { maximumFractionDigits: dp }); }
function chgClass(x) { return x > 0 ? 'pos' : x < 0 ? 'neg' : 'flat'; }
function arrow(x) { return x > 0 ? '▲' : x < 0 ? '▼' : ' '; }
function fmtChange(chg, pct) { return `${arrow(chg)} ${fmtNum(Math.abs(chg))} (${fmtNum(Math.abs(pct))}%)`; }
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function timeAgo(u) {
  if (!u) return '';
  const s = Math.max(0, Date.now() / 1000 - u);
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function fmtDate(u) {
  if (!u) return '—';
  return new Date(u * 1000).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

/* ---------------------------------------------------------- sparklines */

const GLYPH = '<svg class="glyph" viewBox="0 0 12 10" width="11" height="9"><rect x="0" y="5" width="2.4" height="5"/><rect x="4" y="1" width="2.4" height="9"/><rect x="8" y="6" width="2.4" height="4"/></svg>';

function sparkCell(sym, w = 66, h = 20) {
  return `<canvas class="spark" data-sym="${esc(sym)}" width="${w * 2}" height="${h * 2}" style="width:${w}px;height:${h}px"></canvas>`;
}

function drawSpark(canvas, closes, prev) {
  const cx = canvas.getContext('2d');
  const dpr = 2, W = canvas.width / dpr, H = canvas.height / dpr;
  cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cx.clearRect(0, 0, W, H);
  if (!closes || closes.length < 2) return;
  let lo = Math.min(...closes), hi = Math.max(...closes);
  if (prev != null) { lo = Math.min(lo, prev); hi = Math.max(hi, prev); }
  const pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.01 || 1;
  lo -= pad; hi += pad;
  const x = (i) => (i / (closes.length - 1)) * (W - 1) + 0.5;
  const y = (v) => H - ((v - lo) / (hi - lo)) * (H - 2) - 1;
  const up = closes[closes.length - 1] >= (prev ?? closes[0]);
  // faint technical grid
  cx.strokeStyle = '#0e1a24'; cx.lineWidth = 1;
  cx.beginPath(); cx.moveTo(0, Math.round(H / 2) + 0.5); cx.lineTo(W, Math.round(H / 2) + 0.5); cx.stroke();
  if (prev != null) {
    cx.strokeStyle = 'rgba(135,148,163,0.35)'; cx.setLineDash([2, 2]);
    cx.beginPath(); cx.moveTo(0, y(prev)); cx.lineTo(W, y(prev)); cx.stroke(); cx.setLineDash([]);
  }
  cx.beginPath();
  closes.forEach((v, i) => (i ? cx.lineTo(x(i), y(v)) : cx.moveTo(x(i), y(v))));
  cx.strokeStyle = up ? '#00c853' : '#ff3d57'; cx.lineWidth = 1; cx.lineCap = 'butt'; cx.lineJoin = 'miter'; cx.stroke();
}

async function fillSparks(container, range = '1d') {
  const canvases = [...container.querySelectorAll('canvas.spark')];
  const syms = [...new Set(canvases.map((c) => c.dataset.sym))];
  if (!syms.length) return;
  let data = {};
  try { data = await api(`/api/spark?symbols=${encodeURIComponent(syms.join(','))}&range=${range}`); } catch { return; }
  for (const c of canvases) {
    const d = data[c.dataset.sym];
    if (d) drawSpark(c, d.close, d.prev);
  }
}

/* -------------------------------------------------------------- state */

const state = {
  symbol: null,
  quote: null,
  func: null,        // active per-security function code
  view: 'home',      // active top-level view
  range: '6mo',
  chartType: 'candle',
  showMA: true,
  candles: [],
  watchlist: JSON.parse(localStorage.getItem('openterm.watchlist') || 'null')
    || ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'SPY'],
};
function saveWatchlist() { localStorage.setItem('openterm.watchlist', JSON.stringify(state.watchlist)); }

/* symbol universes for the market boards */
const TAPE = [
  ['^GSPC', 'S&P'], ['^IXIC', 'NASDAQ'], ['^DJI', 'DOW'], ['^RUT', 'RUSS2K'],
  ['^VIX', 'VIX'], ['^TNX', 'US10Y'], ['GC=F', 'GOLD'], ['CL=F', 'WTI'],
  ['BTC-USD', 'BTC'], ['ETH-USD', 'ETH'], ['EURUSD=X', 'EURUSD'], ['DX-Y.NYB', 'DXY'],
];
const WORLD = {
  'AMERICAS': [['^GSPC', 'S&P 500'], ['^DJI', 'Dow Jones'], ['^IXIC', 'Nasdaq Comp'], ['^RUT', 'Russell 2000'],
    ['^GSPTSE', 'S&P/TSX (CA)'], ['^BVSP', 'Bovespa (BR)'], ['^MXX', 'IPC (MX)']],
  'EMEA': [['^FTSE', 'FTSE 100 (UK)'], ['^GDAXI', 'DAX (DE)'], ['^FCHI', 'CAC 40 (FR)'],
    ['^STOXX50E', 'Euro Stoxx 50'], ['^IBEX', 'IBEX 35 (ES)'], ['FTSEMIB.MI', 'FTSE MIB (IT)'], ['^N100', 'Euronext 100']],
  'ASIA / PACIFIC': [['^N225', 'Nikkei 225 (JP)'], ['^HSI', 'Hang Seng (HK)'], ['000001.SS', 'Shanghai (CN)'],
    ['^AXJO', 'ASX 200 (AU)'], ['^BSESN', 'Sensex (IN)'], ['^KS11', 'KOSPI (KR)'], ['^TWII', 'Taiwan']],
};
const COMMODITIES = {
  'ENERGY': [['CL=F', 'WTI Crude'], ['BZ=F', 'Brent Crude'], ['NG=F', 'Natural Gas'], ['RB=F', 'Gasoline'], ['HO=F', 'Heating Oil']],
  'METALS': [['GC=F', 'Gold'], ['SI=F', 'Silver'], ['PL=F', 'Platinum'], ['PA=F', 'Palladium'], ['HG=F', 'Copper']],
  'AGRICULTURE': [['ZC=F', 'Corn'], ['ZW=F', 'Wheat'], ['ZS=F', 'Soybeans'], ['KC=F', 'Coffee'], ['SB=F', 'Sugar'], ['CT=F', 'Cotton'], ['CC=F', 'Cocoa']],
};
const RATES = [
  ['^IRX', 'US 13-Week (3M)'], ['^FVX', 'US 5-Year'], ['^TNX', 'US 10-Year'], ['^TYX', 'US 30-Year'],
];
const RATE_FUT = [['ZT=F', '2Y T-Note'], ['ZF=F', '5Y T-Note'], ['ZN=F', '10Y T-Note'], ['ZB=F', '30Y T-Bond']];

const SEC_FUNCS = [
  ['DES', 'Description'], ['GP', 'Price Graph'], ['GIP', 'Intraday'],
  ['FA', 'Fundamentals'], ['ERN', 'Earnings'], ['CN', 'News'],
  ['ANR', 'Analyst Recs'], ['HDS', 'Holders'], ['DVD', 'Dividends'],
  ['HP', 'Hist Prices'], ['BQ', 'Quote'],
];

/* -------------------------------------------------------------- msg */

function msg(text, isError = false) {
  const m = el('cmd-msg');
  m.textContent = text;
  m.classList.toggle('error', isError);
}

/* --------------------------------------------------- market clock */

function marketOpen() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 570 && mins < 960; // 9:30–16:00 ET
}
function tickClock() {
  const now = new Date();
  const open = marketOpen();
  const t = now.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  el('status-right').innerHTML = `<span class="${open ? 'pos' : 'neg'}">● ${open ? 'US MKT OPEN' : 'US MKT CLOSED'}</span> &nbsp; ${esc(t)} ET`;
  if (state.view === 'LAUNCH') renderLpClocks();
}

/* ------------------------------------------------------- view render */

function setActiveTabs(view) {
  if (view) setChrome('—', view);
}

function secBar(title, right = '', extra = '') {
  return `<div class="sec-bar"><span>${title}</span><span class="right">${right}</span>${extra}</div>`;
}

// Full Bloomberg action row: yellow security box · red action buttons ·
// yellow control fields · red function-title panel.
function fnBar(name, code, sec = '', controls = '') {
  return `<div class="fn-bar">
    ${sec ? `<span class="fn-secbox">${esc(sec)}</span>` : ''}
    <span class="fn-actions">
      <button class="fn-act" data-act="actions"><span class="n">96)</span>Actions ▾</button>
      <button class="fn-act" data-act="export"><span class="n">97)</span>Export ▾</button>
      <button class="fn-act" data-act="settings"><span class="n">98)</span>Settings</button>
    </span>
    ${controls}
    <span class="fn-spacer"></span>
    <span class="fn-name">${esc(name)}<span class="code">${esc(code)}</span></span>
  </div>`;
}
const eqBox = () => `${state.symbol} US Equity`;

// EXPORT (97): download the first data table on screen as CSV — a real Bloomberg action.
function exportCSV() {
  const table = el('view').querySelector('table.data');
  if (!table) { msg('Nothing to export on this screen', true); return; }
  const rows = [...table.rows].map((tr) => [...tr.cells]
    .map((td) => `"${(td.textContent || '').trim().replace(/\s+/g, ' ').replace(/"/g, '""')}"`).join(','));
  const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `openterm-${(state.symbol || state.view || 'export').toLowerCase()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  msg('Exported current table to CSV');
}

/* ------------------------------------------------------------ security */

async function loadSecurity(symbol, func = 'GP') {
  msg(`Loading ${symbol}…`);
  try {
    const quote = await api(`/api/quote/${encodeURIComponent(symbol)}`);
    state.symbol = quote.symbol;
    state.quote = quote;
    renderSecHeader(quote);
    msg(`${quote.symbol} — ${quote.name}`);
    runFunc(func);
  } catch (err) {
    msg(`${symbol}: ${err.message}`, true);
  }
}

function renderSecHeader(q) {
  el('sec-header').classList.remove('hidden');
  el('sec-symbol').textContent = q.symbol;
  el('sec-name').textContent = q.name || '';
  const p = el('sec-price');
  p.textContent = fmtPrice(q.price);
  p.className = chgClass(q.change);
  const c = el('sec-change');
  c.textContent = fmtChange(q.change, q.changePct);
  c.className = chgClass(q.change);
  flashEl(p, tickDir('HDR:' + q.symbol, q.price));
  // real Terminal quote-line grammar: squiggle · N bid/ask N size · At · Vol · OHL · Val
  el('sec-detail').innerHTML =
    `<canvas id="sec-squig" width="120" height="26" style="width:60px;height:13px;vertical-align:-2px"></canvas>`
    + ` <span id="sec-ba" class="hl">N —/— N</span>`
    + ` · At ${q.marketTime ? new Date(q.marketTime * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'} d`
    + ` · Vol ${fmtBig(q.volume)}`
    + ` · O ${fmtPrice(q.open)}N · H ${fmtPrice(q.dayHigh)}N · L ${fmtPrice(q.dayLow)}D`
    + ` · Val ${q.price && q.volume ? fmtBig(q.price * q.volume) : '—'}`
    + ` · ${esc([q.exchange, q.currency].filter(Boolean).join(' · '))}`;
  api(`/api/spark?symbols=${encodeURIComponent(q.symbol)}&range=1d`).then((d) => {
    const sp = d[q.symbol], c = el('sec-squig');
    if (sp && c) drawSpark(c, sp.close, sp.prev);
  }).catch(() => {});
  api(`/api/summary/${encodeURIComponent(q.symbol)}`).then((sm) => {
    const b = el('sec-ba');
    if (b && sm.bid && sm.ask) b.textContent = `N ${fmtPrice(sm.bid)}/${fmtPrice(sm.ask)} N ${fmtRatio(sm.bidSize, 0)}x${fmtRatio(sm.askSize, 0)}`;
  }).catch(() => {});
  el('sec-funcs').innerHTML = SEC_FUNCS.map(([code, label], i) =>
    `<button class="sec-func" data-func="${code}"><span class="n">${i + 1})</span>${code} <span class="muted">${label}</span></button>`).join('');
  el('sec-funcs').querySelectorAll('.sec-func').forEach((b) =>
    b.addEventListener('click', () => runFunc(b.dataset.func)));
}

/* app-chrome (top toolbar) security/function context */
function setChrome(sec, fn) {
  el('chr-sec').innerHTML = `${esc(sec || '—')} <b class="tri">▾</b>`;
  el('chr-sec').dataset.cmd = sec && state.symbol ? state.symbol : '';
  el('chr-fn').innerHTML = `${esc(fn || 'HOME')} <b class="tri">▾</b>`;
}

/* bottom suggested-functions status strip */
function setSuggest(html) {
  const s = el('suggest');
  if (!html) { s.classList.remove('show'); s.innerHTML = ''; return; }
  s.innerHTML = `<span class="nav"><button>«</button><button>‹</button><button>›</button><button>»</button></span>${html}`;
  s.classList.add('show');
}

/* ------------------------------------------ open-function tab strip */

const tabs = [];
function setTab(label, cmd) {
  state.currentTabCmd = cmd;
  const i = tabs.findIndex((t) => t.cmd === cmd);
  if (i === -1) { tabs.push({ label, cmd }); if (tabs.length > 8) tabs.shift(); }
  else tabs[i].label = label;
  renderTabs();
}
function renderTabs() {
  const box = el('fn-tabs'); if (!box) return;
  box.innerHTML = `<button class="ftab new" data-cmd="HOME">＋&nbsp;New Tab</button>` + tabs.map((t) =>
    `<span class="ftab ${t.cmd === state.currentTabCmd ? 'active' : ''}" data-cmd="${esc(t.cmd)}">${esc(t.label)}<b class="ftab-x" data-x="${esc(t.cmd)}">✕</b></span>`).join('');
  box.querySelectorAll('.ftab').forEach((b) => b.addEventListener('click', (e) => {
    if (e.target.classList.contains('ftab-x')) return;
    runCommand(b.dataset.cmd);
  }));
  box.querySelectorAll('.ftab-x').forEach((x) => x.addEventListener('click', (e) => {
    e.stopPropagation();
    const idx = tabs.findIndex((t) => t.cmd === x.dataset.x);
    if (idx !== -1) tabs.splice(idx, 1);
    if (state.currentTabCmd === x.dataset.x) { const nxt = tabs[tabs.length - 1]; nxt ? runCommand(nxt.cmd) : runCommand('HOME'); }
    else renderTabs();
  }));
}

/* --------------------------------------------------- tick flashing */

const PREVPX = {};
function tickDir(key, price) {
  const p = PREVPX[key]; PREVPX[key] = price;
  if (p == null || price == null || p === price) return '';
  return price > p ? 'flash-up' : 'flash-dn';
}
function flashEl(elm, dir) {
  if (!elm || !dir) return;
  elm.classList.remove('flash-up', 'flash-dn');
  void elm.offsetWidth;
  elm.classList.add(dir);
}

/* --------------------------------------------------- system toast */

let toastShown = false;
function showToast() {
  if (toastShown) return; toastShown = true;
  const t = el('toast'); if (!t) return;
  t.className = '';
  t.innerHTML = `<div class="toast-t">Compatible Launchpad View Found</div>
    <div class="toast-b">A new view was loaded, but "Vista OpenTerm" will fit on this computer display. Open it?</div>
    <div class="toast-btns"><button id="toast-y">Yes, open "Vista OpenTerm"</button><button id="toast-n">Open another view…</button></div>`;
  const close = () => t.classList.add('hidden');
  el('toast-y').onclick = close; el('toast-n').onclick = close;
  setTimeout(close, 20000);
}

function markFunc(code) {
  state.func = code;
  document.querySelectorAll('.sec-func').forEach((b) =>
    b.classList.toggle('active', b.dataset.func === code));
  if (code && state.symbol) setChrome(`${state.symbol} US Equity`, code);
  if (code && state.symbol) setTab(`${code} ${state.symbol} US Equity`, `${state.symbol} ${code}`);
  if (code && state.symbol && ['GP', 'GIP', 'DES', 'FA', 'ERN', 'CN'].includes(code)) {
    setSuggest('<span class="sg">Suggested Functions &nbsp; <b>DES</b> Description &nbsp;·&nbsp; <b>GP</b> Graph &nbsp;·&nbsp; <b>FA</b> Fundamentals &nbsp;·&nbsp; <b>ERN</b> Earnings &nbsp;·&nbsp; <b>CN</b> News</span>');
  } else {
    setSuggest('');
  }
}

function runFunc(code) {
  markFunc(code);
  if (code === 'GP') return showChart('6mo');
  if (code === 'GIP') return showChart('1d');
  if (code === 'DES') return showDES();
  if (code === 'FA') return showFA();
  if (code === 'ERN') return showERN();
  if (code === 'CN' || code === 'N') return showNews();
  if (code === 'ANR') return showANR();
  if (code === 'HDS') return showHDS();
  if (code === 'DVD') return showDVD();
  if (code === 'HP') return showHP();
  if (code === 'BQ') return showBQ();
  return showChart('6mo');
}

/* -------------------------------------------------------------- chart */

const RANGE_LABELS = [['1d', '1D'], ['5d', '5D'], ['1mo', '1M'], ['3mo', '3M'],
  ['6mo', '6M'], ['1y', '1Y'], ['5y', '5Y'], ['max', 'MAX']];

let chartEl, ctx, volEl, vctx, hoverIdx = -1;

function movingAvg(candles, period) {
  const out = new Array(candles.length).fill(null);
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].c;
    if (i >= period) sum -= candles[i - period].c;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

async function showChart(range) {
  if (!state.symbol) { msg('Load a security first — e.g. AAPL GP', true); return; }
  if (range) state.range = range;
  setActiveTabs(null); markFunc(state.range === '1d' ? 'GIP' : 'GP');
  const controls = `<span class="fn-ctrl">Mov Avg ▾</span><span class="fn-ctrl">Study ▾</span><span class="fn-ctrl">Events ▾</span><span class="fn-ctrl"><b>Cur</b> USD ▾</span>`;
  el('view').innerHTML = `<div class="fa-screen">
    ${fnBar(state.range === '1d' ? 'INTRADAY GRAPH' : 'PRICE GRAPH', state.range === '1d' ? 'GIP' : 'GP', eqBox(), controls)}
    <div id="gp-metabar"><span class="muted">Loading…</span></div>
    <div id="chart-toolbar">
      <span class="tb-label">RANGE</span>
      ${RANGE_LABELS.map(([r, l]) => `<button class="tb-btn rbtn" data-range="${r}">${l}</button>`).join('')}
      <span class="tb-label">TYPE</span>
      <button class="tb-btn tbtn" data-type="candle">CANDLE</button>
      <button class="tb-btn tbtn" data-type="line">LINE</button>
      <span class="tb-sep"></span>
      <button class="tb-btn mav-btn">MAV</button>
      <button class="tb-btn dis">COMPARE</button><button class="tb-btn dis">EVENTS</button><button class="tb-btn dis">NEWS</button>
    </div>
    <div id="gp-main">
      <div id="gp-chartcol">
        <div id="chart-wrap"><canvas id="chart"></canvas></div>
        <div id="chart-sub"><canvas id="chart-vol"></canvas></div>
        <div id="chart-legend"></div>
      </div>
      <div id="gp-side"><div class="loading">…</div></div>
    </div>
    <div id="gp-events"><span class="muted">Loading events…</span></div>
  </div>`;
  chartEl = el('chart'); ctx = chartEl.getContext('2d');
  volEl = el('chart-vol'); vctx = volEl.getContext('2d');
  el('view').querySelectorAll('.rbtn').forEach((b) => {
    b.classList.toggle('active', b.dataset.range === state.range);
    b.addEventListener('click', () => { state.range = b.dataset.range; showChart(); });
  });
  el('view').querySelectorAll('.tbtn').forEach((b) => {
    b.classList.toggle('active', b.dataset.type === state.chartType);
    b.addEventListener('click', () => { state.chartType = b.dataset.type; el('view').querySelectorAll('.tbtn').forEach((x) => x.classList.toggle('active', x === b)); drawChart(); });
  });
  const mav = el('view').querySelector('.mav-btn');
  mav.classList.toggle('active', state.showMA);
  mav.addEventListener('click', () => { state.showMA = !state.showMA; mav.classList.toggle('active', state.showMA); drawChart(); });
  attachChartEvents();
  try {
    const data = await api(`/api/history/${encodeURIComponent(state.symbol)}?range=${state.range}`);
    state.candles = data.candles;
    hoverIdx = -1;
    renderGPmeta(data.meta);
    renderGPside(data.meta);
    resizeChart();
  } catch (err) { msg(`chart: ${err.message}`, true); el('chart-legend').innerHTML = `<span class="neg">${esc(err.message)}</span>`; }
  api(`/api/news?symbol=${encodeURIComponent(state.symbol)}`).then((d) => {
    const e = el('gp-events'); if (!e) return;
    e.innerHTML = (d.items || []).slice(0, 6).map((n) =>
      `<span class="gp-ev"><span class="src">${esc((n.source || '').slice(0, 14))}</span> ${esc(n.title.slice(0, 70))}</span>`).join('<span class="gp-evsep">•</span>');
  }).catch(() => {});
}

function renderGPmeta(meta) {
  const c = state.candles; if (!c.length) return;
  const last = c[c.length - 1], first = c[0];
  const chg = last.c - first.c, pct = first.c ? (chg / first.c) * 100 : 0;
  const hi = Math.max(...c.map((x) => x.h)), lo = Math.min(...c.map((x) => x.l));
  const vol = c.reduce((a, x) => a + (x.v || 0), 0);
  const q = state.quote || {};
  const cell = (k, v, cls = '') => `<span class="gpm"><span class="gpm-k">${k}</span> <span class="gpm-v ${cls}">${v}</span></span>`;
  el('gp-metabar').innerHTML =
    cell('Rng', state.range.toUpperCase()) + cell('Cur', meta.currency || 'USD')
    + cell('Last', fmtPrice(last.c), chgClass(q.change))
    + cell('Chg', fmtChange(chg, pct), chgClass(chg))
    + cell('Open', fmtPrice(first.o)) + cell('High', fmtPrice(hi), 'pos') + cell('Low', fmtPrice(lo), 'neg')
    + cell('Vol', fmtBig(vol)) + cell('52W H', fmtPrice(q.high52w)) + cell('52W L', fmtPrice(q.low52w));
}

function renderGPside(meta) {
  const c = state.candles; if (!c.length) return;
  const last = c[c.length - 1], q = state.quote || {};
  const ma20 = movingAvg(c, 20), ma50 = movingAvg(c, 50);
  const hi = Math.max(...c.map((x) => x.h)), lo = Math.min(...c.map((x) => x.l));
  const row = (k, v, cls = '') => `<div class="kv"><span class="k">${esc(k)}</span><span class="v ${cls}">${v}</span></div>`;
  el('gp-side').innerHTML =
    `<div class="sec-bar" style="position:static">QUOTE RECAP</div><div class="kv-grid" style="grid-template-columns:1fr">
      ${row('Last', fmtPrice(last.c), chgClass(q.change))}
      ${row('Change', fmtChange(q.change, q.changePct), chgClass(q.change))}
      ${row('Open', fmtPrice(q.open))}
      ${row('Prev Close', fmtPrice(q.prevClose))}
      ${row('Day High', fmtPrice(q.dayHigh), 'pos')}
      ${row('Day Low', fmtPrice(q.dayLow), 'neg')}
      ${row('Volume', fmtBig(q.volume))}
    </div>
    <div class="sec-bar" style="position:static;margin-top:2px">RANGE / STUDIES</div><div class="kv-grid" style="grid-template-columns:1fr">
      ${row(`${state.range.toUpperCase()} High`, fmtPrice(hi), 'pos')}
      ${row(`${state.range.toUpperCase()} Low`, fmtPrice(lo), 'neg')}
      ${row('52W High', fmtPrice(q.high52w))}
      ${row('52W Low', fmtPrice(q.low52w))}
      ${row('MA (20)', fmtPrice(ma20[ma20.length - 1]), 'hl')}
      ${row('MA (50)', fmtPrice(ma50[ma50.length - 1]), 'blue')}
      ${row('Exchange', esc(meta.exchange || q.exchange || '—'))}
    </div>`;
}

function attachChartEvents() {
  const move = (clientX) => {
    if (!state.candles.length) return;
    const rect = chartEl.getBoundingClientRect();
    const M = { left: 6, right: 58 };
    const plotW = rect.width - M.left - M.right;
    const i = Math.round(((clientX - rect.left - M.left) / plotW) * state.candles.length - 0.5);
    hoverIdx = Math.max(0, Math.min(state.candles.length - 1, i));
    drawChart();
  };
  chartEl.addEventListener('mousemove', (e) => move(e.clientX));
  chartEl.addEventListener('mouseleave', () => { hoverIdx = -1; drawChart(); });
  chartEl.addEventListener('touchstart', (e) => { if (e.touches[0]) move(e.touches[0].clientX); }, { passive: true });
  chartEl.addEventListener('touchmove', (e) => { if (e.touches[0]) move(e.touches[0].clientX); }, { passive: true });
}

function resizeChart() {
  if (!chartEl) return;
  const wrap = el('chart-wrap');
  if (!wrap || wrap.clientWidth === 0) return;
  const dpr = window.devicePixelRatio || 1;
  chartEl.width = Math.floor(wrap.clientWidth * dpr);
  chartEl.height = Math.floor(wrap.clientHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (volEl) {
    const sub = el('chart-sub');
    volEl.width = Math.floor(sub.clientWidth * dpr);
    volEl.height = Math.floor(sub.clientHeight * dpr);
    vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  drawChart();
}

function xLabel(t, intraday) {
  const d = new Date(t * 1000);
  return intraday ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: '2-digit' });
}

function drawChart() {
  if (!ctx) return;
  const candles = state.candles;
  const dpr = window.devicePixelRatio || 1;
  const W = chartEl.width / dpr, H = chartEl.height / dpr;
  if (!W || !H) return;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (!candles.length) return;

  const M = { top: 10, right: 58, bottom: 18, left: 6 };
  const priceH = H - M.top - M.bottom;
  const plotW = W - M.left - M.right;
  const n = candles.length;
  const ma20 = movingAvg(candles, 20), ma50 = movingAvg(candles, 50);

  let lo = Infinity, hi = -Infinity;
  for (const c of candles) { if (c.l < lo) lo = c.l; if (c.h > hi) hi = c.h; }
  if (state.showMA) { for (const v of ma20.concat(ma50)) { if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; } } }
  const pad = (hi - lo) * 0.05 || hi * 0.01 || 1;
  lo -= pad; hi += pad;
  const xAt = (i) => M.left + ((i + 0.5) / n) * plotW;
  const yAt = (p) => M.top + (1 - (p - lo) / (hi - lo)) * priceH;

  ctx.font = '9px "Arial Narrow", monospace';
  ctx.textBaseline = 'middle';
  // dense horizontal grid + right axis
  for (let g = 0; g <= 8; g++) {
    const p = lo + ((hi - lo) * g) / 8, y = yAt(p);
    ctx.strokeStyle = '#12202c';
    ctx.beginPath(); ctx.moveTo(M.left, Math.round(y) + 0.5); ctx.lineTo(W - M.right, Math.round(y) + 0.5); ctx.stroke();
    ctx.fillStyle = '#8794a3'; ctx.textAlign = 'left';
    ctx.fillText(fmtPrice(p), W - M.right + 4, y);
  }
  const intraday = ['1d', '5d'].includes(state.range);
  const ticks = Math.max(3, Math.floor(plotW / 90));
  ctx.textAlign = 'center';
  for (let g = 0; g <= ticks; g++) {
    const i = Math.min(n - 1, Math.round((g / ticks) * (n - 1)));
    const x = xAt(i);
    ctx.strokeStyle = '#0e1a24';
    ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, M.top); ctx.lineTo(Math.round(x) + 0.5, M.top + priceH); ctx.stroke();
    ctx.fillStyle = '#8794a3';
    ctx.fillText(xLabel(candles[i].t, intraday), x, H - M.bottom / 2);
  }
  // price series — thin dense candles
  const bw = Math.max(1, Math.min(6, (plotW / n) * 0.6));
  if (state.chartType === 'line' || n > 320) {
    ctx.beginPath();
    for (let i = 0; i < n; i++) { const x = xAt(i), y = yAt(candles[i].c); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.strokeStyle = '#f6a313'; ctx.lineWidth = 1; ctx.lineCap = 'butt'; ctx.stroke();
  } else {
    for (let i = 0; i < n; i++) {
      const c = candles[i], x = Math.round(xAt(i)) + 0.5, up = c.c >= c.o;
      ctx.strokeStyle = ctx.fillStyle = up ? '#00c853' : '#ff3d57';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, yAt(c.h)); ctx.lineTo(x, yAt(c.l)); ctx.stroke();
      const top = yAt(Math.max(c.o, c.c)), bh = Math.max(1, Math.abs(yAt(c.o) - yAt(c.c)));
      ctx.fillRect(Math.round(xAt(i) - bw / 2), top, bw, bh);
    }
  }
  // moving averages
  if (state.showMA) {
    const drawMA = (arr, color) => {
      ctx.beginPath(); let started = false;
      for (let i = 0; i < n; i++) { if (arr[i] == null) continue; const x = xAt(i), y = yAt(arr[i]); started ? ctx.lineTo(x, y) : ctx.moveTo(x, y); started = true; }
      ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke();
    };
    drawMA(ma20, '#ffe45c'); drawMA(ma50, '#4ec8ff');
  }
  if (state.quote?.prevClose > lo && state.quote?.prevClose < hi) {
    const y = yAt(state.quote.prevClose);
    ctx.strokeStyle = '#3a4a58'; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(M.left, y); ctx.lineTo(W - M.right, y); ctx.stroke(); ctx.setLineDash([]);
  }
  if (hoverIdx >= 0 && hoverIdx < n) {
    const c = candles[hoverIdx], x = xAt(hoverIdx), y = yAt(c.c);
    ctx.strokeStyle = 'rgba(78,200,255,0.5)'; ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.moveTo(x, M.top); ctx.lineTo(x, M.top + priceH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(M.left, y); ctx.lineTo(W - M.right, y); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#4ec8ff'; ctx.textAlign = 'left'; ctx.fillText(fmtPrice(c.c), W - M.right + 4, y);
    el('chart-legend').innerHTML =
      `${esc(xLabel(c.t, intraday))}  O:<span class="flat">${fmtPrice(c.o)}</span> H:<span class="pos">${fmtPrice(c.h)}</span> L:<span class="neg">${fmtPrice(c.l)}</span> C:<span class="${chgClass(c.c - c.o)}">${fmtPrice(c.c)}</span> VOL:${fmtBig(c.v)}` +
      ` &nbsp; <span class="hl">MA20 ${fmtPrice(ma20[hoverIdx])}</span> <span class="blue">MA50 ${fmtPrice(ma50[hoverIdx])}</span>`;
  } else {
    const f = candles[0], l = candles[n - 1], chg = l.c - f.c, pct = f.c ? (chg / f.c) * 100 : 0;
    el('chart-legend').innerHTML =
      `${esc(state.symbol)} ${esc(state.range.toUpperCase())} · chg <span class="${chgClass(chg)}">${fmtChange(chg, pct)}</span> · <span class="hl">━ MA20</span> <span class="blue">━ MA50</span> · hover for OHLC`;
  }
  drawVolume();
}

function drawVolume() {
  if (!vctx || !volEl) return;
  const candles = state.candles;
  const dpr = window.devicePixelRatio || 1;
  const W = volEl.width / dpr, H = volEl.height / dpr;
  if (!W || !H) return;
  vctx.clearRect(0, 0, W, H);
  vctx.fillStyle = '#000'; vctx.fillRect(0, 0, W, H);
  if (!candles.length) return;
  const M = { right: 58, left: 6 };
  const plotW = W - M.right - M.left;
  const n = candles.length;
  let maxV = 0; for (const c of candles) if (c.v > maxV) maxV = c.v;
  vctx.strokeStyle = '#12202c';
  vctx.beginPath(); vctx.moveTo(M.left, 0.5); vctx.lineTo(W - M.right, 0.5); vctx.stroke();
  vctx.font = '9px "Arial Narrow", monospace'; vctx.textBaseline = 'top'; vctx.textAlign = 'left';
  vctx.fillStyle = '#8794a3'; vctx.fillText('Vol ' + fmtBig(maxV), W - M.right + 4, 2);
  const bw = Math.max(1, Math.min(6, (plotW / n) * 0.6));
  for (let i = 0; i < n; i++) {
    const c = candles[i], h = maxV ? (c.v / maxV) * (H - 2) : 0;
    vctx.fillStyle = c.c >= c.o ? 'rgba(0,200,83,0.5)' : 'rgba(255,61,87,0.5)';
    vctx.fillRect(Math.round(M.left + ((i + 0.5) / n) * plotW - bw / 2), H - h, bw, h);
  }
  if (hoverIdx >= 0 && hoverIdx < n) {
    const x = M.left + ((hoverIdx + 0.5) / n) * plotW;
    vctx.strokeStyle = 'rgba(78,200,255,0.5)'; vctx.setLineDash([2, 2]);
    vctx.beginPath(); vctx.moveTo(x, 0); vctx.lineTo(x, H); vctx.stroke(); vctx.setLineDash([]);
  }
}

/* ---------------------------------------------------------------- DES */

function desPanel(title, rows, cls = '') {
  return `<div class="des-panel ${cls}"><div class="sec-bar" style="position:static">${esc(title)}</div>
    <div class="kv-grid" style="grid-template-columns:1fr">${rows.filter(Boolean).join('')}</div></div>`;
}

async function showDES() {
  if (!state.symbol) { msg('Load a security first', true); return; }
  setActiveTabs(null); markFunc('DES');
  el('view').innerHTML = `<div class="fa-screen">` + fnBar('SECURITY DESCRIPTION', 'DES', eqBox()) +
    `<div class="des-wrap"><div class="loading">Loading…</div></div></div>`;
  const wrap = el('view').querySelector('.des-wrap');
  try {
    const [q, p, s, news, hist] = await Promise.all([
      api(`/api/quote/${encodeURIComponent(state.symbol)}`),
      api(`/api/profile/${encodeURIComponent(state.symbol)}`).catch(() => ({})),
      api(`/api/summary/${encodeURIComponent(state.symbol)}`).catch(() => ({})),
      api(`/api/news?symbol=${encodeURIComponent(state.symbol)}`).catch(() => ({ items: [] })),
      api(`/api/history/${encodeURIComponent(state.symbol)}?range=1y`).catch(() => ({ candles: [] })),
    ]);
    const kv = (k, v, hl) => (v == null || v === '' ? '' : `<div class="kv"><span class="k">${esc(k)}</span><span class="v ${hl ? 'hl' : ''}">${v}</span></div>`);
    const pctv = (x) => (x == null ? null : `<span class="${chgClass(x)}">${fmtPct(x)}</span>`);
    const off52 = q.high52w ? ((q.price - q.high52w) / q.high52w) * 100 : null;
    // price performance from 1y daily candles
    const c = hist.candles || [];
    const last = c.length ? c[c.length - 1].c : q.price;
    const back = (nb) => (c.length > nb ? ((last - c[c.length - 1 - nb].c) / c[c.length - 1 - nb].c) * 100 : null);
    const ytd = (() => {
      if (!c.length) return null;
      const yr = new Date(c[c.length - 1].t * 1000).getFullYear();
      const first = c.find((x) => new Date(x.t * 1000).getFullYear() === yr);
      return first ? ((last - first.c) / first.c) * 100 : null;
    })();
    const ev = (s.marketCap != null && s.totalDebt != null) ? s.marketCap + s.totalDebt - (s.totalCash || 0) : null;
    wrap.innerHTML = `
      ${s.summary ? `<div class="des-desc">${esc(s.summary)}</div>` : ''}
      <div class="des-grid">
        ${desPanel('IDENTIFICATION', [
          kv('Name', esc(s.name || p.name || q.name)), kv('Ticker', esc(q.symbol), true),
          kv('Type', esc(q.type || 'Equity')), kv('Exchange', esc(p.exchange || q.exchange)),
          kv('Currency', esc(q.currency)), kv('Country', esc(s.country || '—')),
          kv('Employees', s.employees ? fmtBig(s.employees) : null),
          kv('Website', s.website ? `<a class="blue" href="${esc(s.website)}" target="_blank" rel="noopener">${esc(s.website.replace(/^https?:\/\//, ''))}</a>` : null),
        ])}
        ${desPanel('CLASSIFICATION', [
          kv('Sector', esc(s.sector || p.sector || '—')), kv('Industry', esc(s.industry || p.industry || '—')),
          kv('Asset Class', 'Equity'), kv('Market', esc(q.exchange || '—')),
          kv('Bloomberg', `${esc(q.symbol)} US`), kv('FIGI', `BBG—${esc(q.symbol)}`),
        ])}
        ${desPanel('MARKET DATA', [
          kv('Last', fmtPrice(q.price), true), kv('Change', `<span class="${chgClass(q.change)}">${fmtChange(q.change, q.changePct)}</span>`),
          kv('Open', fmtPrice(q.open)), kv('Prev Close', fmtPrice(q.prevClose)),
          kv('Day Range', `${fmtPrice(q.dayLow)} – ${fmtPrice(q.dayHigh)}`),
          kv('Volume', fmtBig(q.volume)), kv('Avg Volume', s.avgVolume ? fmtBig(s.avgVolume) : null),
        ])}
        ${desPanel('PRICE PERFORMANCE', [
          kv('1 Day', pctv(q.changePct)), kv('1 Week', pctv(back(5))), kv('1 Month', pctv(back(21))),
          kv('3 Month', pctv(back(63))), kv('6 Month', pctv(back(126))), kv('1 Year', pctv(back(250))),
          kv('YTD', pctv(ytd)),
        ])}
        ${desPanel('VALUATION', [
          kv('Market Cap', fmtBig(s.marketCap), true), kv('Enterprise Value', fmtBig(ev)),
          kv('P/E (TTM)', fmtRatio(s.peTrailing)), kv('P/E (Fwd)', fmtRatio(s.peForward)),
          kv('Price/Book', fmtRatio(s.priceToBook)), kv('EV/EBITDA', ev && s.ebitda ? fmtRatio(ev / s.ebitda) : null),
          kv('EPS (TTM)', fmtPrice(s.eps)), kv('Beta', fmtRatio(s.beta)),
        ])}
        ${desPanel('PROFITABILITY', [
          kv('Revenue (TTM)', fmtBig(s.revenue)), kv('Gross Margin', s.grossMargin != null ? fmtPct(s.grossMargin * 100) : null),
          kv('Oper Margin', s.operatingMargin != null ? fmtPct(s.operatingMargin * 100) : null),
          kv('Profit Margin', s.profitMargin != null ? fmtPct(s.profitMargin * 100) : null),
          kv('ROE', s.roe != null ? fmtPct(s.roe * 100) : null), kv('ROA', s.roa != null ? fmtPct(s.roa * 100) : null),
          kv('EBITDA', fmtBig(s.ebitda)), kv('Free Cash Flow', fmtBig(s.freeCashflow)),
        ])}
        ${desPanel('52-WEEK / TRADING', [
          kv('52W High', fmtPrice(q.high52w)), kv('52W Low', fmtPrice(q.low52w)),
          kv('% Off 52W High', off52 != null ? pctv(off52) : null),
          kv('1Y High', c.length ? fmtPrice(Math.max(...c.map((x) => x.h))) : null),
          kv('1Y Low', c.length ? fmtPrice(Math.min(...c.map((x) => x.l))) : null),
        ])}
        ${desPanel('OWNERSHIP & SHARES', [
          kv('Shares Out', fmtBig(s.sharesOut || p.sharesOut)), kv('Float', fmtBig(s.floatShares)),
          kv('% Insiders', s.heldPctInsiders != null ? fmtPct(s.heldPctInsiders * 100) : null),
          kv('% Institutions', s.heldPctInstitutions != null ? fmtPct(s.heldPctInstitutions * 100) : null),
          kv('Short % Float', s.shortPctFloat != null ? fmtPct(s.shortPctFloat * 100) : null),
        ])}
        ${desPanel('DIVIDENDS', [
          kv('Div Yield', s.dividendYield ? fmtPct(s.dividendYield * 100) : '—'),
          kv('Div Rate', s.dividendRate ? fmtPrice(s.dividendRate) : '—'),
          kv('Payout Ratio', s.payoutRatio ? fmtPct(s.payoutRatio * 100) : '—'),
        ])}
        ${desPanel('ANALYST RATING', [
          kv('Recommendation', s.recommendationKey ? `<span class="hl">${esc(s.recommendationKey.toUpperCase())}</span>` : '—'),
          kv('Mean Target', fmtPrice(s.targetMean)), kv('High / Low', s.targetHigh ? `${fmtPrice(s.targetHigh)} / ${fmtPrice(s.targetLow)}` : null),
          kv('Upside', s.targetMean && q.price ? pctv(((s.targetMean - q.price) / q.price) * 100) : null),
          kv('# Analysts', s.numberOfAnalysts ? fmtRatio(s.numberOfAnalysts, 0) : null),
          kv('Next Earnings', fmtDate(s.nextEarningsDate)),
        ])}
        <div class="des-panel span2"><div class="sec-bar" style="position:static">LATEST NEWS</div>
          <div style="padding:1px 4px">${newsHTML((news.items || []), 8)}</div></div>
      </div>`;
  } catch (err) { wrap.innerHTML = `<div class="err">${esc(err.message)}</div>`; }
}

/* ----------------------------------------------------------------- FA */

const FA_TABS = [['overview', 'OVERVIEW'], ['income', 'INCOME STMT'], ['balance', 'BALANCE SHEET'], ['cashflow', 'CASH FLOW'], ['ratios', 'RATIOS']];
const faCache = { symbol: null, tab: 'overview', summary: null, fin: null };

function showFA() {
  if (!state.symbol) { msg('Load a security first', true); return; }
  setActiveTabs(null);
  if (faCache.symbol !== state.symbol) { faCache.symbol = state.symbol; faCache.tab = 'overview'; faCache.summary = null; faCache.fin = null; }
  renderFAShell();
  loadFATab();
}

const FA_TABS2 = ['11) BBG Adj Highlights', '12) BBG GAAP Highlights', '13) Company Model', '14) Earnings', '15) Enterprise Value', '16) Multiples', '17) Per Share', '18) Stock Value'];

function renderFAShell() {
  const periods = faCache.fin ? faCache.fin.years.length : 4;
  const controls = `<span class="fn-ctrl"><b>ASC 842</b> ?</span><span class="fn-ctrl">Adjusted ▾</span>`
    + `<span class="fn-ctrl"><b>Periods</b> ${periods} Annuals ▾</span><span class="fn-ctrl"><b>Cur</b> USD ▾</span>`;
  el('view').innerHTML = `<div class="fa-screen">`
    + fnBar('FINANCIAL ANALYSIS', 'FA', eqBox(), controls)
    + `<div class="fa-tabs">${FA_TABS.map(([k, l], i) =>
        `<button class="fa-tab ${k === faCache.tab ? 'active' : ''}" data-tab="${k}"><span class="n">${i + 1})</span>${l}</button>`).join('')}</div>`
    + `<div class="tabrow">${FA_TABS2.map((t) => `<button class="tabrow-tab disabled">${esc(t)}</button>`).join('')}</div>`
    + `<div id="fa-body"><div class="loading">Loading…</div></div>`
    + `</div>`;
  el('view').querySelectorAll('.fa-tab').forEach((b) =>
    b.addEventListener('click', () => { faCache.tab = b.dataset.tab; renderFAShell(); loadFATab(); }));
  setSuggest('<span class="sg">Suggested Functions &nbsp; <b>FA</b> Financial Analysis &nbsp;·&nbsp; <b>EVTS</b> Company Events &nbsp;·&nbsp; <b>MODL</b> Earnings Model &nbsp;·&nbsp; <b>ERN</b> Earnings &nbsp;·&nbsp; <b>DES</b> Description</span>');
}

async function loadFATab() {
  const body = el('fa-body');
  try {
    if (faCache.tab === 'overview') {
      if (!faCache.summary) faCache.summary = await api(`/api/summary/${encodeURIComponent(state.symbol)}`);
      renderFAOverview(faCache.summary, body);
    } else {
      if (!faCache.fin) faCache.fin = await api(`/api/financials/${encodeURIComponent(state.symbol)}`);
      if (faCache.tab === 'ratios') renderFARatios(faCache.fin, body);
      else renderStatement(faCache.fin, faCache.tab, body);
    }
  } catch (err) {
    body.innerHTML = `<div class="err">Unavailable: ${esc(err.message)}</div>
      <div class="muted" style="padding:8px">Yahoo's fundamentals feed needs a session token that can rate-limit. Try again shortly.</div>`;
  }
}

function fmtFin(v, label) {
  if (v == null) return '—';
  if (/EPS/.test(label)) return fmtNum(v, 2);
  return fmtBig(v);
}

// sections = [{ label, rows:[{label, values, fmt?}] }]
function statementTable(years, sections, unit) {
  const hi = (i) => (i === 0 ? ' col-hi' : '');
  const head = `<tr><th class="fin-unit">${esc(unit)}</th>${years.map((y, i) => `<th class="num${hi(i)}">${esc(y)} Y</th>`).join('')}</tr>`
    + `<tr><th class="fin-unit muted" style="font-size:10px">12 Months Ending</th>${years.map((y, i) => `<th class="num muted${hi(i)}" style="font-size:10px">12/31/${esc(y)}</th>`).join('')}</tr>`;
  const bodyHTML = sections.map((sec) => {
    const grp = `<tr class="grp"><td class="fin-label"><span class="tri-c">▼</span>${esc(sec.label)}</td>${years.map((_, i) => `<td class="${hi(i)}"></td>`).join('')}</tr>`;
    const iceCls = sec.ice ? ' est-i' : '';
    const rows = sec.rows.map((r) => `<tr>
      <td class="fin-label indent">${GLYPH}<span>${esc(r.label)}</span></td>
      ${r.values.map((v, i) => (v == null
        ? `<td class="dash${hi(i)}">–</td>`
        : `<td class="num${hi(i)}${iceCls}">${r.fmt ? r.fmt(v) : fmtFin(v, r.label)}</td>`)).join('')}
    </tr>`).join('');
    return grp + rows;
  }).join('');
  return `<div class="tbl-wrap"><table class="fin">${head}${bodyHTML}</table></div>`;
}

// derived analytic rows appended below each statement to fill the workspace
function derivedSections(fin, which) {
  const asPct = (v) => (v == null ? '—' : fmtNum(v, 1) + '%');
  const asX = (v) => (v == null ? '—' : fmtNum(v, 2) + 'x');
  const pct = (a, b) => (a != null && b ? (a / b) * 100 : null);
  const get = (arr, l) => (arr.find((r) => r.label === l) || {}).values || [];
  const drow = (label, fn, fmt) => ({ label, values: fin.years.map((_, i) => fn(i)), fmt });
  const gth = (a) => (i) => (a[i + 1] ? ((a[i] - a[i + 1]) / Math.abs(a[i + 1])) * 100 : null);
  const asN = (v) => (v == null ? '—' : fmtNum(v, 2));
  const first = (v) => fin.years.map((_, i) => (i === 0 ? v : null)); // current-only snapshot column
  if (which === 'income') {
    const rev = get(fin.income, 'Revenue'), gp = get(fin.income, 'Gross Profit'), oi = get(fin.income, 'Operating Income'),
      eb = get(fin.income, 'EBITDA'), ebit = get(fin.income, 'EBIT'), ni = get(fin.income, 'Net Income'),
      pt = get(fin.income, 'Pretax Income'), tx = get(fin.income, 'Tax Provision'), eps = get(fin.income, 'Diluted EPS'),
      sh = get(fin.income, 'Avg Shares'), te = get(fin.balance, 'Total Equity'), fcf = get(fin.cashflow, 'Free Cash Flow');
    const s = faCache.summary || {};
    const ev = (s.marketCap != null && s.totalDebt != null) ? s.marketCap + s.totalDebt - (s.totalCash || 0) : null;
    return [
      { label: 'MARGINS', rows: [
        drow('Gross Margin', (i) => pct(gp[i], rev[i]), asPct),
        drow('Operating Margin', (i) => pct(oi[i], rev[i]), asPct),
        drow('EBIT Margin', (i) => pct(ebit[i], rev[i]), asPct),
        drow('EBITDA Margin', (i) => pct(eb[i], rev[i]), asPct),
        drow('Pretax Margin', (i) => pct(pt[i], rev[i]), asPct),
        drow('Net Margin', (i) => pct(ni[i], rev[i]), asPct),
        drow('Effective Tax Rate', (i) => pct(tx[i], pt[i]), asPct),
      ] },
      { label: 'GROWTH (YoY)', rows: [
        drow('Revenue Growth', gth(rev), asPct),
        drow('Gross Profit Growth', gth(gp), asPct),
        drow('EBITDA Growth', gth(eb), asPct),
        drow('EBIT Growth', gth(ebit), asPct),
        drow('Net Income Growth', gth(ni), asPct),
        drow('EPS Growth', gth(eps), asPct),
      ] },
      { label: 'PER SHARE', rows: [
        drow('Revenue / Share', (i) => (sh[i] ? rev[i] / sh[i] : null), asN),
        drow('FCF / Share', (i) => (sh[i] ? fcf[i] / sh[i] : null), asN),
        drow('Book Value / Share', (i) => (sh[i] ? te[i] / sh[i] : null), asN),
        drow('Diluted EPS', (i) => eps[i], asN),
      ] },
      { label: 'VALUATION (CURRENT)', ice: true, rows: [
        { label: 'Market Cap', values: first(s.marketCap), fmt: fmtBig },
        { label: 'Enterprise Value', values: first(ev), fmt: fmtBig },
        { label: 'EV / EBITDA', values: first(ev && s.ebitda ? ev / s.ebitda : null), fmt: asN },
        { label: 'P / E (TTM)', values: first(s.peTrailing), fmt: asN },
        { label: 'P / FCF', values: first(s.marketCap && s.freeCashflow ? s.marketCap / s.freeCashflow : null), fmt: asN },
        { label: 'Dividend Yield', values: first(s.dividendYield != null ? s.dividendYield * 100 : null), fmt: asPct },
      ] },
    ];
  }
  if (which === 'balance') {
    const ca = get(fin.balance, 'Total Current Assets'), cl = get(fin.balance, 'Total Current Liab.'),
      td = get(fin.balance, 'Total Debt'), te = get(fin.balance, 'Total Equity'), ta = get(fin.balance, 'Total Assets'),
      cash = get(fin.balance, 'Cash & Equivalents');
    return [
      { label: 'BALANCE SHEET SUMMARY', rows: [
        drow('Net Debt', (i) => (td[i] != null ? td[i] - (cash[i] || 0) : null), fmtBig),
        drow('Working Capital', (i) => (ca[i] != null && cl[i] != null ? ca[i] - cl[i] : null), fmtBig),
        drow('Net Debt / EBITDA', (i) => null, asX),
      ] },
      { label: 'LIQUIDITY & LEVERAGE', rows: [
        drow('Current Ratio', (i) => (cl[i] ? ca[i] / cl[i] : null), asX),
        drow('Debt / Equity', (i) => (te[i] ? td[i] / te[i] : null), asX),
        drow('Debt / Assets', (i) => pct(td[i], ta[i]), asPct),
        drow('Equity / Assets', (i) => pct(te[i], ta[i]), asPct),
      ] },
    ];
  }
  if (which === 'cashflow') {
    const ocf = get(fin.cashflow, 'Cash from Operations'), capex = get(fin.cashflow, 'Capital Expenditure'),
      fcf = get(fin.cashflow, 'Free Cash Flow'), div = get(fin.cashflow, 'Dividends Paid'), rep = get(fin.cashflow, 'Stock Repurchased');
    return [
      { label: 'CASH FLOW SUMMARY', rows: [
        drow('Operating Cash Flow', (i) => ocf[i], fmtBig),
        drow('Capital Expenditures', (i) => capex[i], fmtBig),
        drow('Free Cash Flow', (i) => fcf[i], fmtBig),
        drow('Dividends Paid', (i) => div[i], fmtBig),
        drow('Share Repurchases', (i) => rep[i], fmtBig),
      ] },
      { label: 'CASH FLOW ANALYSIS', rows: [
        drow('CapEx % of Op Cash Flow', (i) => (ocf[i] ? pct(Math.abs(capex[i]), ocf[i]) : null), asPct),
        drow('FCF Conversion (FCF/OCF)', (i) => pct(fcf[i], ocf[i]), asPct),
        drow('FCF Margin', (i) => null, asPct),
      ] },
    ];
  }
  return [];
}

function renderStatement(fin, which, body) {
  if (!fin[which] || !fin[which].length) { body.innerHTML = '<div class="muted" style="padding:12px">No data for this statement.</div>'; return; }
  const title = { income: 'INCOME STATEMENT', balance: 'BALANCE SHEET', cashflow: 'STATEMENT OF CASH FLOWS' }[which];
  const sections = [{ label: title, rows: fin[which] }, ...derivedSections(fin, which)];
  body.innerHTML = statementTable(fin.years, sections, 'In Millions of USD');
}

function renderFARatios(fin, body) {
  const find = (arr, label) => (arr.find((r) => r.label === label) || {}).values || [];
  const rev = find(fin.income, 'Revenue'), gp = find(fin.income, 'Gross Profit'),
    oi = find(fin.income, 'Operating Income'), ni = find(fin.income, 'Net Income');
  const ta = find(fin.balance, 'Total Assets'), te = find(fin.balance, 'Total Equity'), td = find(fin.balance, 'Total Debt');
  const fcf = find(fin.cashflow, 'Free Cash Flow');
  const pct = (a, b) => (a != null && b ? (a / b) * 100 : null);
  const ratioRow = (label, fn, fmt) => ({ label, values: fin.years.map((_, i) => fn(i)), fmt });
  const asPct = (v) => (v == null ? '—' : fmtNum(v, 1) + '%');
  const asRatio = (v) => (v == null ? '—' : fmtNum(v, 2));
  const rows = [
    ratioRow('Gross Margin', (i) => pct(gp[i], rev[i]), asPct),
    ratioRow('Operating Margin', (i) => pct(oi[i], rev[i]), asPct),
    ratioRow('Net Margin', (i) => pct(ni[i], rev[i]), asPct),
    ratioRow('FCF Margin', (i) => pct(fcf[i], rev[i]), asPct),
    ratioRow('Return on Assets', (i) => pct(ni[i], ta[i]), asPct),
    ratioRow('Return on Equity', (i) => pct(ni[i], te[i]), asPct),
    ratioRow('Debt / Equity', (i) => (te[i] ? td[i] / te[i] : null), asRatio),
    ratioRow('Revenue Growth', (i) => (rev[i + 1] ? ((rev[i] - rev[i + 1]) / Math.abs(rev[i + 1])) * 100 : null), asPct),
    ratioRow('Net Income Growth', (i) => (ni[i + 1] ? ((ni[i] - ni[i + 1]) / Math.abs(ni[i + 1])) * 100 : null), asPct),
  ];
  body.innerHTML = statementTable(fin.years, [{ label: 'KEY RATIOS', rows }], 'Derived Ratios');
}

function renderFAOverview(s, body) {
  const kv = (k, v, hl) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v ${hl ? 'hl' : ''}">${v}</span></div>`;
  const recKey = (s.recommendationKey || '').toLowerCase();
  const recCls = /buy/.test(recKey) ? 'rec-buy' : /sell|underperform/.test(recKey) ? 'rec-sell' : 'rec-hold';
  const q = state.quote || {};
  let tgt = '';
  if (s.targetLow && s.targetHigh && q.price) {
    const lo = Math.min(s.targetLow, q.price), hi = Math.max(s.targetHigh, q.price);
    const span = hi - lo || 1;
    const pos = (v) => `${((v - lo) / span) * 100}%`;
    tgt = `
      <div class="sec-bar" style="position:static;margin:8px 0 4px">ANALYST PRICE TARGET</div>
      <div class="tgt-bar">
        <div class="tgt-range" style="left:${pos(s.targetLow)};right:${100 - parseFloat(pos(s.targetHigh))}%"></div>
        <div class="tgt-mark cur" style="left:${pos(q.price)}"><span class="tgt-label">Now ${fmtPrice(q.price)}</span></div>
        <div class="tgt-mark mean" style="left:${pos(s.targetMean)}"><span class="tgt-label" style="top:auto;bottom:100%">Tgt ${fmtPrice(s.targetMean)}</span></div>
      </div>
      <div class="kv-grid" style="margin-top:14px">
        ${kv('Mean Target', fmtPrice(s.targetMean), true)}
        ${kv('High / Low', `${fmtPrice(s.targetHigh)} / ${fmtPrice(s.targetLow)}`)}
        ${kv('Upside', `<span class="${chgClass(s.targetMean - q.price)}">${fmtPct(((s.targetMean - q.price) / q.price) * 100)}</span>`)}
        ${kv('# Analysts', fmtRatio(s.numberOfAnalysts, 0))}
      </div>`;
  }
  body.innerHTML = `<div class="sec-body">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:6px">
      <span class="rec-badge ${recCls}">${esc((s.recommendationKey || 'n/a').toUpperCase())}</span>
      <span class="muted">Consensus rating${s.recommendationMean != null ? ` · score ${fmtRatio(s.recommendationMean)}/5 (1=Strong Buy)` : ''}</span>
    </div>
    <div class="sec-bar" style="position:static;margin:4px 0">VALUATION</div>
    <div class="kv-grid">
      ${kv('Market Cap', fmtBig(s.marketCap), true)}
      ${kv('P/E (TTM)', fmtRatio(s.peTrailing))}
      ${kv('P/E (Fwd)', fmtRatio(s.peForward))}
      ${kv('PEG Ratio', fmtRatio(s.pegRatio))}
      ${kv('Price/Book', fmtRatio(s.priceToBook))}
      ${kv('EPS (TTM)', fmtPrice(s.eps))}
      ${kv('Beta', fmtRatio(s.beta))}
      ${kv('Div Yield', s.dividendYield ? fmtPct(s.dividendYield * 100) : '—')}
      ${kv('Div Rate', s.dividendRate ? fmtPrice(s.dividendRate) : '—')}
      ${kv('Payout Ratio', s.payoutRatio ? fmtPct(s.payoutRatio * 100) : '—')}
    </div>
    <div class="sec-bar" style="position:static;margin:8px 0 4px">PROFITABILITY & GROWTH</div>
    <div class="kv-grid">
      ${kv('Revenue (TTM)', fmtBig(s.revenue), true)}
      ${kv('Rev Growth', s.revenueGrowth != null ? `<span class="${chgClass(s.revenueGrowth)}">${fmtPct(s.revenueGrowth * 100)}</span>` : '—')}
      ${kv('Earnings Growth', s.earningsGrowth != null ? `<span class="${chgClass(s.earningsGrowth)}">${fmtPct(s.earningsGrowth * 100)}</span>` : '—')}
      ${kv('Gross Margin', s.grossMargin != null ? fmtPct(s.grossMargin * 100) : '—')}
      ${kv('Oper Margin', s.operatingMargin != null ? fmtPct(s.operatingMargin * 100) : '—')}
      ${kv('Profit Margin', s.profitMargin != null ? fmtPct(s.profitMargin * 100) : '—')}
      ${kv('ROE', s.roe != null ? fmtPct(s.roe * 100) : '—')}
      ${kv('ROA', s.roa != null ? fmtPct(s.roa * 100) : '—')}
      ${kv('EBITDA', fmtBig(s.ebitda))}
      ${kv('Free Cash Flow', fmtBig(s.freeCashflow))}
    </div>
    <div class="sec-bar" style="position:static;margin:8px 0 4px">BALANCE SHEET & OWNERSHIP</div>
    <div class="kv-grid">
      ${kv('Total Cash', fmtBig(s.totalCash))}
      ${kv('Total Debt', fmtBig(s.totalDebt))}
      ${kv('Debt/Equity', fmtRatio(s.debtToEquity))}
      ${kv('Current Ratio', fmtRatio(s.currentRatio))}
      ${kv('Shares Out', fmtBig(s.sharesOut))}
      ${kv('Float', fmtBig(s.floatShares))}
      ${kv('% Insiders', s.heldPctInsiders != null ? fmtPct(s.heldPctInsiders * 100) : '—')}
      ${kv('% Institutions', s.heldPctInstitutions != null ? fmtPct(s.heldPctInstitutions * 100) : '—')}
      ${kv('Short % Float', s.shortPctFloat != null ? fmtPct(s.shortPctFloat * 100) : '—')}
      ${kv('Next Earnings', fmtDate(s.nextEarningsDate))}
    </div>
    ${tgt}</div>`;
}

/* ---------------------------------------------------------------- ERN */

async function showERN() {
  if (!state.symbol) { msg('Load a security first', true); return; }
  setActiveTabs(null); markFunc('ERN');
  el('view').innerHTML = `<div class="fa-screen">` + fnBar('EARNINGS', 'ERN', eqBox()) + `<div class="mon-grid cols-2">
    <div class="section span2">${secBar('QUARTERLY EPS — ESTIMATE vs ACTUAL')}<div class="sec-body" id="ern-q"><div class="loading">…</div></div></div>
    <div class="section">${secBar('ANNUAL REVENUE & EARNINGS')}<div class="sec-body pad0" id="ern-a"><div class="loading">…</div></div></div>
    <div class="section">${secBar('REVENUE TREND')}<div class="sec-body pad0"><div class="mon-chart"><canvas id="ern-rev"></canvas></div></div></div>
    <div class="section">${secBar('EARNINGS TREND')}<div class="sec-body pad0"><div class="mon-chart"><canvas id="ern-earn"></canvas></div></div></div>
    <div class="section">${secBar('EARNINGS SUMMARY')}<div class="sec-body" id="ern-s"><div class="loading">…</div></div></div>
  </div></div>`;
  try {
    const s = await api(`/api/summary/${encodeURIComponent(state.symbol)}`);
    const q = s.earningsQuarterly || [], y = s.yearly || [];
    if (!q.length && !y.length) { el('view').querySelector('.mon-grid').innerHTML = '<div class="muted" style="padding:12px">No earnings data available for this security.</div>'; return; }
    const maxEps = Math.max(1, ...q.flatMap((r) => [Math.abs(r.actual || 0), Math.abs(r.estimate || 0)]));
    el('ern-q').innerHTML = `<div class="earn-row" style="height:110px">${q.map((r) => {
      const beat = r.actual != null && r.estimate != null ? r.actual - r.estimate : null;
      const bh = (v) => `${Math.max(2, (Math.abs(v || 0) / maxEps) * 74)}px`;
      return `<div class="earn-col">
        <div class="earn-beat ${beat == null ? 'muted' : chgClass(beat)}">${beat == null ? '' : (beat >= 0 ? '+' : '') + fmtNum(beat)}</div>
        <div class="earn-bars" style="height:78px"><div class="earn-bar est" style="height:${bh(r.estimate)}" title="Est ${fmtNum(r.estimate)}"></div><div class="earn-bar act" style="height:${bh(r.actual)}" title="Act ${fmtNum(r.actual)}"></div></div>
        <div class="earn-lbl">${esc(r.period)}</div></div>`;
    }).join('')}</div>
      <div class="muted" style="font-size:11px;padding:0 4px"><span style="color:var(--muted)">▉</span> estimate &nbsp; <span style="color:var(--orange)">▉</span> actual &nbsp; number = surprise (EPS)</div>`;
    el('ern-a').innerHTML = `<div class="tbl-wrap"><table class="data">
      <tr><th>YEAR</th><th class="num">REVENUE</th><th class="num">EARNINGS</th><th class="num">NET MARGIN</th></tr>
      ${y.map((r) => `<tr><td class="hl">${esc(r.year)}</td><td class="num">${fmtBig(r.revenue)}</td><td class="num">${fmtBig(r.earnings)}</td><td class="num">${r.revenue ? fmtPct((r.earnings / r.revenue) * 100) : '—'}</td></tr>`).join('')}
    </table></div>`;
    const lastQ = q[q.length - 1] || {};
    const beatCt = q.filter((r) => r.actual != null && r.estimate != null && r.actual >= r.estimate).length;
    const row = (k, v, cls = '') => `<div class="kv"><span class="k">${esc(k)}</span><span class="v ${cls}">${v}</span></div>`;
    el('ern-s').innerHTML = `<div class="kv-grid" style="grid-template-columns:1fr;padding:2px 6px">
      ${row('Next Earnings', fmtDate(s.nextEarningsDate), 'hl')}
      ${row('Last Qtr', esc(lastQ.period || '—'))}
      ${row('Last Actual EPS', lastQ.actual != null ? fmtNum(lastQ.actual, 2) : '—')}
      ${row('Last Est EPS', lastQ.estimate != null ? fmtNum(lastQ.estimate, 2) : '—')}
      ${row('Last Surprise', lastQ.actual != null && lastQ.estimate != null ? `<span class="${chgClass(lastQ.actual - lastQ.estimate)}">${(lastQ.actual - lastQ.estimate >= 0 ? '+' : '') + fmtNum(lastQ.actual - lastQ.estimate, 2)}</span>` : '—')}
      ${row('Beats (last ' + q.length + ')', `${beatCt} / ${q.length}`, 'pos')}
      ${row('EPS (TTM)', fmtPrice(s.eps))}
      ${row('Fwd P/E', fmtRatio(s.peForward))}
    </div>`;
    drawMiniChart('ern-rev', y.map((r) => r.revenue).filter((v) => v != null), '#f6a313');
    drawMiniChart('ern-earn', y.map((r) => r.earnings).filter((v) => v != null), '#4ec8ff');
  } catch (err) { el('view').querySelector('.mon-grid').innerHTML = `<div class="err">${esc(err.message)}</div>`; }
}

/* --------------------------------------------------------------- news */

function newsHTML(items, limit = 40) {
  if (!items.length) return '<div class="muted" style="padding:8px">No stories found.</div>';
  return items.slice(0, limit).map((n) => `
    <div class="news-item">
      <a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a>
      <div class="news-meta"><span class="src">${esc(n.source || '')}</span> · ${timeAgo(n.time)}</div>
    </div>`).join('');
}

async function showNews() {
  if (!state.symbol) { msg('Load a security first', true); return; }
  setActiveTabs(null);
  el('view').innerHTML = fnBar('COMPANY NEWS', 'CN', eqBox()) + `<div class="sec-body"><div class="loading">Loading…</div></div>`;
  const body = el('view').querySelector('.sec-body');
  try {
    const data = await api(`/api/news?symbol=${encodeURIComponent(state.symbol)}`);
    body.innerHTML = newsHTML(data.items);
  } catch (err) { body.innerHTML = `<div class="err">${esc(err.message)}</div>`; }
}

async function showTopNews() {
  state.view = 'TOP'; setActiveTabs('TOP'); markFunc(null); setTab('TOP Top News', 'TOP');
  el('view').innerHTML = fnBar('TOP MARKET NEWS', 'TOP', 'TOP News') + `<div class="sec-body"><div class="loading">Loading…</div></div>`;
  const body = el('view').querySelector('.sec-body');
  try {
    const data = await api('/api/news?symbol=SPY');
    body.innerHTML = newsHTML(data.items, 40);
  } catch (err) { body.innerHTML = `<div class="err">${esc(err.message)}</div>`; }
}

/* ------------------------------------------------ generic board (quotes) */

async function quoteBoard(symbols) {
  const quotes = await api(`/api/quotes?symbols=${encodeURIComponent(symbols.join(','))}`);
  const byName = {};
  quotes.forEach((q) => { q._flash = q.error ? '' : tickDir(q.symbol, q.price); byName[q.symbol] = q; });
  return byName;
}

function boardTable(rows, byName, opts = {}) {
  const extraHead = opts.extraHead || '';
  const extraCell = opts.extraCell || (() => '');
  const spark = opts.spark !== false;
  return `<div class="tbl-wrap"><table class="data">
    <tr><th>NAME</th><th class="num">LAST</th><th class="num">CHG</th><th class="num">CHG%</th>${spark ? '<th>1D</th>' : ''}${extraHead}</tr>
    ${rows.map(([sym, label]) => {
      const q = byName[sym];
      if (!q || q.error) return `<tr><td>${esc(label)}</td><td class="num muted" colspan="${spark ? 4 : 3}">n/a</td>${extraCell(null)}</tr>`;
      return `<tr class="click" data-sym="${esc(sym)}">
        <td><span class="sym-cell">${esc(label)}</span></td>
        <td class="num ${q._flash || ''}">${fmtPrice(q.price)}</td>
        <td class="num ${chgClass(q.change)}">${arrow(q.change)} ${fmtNum(Math.abs(q.change))}</td>
        <td class="num ${chgClass(q.change)}">${fmtNum(Math.abs(q.changePct))}%</td>
        ${spark ? `<td class="spark-td">${sparkCell(sym)}</td>` : ''}
        ${extraCell(q)}
      </tr>`;
    }).join('')}
  </table></div>`;
}

function wireRows(container) {
  container.querySelectorAll('.click[data-sym]').forEach((row) =>
    row.addEventListener('click', () => loadSecurity(row.dataset.sym, 'GP')));
  fillSparks(container); // fire-and-forget; draws into any .spark canvases
}

/* -------------------------------------------------------- WEI (world) */

const WEI_REGIONS = {
  'AMERICAS': [['^GSPC', 'S&P 500'], ['^DJI', 'Dow Jones'], ['^IXIC', 'Nasdaq Comp'], ['^NDX', 'Nasdaq 100'], ['^RUT', 'Russell 2000'], ['^GSPTSE', 'S&P/TSX (CA)'], ['^BVSP', 'Bovespa (BR)'], ['^MXX', 'IPC (MX)']],
  'EMEA': [['^FTSE', 'FTSE 100 (UK)'], ['^GDAXI', 'DAX (DE)'], ['^FCHI', 'CAC 40 (FR)'], ['^STOXX50E', 'Euro Stoxx 50'], ['^IBEX', 'IBEX 35 (ES)'], ['FTSEMIB.MI', 'FTSE MIB (IT)'], ['^AEX', 'AEX (NL)'], ['^SSMI', 'SMI (CH)']],
  'ASIA / PACIFIC': [['^N225', 'Nikkei 225 (JP)'], ['^HSI', 'Hang Seng (HK)'], ['000001.SS', 'Shanghai (CN)'], ['^AXJO', 'ASX 200 (AU)'], ['^BSESN', 'Sensex (IN)'], ['^NSEI', 'Nifty 50 (IN)'], ['^KS11', 'KOSPI (KR)'], ['^TWII', 'Taiwan']],
};
const WEI_VOL = [['^VIX', 'VIX (S&P)'], ['^VXN', 'VXN (Nasdaq)'], ['^OVX', 'Oil VIX'], ['^GVZ', 'Gold VIX'], ['^RVX', 'Russell VIX']];
const WEI_FUT = [['ES=F', 'S&P Fut'], ['NQ=F', 'Nasdaq Fut'], ['YM=F', 'Dow Fut'], ['RTY=F', 'Russell Fut'], ['NKD=F', 'Nikkei Fut'], ['GC=F', 'Gold Fut']];

async function showWEI() {
  state.view = 'WEI'; setActiveTabs('WEI'); markFunc(null); setTab('WEI World Eq Idx', 'WEI');
  el('view').innerHTML = `<div class="fa-screen">` + fnBar('WORLD EQUITY INDICES', 'WEI', 'WEI Monitor') + `<div class="wei-grid" id="wei-body"><div class="loading">Loading…</div></div></div>`;
  try {
    const all = [...Object.values(WEI_REGIONS).flat(), ...WEI_VOL, ...WEI_FUT].map((r) => r[0]);
    const byName = await quoteBoard(all);
    const panel = (title, rows) => `<div class="section">${secBar(title)}<div class="sec-body pad0">${boardTable(rows, byName, { spark: false })}</div></div>`;
    // breadth across all region indices
    const idxAll = Object.values(WEI_REGIONS).flat();
    const up = idxAll.filter(([s]) => (byName[s] && !byName[s].error && byName[s].change > 0)).length;
    const dn = idxAll.filter(([s]) => (byName[s] && !byName[s].error && byName[s].change < 0)).length;
    const upPct = (up + dn) ? (up / (up + dn)) * 100 : 50;
    el('wei-body').innerHTML =
      Object.entries(WEI_REGIONS).map(([r, rows]) => panel(r, rows)).join('')
      + panel('VOLATILITY INDICES', WEI_VOL)
      + panel('INDEX FUTURES', WEI_FUT)
      + `<div class="section">${secBar('GLOBAL BREADTH')}<div class="sec-body" style="font-family:var(--font-data)">
          <div style="display:flex;justify-content:space-between;font-size:13px;padding:2px 0"><span class="pos">▲ ${up} Up</span><span class="neg">${dn} Down ▼</span></div>
          <div style="height:16px;background:var(--red-down);display:flex;margin:4px 0"><div style="background:var(--green-fill);width:${upPct}%"></div></div>
          <div class="muted" style="font-size:11px">${fmtNum(upPct, 0)}% of world indices advancing</div>
          <div style="margin-top:6px;font-size:12px" class="${up >= dn ? 'pos' : 'neg'}">GLOBAL RISK ${up >= dn ? 'ON' : 'OFF'}</div>
        </div></div>`;
    wireRows(el('wei-body'));
  } catch (err) { el('wei-body').innerHTML = `<div class="err">${esc(err.message)}</div>`; }
}

/* -------------------------------------------------------- CMDTY */

function loadMonChart(id, symbol, color, range = '1d') {
  api(`/api/history/${encodeURIComponent(symbol)}?range=${range}`).then((d) => {
    const closes = (d.candles || []).map((c) => c.c);
    const up = closes.length && closes[closes.length - 1] >= closes[0];
    drawMiniChart(id, closes, color || (up ? '#00c853' : '#ff3d57'));
  }).catch(() => {});
}

function drawDonut(canvas, segs) {
  if (!canvas || !segs.length) return;
  const dpr = window.devicePixelRatio || 1;
  const rct = canvas.getBoundingClientRect();
  if (!rct.width) return;
  canvas.width = rct.width * dpr; canvas.height = rct.height * dpr;
  const cx = canvas.getContext('2d'); cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = rct.width, H = rct.height, R = Math.min(W, H) / 2 - 2, ir = R * 0.55;
  const total = segs.reduce((a, sg) => a + sg.v, 0) || 1;
  let a0 = -Math.PI / 2;
  for (const sg of segs) {
    const a1 = a0 + (sg.v / total) * Math.PI * 2;
    cx.beginPath();
    cx.moveTo(W / 2 + Math.cos(a0) * ir, H / 2 + Math.sin(a0) * ir);
    cx.arc(W / 2, H / 2, R, a0, a1);
    cx.arc(W / 2, H / 2, ir, a1, a0, true);
    cx.closePath();
    cx.fillStyle = sg.color; cx.fill();
    cx.strokeStyle = '#000'; cx.lineWidth = 1; cx.stroke();
    a0 = a1;
  }
}

const CMDTY_GROUPS = {
  'ENERGY': [['CL=F', 'WTI Crude'], ['BZ=F', 'Brent Crude'], ['NG=F', 'Natural Gas'], ['RB=F', 'Gasoline'], ['HO=F', 'Heating Oil']],
  'METALS': [['GC=F', 'Gold'], ['SI=F', 'Silver'], ['PL=F', 'Platinum'], ['PA=F', 'Palladium'], ['HG=F', 'Copper']],
  'AGRICULTURE': [['ZC=F', 'Corn'], ['ZW=F', 'Wheat'], ['ZS=F', 'Soybeans'], ['KC=F', 'Coffee'], ['SB=F', 'Sugar'], ['CT=F', 'Cotton'], ['CC=F', 'Cocoa']],
  'SOFTS & LIVESTOCK': [['LE=F', 'Live Cattle'], ['GF=F', 'Feeder Cattle'], ['HE=F', 'Lean Hogs'], ['OJ=F', 'Orange Juice'], ['LBS=F', 'Lumber']],
};

async function showCommodities() {
  state.view = 'CMDTY'; setActiveTabs(null); markFunc(null); setTab('CMDTY Commodities', 'CMDTY');
  el('view').innerHTML = `<div class="fa-screen">` + fnBar('COMMODITIES', 'CMDTY', 'CMDTY Monitor') + `<div class="mon-grid cols-3 tfill" id="cmdty-body">
    <div class="section">${secBar('ENERGY')}<div class="sec-body pad0" id="cm-energy"><div class="loading">…</div></div></div>
    <div class="section">${secBar('METALS')}<div class="sec-body pad0" id="cm-metals"><div class="loading">…</div></div></div>
    <div class="section">${secBar('AGRICULTURE')}<div class="sec-body pad0" id="cm-ag"><div class="loading">…</div></div></div>
    <div class="section">${secBar('SOFTS & LIVESTOCK')}<div class="sec-body pad0" id="cm-soft"><div class="loading">…</div></div></div>
    <div class="section">${secBar('GOLD · INTRADAY')}<div class="sec-body pad0"><div class="mon-chart"><canvas id="cm-gold"></canvas></div></div></div>
    <div class="section">${secBar('WTI CRUDE · INTRADAY')}<div class="sec-body pad0"><div class="mon-chart"><canvas id="cm-wti"></canvas></div></div></div>
  </div></div>`;
  try {
    const byName = await quoteBoard(Object.values(CMDTY_GROUPS).flat().map((r) => r[0]));
    const set = (id, rows) => { const e = el(id); if (e) { e.innerHTML = boardTable(rows, byName, { spark: false }); wireRows(e); } };
    set('cm-energy', CMDTY_GROUPS.ENERGY); set('cm-metals', CMDTY_GROUPS.METALS);
    set('cm-ag', CMDTY_GROUPS.AGRICULTURE); set('cm-soft', CMDTY_GROUPS['SOFTS & LIVESTOCK']);
    loadMonChart('cm-gold', 'GC=F', '#ffe45c'); loadMonChart('cm-wti', 'CL=F');
  } catch (err) { el('cmdty-body').innerHTML = `<div class="err">${esc(err.message)}</div>`; }
}

/* -------------------------------------------------------- GOVT / rates */

async function showRates() {
  state.view = 'GOVT'; setActiveTabs(null); markFunc(null); setTab('GOVT Rates', 'GOVT');
  const YIELDS = [['^IRX', 'US 3-Month'], ['^FVX', 'US 5-Year'], ['^TNX', 'US 10-Year'], ['^TYX', 'US 30-Year']];
  el('view').innerHTML = `<div class="fa-screen">` + fnBar('US TREASURY YIELDS & FUTURES', 'GOVT', 'GOVT Monitor') + `<div class="mon-grid cols-2 tfill">
    <div class="section">${secBar('BENCHMARK YIELDS (%)')}<div class="sec-body pad0" id="gv-yield"><div class="loading">…</div></div></div>
    <div class="section">${secBar('TREASURY FUTURES')}<div class="sec-body pad0" id="gv-fut"><div class="loading">…</div></div></div>
    <div class="section">${secBar('US YIELD CURVE')}<div class="sec-body pad0"><div class="mon-chart"><canvas id="gv-curve"></canvas></div></div></div>
    <div class="section">${secBar('KEY SPREADS (bp)')}<div class="sec-body" id="gv-spread"><div class="loading">…</div></div></div>
  </div></div>`;
  try {
    const byName = await quoteBoard([...YIELDS, ...RATE_FUT].map((r) => r[0]));
    const yy = el('gv-yield'); if (yy) { yy.innerHTML = boardTable(YIELDS, byName, { spark: false }); wireRows(yy); }
    const ff = el('gv-fut'); if (ff) { ff.innerHTML = boardTable(RATE_FUT, byName, { spark: false }); wireRows(ff); }
    const y3 = byName['^IRX']?.price, y5 = byName['^FVX']?.price, y10 = byName['^TNX']?.price, y30 = byName['^TYX']?.price;
    drawMiniChart('gv-curve', [y3, y5, y10, y30].filter((v) => v != null), '#ffe45c');
    const bp = (a, b) => (a != null && b != null ? Math.round((a - b) * 100) : null);
    const sp = (k, v) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v ${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${v == null ? '—' : (v > 0 ? '+' : '') + v + ' bp'}</span></div>`;
    el('gv-spread').innerHTML = `<div class="kv-grid" style="grid-template-columns:1fr">
      ${sp('10Y − 3M', bp(y10, y3))}${sp('10Y − 5Y', bp(y10, y5))}${sp('30Y − 10Y', bp(y30, y10))}${sp('30Y − 5Y', bp(y30, y5))}
      <div class="kv"><span class="k">Curve</span><span class="v ${bp(y10, y3) >= 0 ? 'pos' : 'neg'}">${bp(y10, y3) >= 0 ? 'NORMAL' : 'INVERTED'}</span></div>
    </div>`;
  } catch (err) { el('view').querySelector('.mon-grid').innerHTML = `<div class="err">${esc(err.message)}</div>`; }
}

/* -------------------------------------------------------- MOST (movers) */

function moversTable(rows) {
  return `<div class="tbl-wrap"><table class="data">
    <tr><th>SYM</th><th>NAME</th><th class="num">LAST</th><th class="num">CHG%</th><th>1D</th><th class="num">VOLUME</th></tr>
    ${rows.map((r) => `<tr class="click" data-sym="${esc(r.symbol)}">
      <td class="sym">${esc(r.symbol)}</td><td class="muted">${esc((r.name || '').slice(0, 22))}</td>
      <td class="num">${fmtPrice(r.price)}</td>
      <td class="num ${chgClass(r.change)}">${arrow(r.change)} ${fmtNum(Math.abs(r.changePct))}%</td>
      <td class="spark-td">${sparkCell(r.symbol)}</td>
      <td class="num">${fmtBig(r.volume)}</td>
    </tr>`).join('')}
  </table></div>`;
}

async function showMovers() {
  state.view = 'MOST'; setActiveTabs('MOST'); markFunc(null); setTab('MOST Movers', 'MOST');
  el('view').innerHTML = `<div class="fa-screen">` + fnBar('US MARKET MOVERS', 'MOST', 'MOST Movers') + `<div class="mv-grid">
    <div class="section"><div class="sec-bar">TOP GAINERS <span class="right pos">▲</span></div><div class="sec-body pad0" id="mv-g"><div class="loading">…</div></div></div>
    <div class="section"><div class="sec-bar">TOP LOSERS <span class="right neg">▼</span></div><div class="sec-body pad0" id="mv-l"><div class="loading">…</div></div></div>
    <div class="section"><div class="sec-bar">MOST ACTIVE <span class="right muted">VOL</span></div><div class="sec-body pad0" id="mv-a"><div class="loading">…</div></div></div>
  </div></div>`;
  const ids = { gainers: 'mv-g', losers: 'mv-l', actives: 'mv-a' };
  Object.entries(ids).forEach(([t, id]) => {
    api(`/api/movers?type=${t}`).then((d) => { const e = el(id); if (e) { e.innerHTML = moversTable(d.rows); wireRows(e); } })
      .catch(() => { const e = el(id); if (e) e.innerHTML = '<div class="err">unavailable</div>'; });
  });
}

/* ----------------------------------------------------------------- FX */

async function showFX() {
  state.view = 'FX'; setActiveTabs(null); markFunc(null); setTab('FX Currencies', 'FX');
  el('view').innerHTML = `<div class="fa-screen">` + fnBar('CURRENCY RATES (ECB REFERENCE)', 'FX', 'FX Monitor') + `<div class="mon-grid cols-2 tfill">
    <div class="section">${secBar('USD MAJORS')}<div class="sec-body pad0" id="fx-maj"><div class="loading">…</div></div></div>
    <div class="section">${secBar('USD EM / ASIA')}<div class="sec-body pad0" id="fx-em"><div class="loading">…</div></div></div>
    <div class="section">${secBar('CROSS RATES')}<div class="sec-body" id="fx-cross"><div class="loading">…</div></div></div>
    <div class="section">${secBar('US DOLLAR INDEX · INTRADAY')}<div class="sec-body pad0"><div class="mon-chart"><canvas id="fx-dxy"></canvas></div></div></div>
  </div></div>`;
  try {
    const data = await api('/api/fx?base=USD');
    const R = {}; data.rates.forEach((r) => { R[r.ccy] = r; });
    const rowFor = (ccy, invert) => {
      const r = R[ccy]; if (!r) return '';
      const rate = invert ? 1 / r.rate : r.rate, chg = invert ? -r.changePct : r.changePct;
      const label = invert ? `${ccy}/USD` : `USD/${ccy}`, sym = invert ? `${ccy}USD=X` : `USD${ccy}=X`;
      return `<tr class="click" data-sym="${esc(sym)}"><td class="sym">${esc(label)}</td><td class="num">${fmtNum(rate, 4)}</td>
        <td class="num ${chgClass(chg)}">${arrow(chg)} ${fmtNum(Math.abs(chg))}%</td></tr>`;
    };
    const tbl = (pairs) => `<div class="tbl-wrap"><table class="data"><tr><th>PAIR</th><th class="num">RATE</th><th class="num">CHG%</th></tr>${pairs.map(([c, inv]) => rowFor(c, inv)).join('')}</table></div>`;
    const maj = el('fx-maj'); if (maj) { maj.innerHTML = tbl([['EUR', 1], ['GBP', 1], ['JPY', 0], ['CHF', 0], ['CAD', 0], ['AUD', 1], ['NZD', 1]]); wireRows(maj); }
    const em = el('fx-em'); if (em) { em.innerHTML = tbl([['CNY', 0], ['INR', 0], ['MXN', 0], ['BRL', 0], ['KRW', 0], ['ZAR', 0], ['SEK', 0], ['NOK', 0]]); wireRows(em); }
    const g = (c) => R[c]?.rate;
    const cross = (a, b, v) => `<div class="kv"><span class="k">${a}/${b}</span><span class="v hl">${v ? fmtNum(v, 4) : '—'}</span></div>`;
    el('fx-cross').innerHTML = `<div class="kv-grid" style="grid-template-columns:1fr 1fr;padding:2px 6px">
      ${cross('EUR', 'USD', g('EUR') ? 1 / g('EUR') : null)}${cross('GBP', 'USD', g('GBP') ? 1 / g('GBP') : null)}
      ${cross('AUD', 'USD', g('AUD') ? 1 / g('AUD') : null)}${cross('USD', 'JPY', g('JPY'))}
      ${cross('EUR', 'GBP', g('EUR') && g('GBP') ? g('GBP') / g('EUR') : null)}${cross('EUR', 'JPY', g('EUR') && g('JPY') ? g('JPY') / g('EUR') : null)}
      ${cross('GBP', 'JPY', g('GBP') && g('JPY') ? g('JPY') / g('GBP') : null)}${cross('EUR', 'CHF', g('EUR') && g('CHF') ? g('CHF') / g('EUR') : null)}
    </div><div class="muted" style="padding:2px 6px;font-size:11px">Base USD · ECB reference · ${esc(data.date)}</div>`;
    loadMonChart('fx-dxy', 'DX-Y.NYB', '#ffe45c');
  } catch (err) { el('view').querySelector('.mon-grid').innerHTML = `<div class="err">${esc(err.message)}</div>`; }
}

/* -------------------------------------------------------------- crypto */

async function showCrypto() {
  state.view = 'CRYP'; setActiveTabs(null); markFunc(null); setTab('CRYP Crypto', 'CRYP');
  el('view').innerHTML = `<div class="fa-screen">` + fnBar('CRYPTOCURRENCY MARKET', 'CRYP', 'CRYP Monitor') + `<div class="mon-grid cols-3">
    <div class="section span2 rows2">${secBar('CRYPTOCURRENCY MARKET · TOP 25', 'CoinGecko')}<div class="sec-body pad0" id="cy-tbl"><div class="loading">…</div></div></div>
    <div class="section">${secBar('BTC-USD · INTRADAY')}<div class="sec-body pad0"><div class="mon-chart"><canvas id="cy-btc"></canvas></div></div></div>
    <div class="section">${secBar('CRYPTO HEATMAP · 24H')}<div class="sec-body pad0" id="cy-heat"><div class="loading">…</div></div></div>
  </div></div>`;
  try {
    const coins = await api('/api/crypto');
    const t = el('cy-tbl');
    if (t) {
      t.innerHTML = `<div class="tbl-wrap"><table class="data">
        <tr><th>#</th><th>SYM</th><th>NAME</th><th class="num">PRICE</th><th class="num">24H%</th><th class="num">24H RANGE</th><th class="num">MKT CAP</th><th class="num">VOLUME</th></tr>
        ${coins.map((c, i) => `<tr class="click" data-sym="${esc(c.symbol)}-USD">
          <td class="muted">${i + 1}</td><td class="sym">${esc(c.symbol)}</td><td class="muted">${esc(c.name)}</td>
          <td class="num">${fmtPrice(c.price)}</td>
          <td class="num ${chgClass(c.changePct)}">${arrow(c.changePct)} ${fmtNum(Math.abs(c.changePct))}%</td>
          <td class="num muted">${fmtPrice(c.low24h)} – ${fmtPrice(c.high24h)}</td>
          <td class="num">${fmtBig(c.marketCap)}</td><td class="num">${fmtBig(c.volume)}</td>
        </tr>`).join('')}
      </table></div>`;
      wireRows(t);
    }
    const h = el('cy-heat');
    if (h) {
      const bn = Object.fromEntries(coins.map((c) => [`${c.symbol}-USD`, { changePct: c.changePct, change: c.changePct }]));
      h.innerHTML = heatGrid(coins.slice(0, 24).map((c) => [`${c.symbol}-USD`, c.symbol]), bn);
      wireRows(h);
    }
    loadMonChart('cy-btc', 'BTC-USD');
  } catch (err) { el('view').querySelector('.mon-grid').innerHTML = `<div class="err">${esc(err.message)}</div>`; }
}

/* ---------------------------------------------------------- watchlist */

async function showWatchlist() {
  state.view = 'W'; setActiveTabs('W'); markFunc(null); setTab('W Watchlist', 'W');
  el('view').innerHTML = fnBar('WATCHLIST / PORTFOLIO', 'W', 'W Portfolio') + `<div id="wl-body"><div class="loading">Loading…</div></div>`;
  if (!state.watchlist.length) { el('wl-body').innerHTML = '<div class="muted" style="padding:12px">Watchlist empty. Add with <span class="hl">W ADD NVDA</span>.</div>'; return; }
  try {
    const quotes = await api(`/api/quotes?symbols=${encodeURIComponent(state.watchlist.join(','))}`);
    el('wl-body').innerHTML = `<div class="tbl-wrap"><table class="data">
      <tr><th>SYM</th><th>NAME</th><th class="num">LAST</th><th class="num">CHG</th><th class="num">CHG%</th><th>1D</th><th class="num">VOLUME</th><th></th></tr>
      ${quotes.map((q) => q.error
        ? `<tr><td class="sym">${esc(q.symbol)}</td><td class="neg" colspan="7">unavailable</td></tr>`
        : `<tr class="click" data-sym="${esc(q.symbol)}">
            <td class="sym">${esc(q.symbol)}</td><td class="muted">${esc((q.name || '').slice(0, 30))}</td>
            <td class="num">${fmtPrice(q.price)}</td>
            <td class="num ${chgClass(q.change)}">${arrow(q.change)} ${fmtNum(Math.abs(q.change))}</td>
            <td class="num ${chgClass(q.change)}">${fmtNum(Math.abs(q.changePct))}%</td>
            <td class="spark-td">${sparkCell(q.symbol)}</td>
            <td class="num">${fmtBig(q.volume)}</td>
            <td class="num"><button class="wl-del" data-del="${esc(q.symbol)}" style="background:transparent;border:1px solid var(--line);color:var(--red);font-size:10px;padding:0 6px">✕</button></td>
          </tr>`).join('')}
    </table></div>`;
    wireRows(el('wl-body'));
    el('wl-body').querySelectorAll('.wl-del').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      state.watchlist = state.watchlist.filter((s) => s !== b.dataset.del);
      saveWatchlist(); showWatchlist();
    }));
  } catch (err) { el('wl-body').innerHTML = `<div class="err">${esc(err.message)}</div>`; }
}

/* ------------------------------------------------------------ SEARCH */

async function showSearch(query) {
  state.view = 'SECF'; setActiveTabs(null); markFunc(null); setTab(`SECF ${query}`.slice(0, 24), `S ${query}`);
  el('view').innerHTML = fnBar('SECURITY FINDER', 'SECF', 'SECF Search') + `<div id="sf-body"><div class="loading">Searching…</div></div>`;
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(query)}`);
    if (!data.quotes.length) { el('sf-body').innerHTML = `<div class="muted" style="padding:12px">No matches for "${esc(query)}".</div>`; return; }
    el('sf-body').innerHTML = `<div class="tbl-wrap"><table class="data">
      <tr><th>SYMBOL</th><th>NAME</th><th>TYPE</th><th>EXCHANGE</th><th>SECTOR</th></tr>
      ${data.quotes.map((q) => `<tr class="click" data-sym="${esc(q.symbol)}">
        <td class="sym">${esc(q.symbol)}</td><td>${esc(q.name)}</td>
        <td class="muted">${esc(q.type)}</td><td class="muted">${esc(q.exchange)}</td><td class="muted">${esc(q.sector)}</td>
      </tr>`).join('')}
    </table></div>`;
    wireRows(el('sf-body'));
  } catch (err) { el('sf-body').innerHTML = `<div class="err">${esc(err.message)}</div>`; }
}

/* --------------------------------------------------------- LAUNCHPAD */

const LP_CITIES = [['NEW YORK', 'America/New_York'], ['LONDON', 'Europe/London'], ['HONG KONG', 'Asia/Hong_Kong'], ['TOKYO', 'Asia/Tokyo']];
const SECTORS = [['XLK', 'Technology'], ['XLF', 'Financials'], ['XLV', 'Health Care'], ['XLY', 'Cons Disc'],
  ['XLP', 'Cons Staples'], ['XLE', 'Energy'], ['XLI', 'Industrials'], ['XLB', 'Materials'],
  ['XLU', 'Utilities'], ['XLRE', 'Real Estate'], ['XLC', 'Comm Svcs']];
let lpWeather = [];

function wxGlyph(cond) {
  if (/Clear/.test(cond)) return '☀';
  if (/P\.Cloudy/.test(cond)) return '⛅';
  if (/Cloudy|Fog/.test(cond)) return '☁';
  if (/Storm/.test(cond)) return '⛈';
  if (/Snow/.test(cond)) return '❄';
  if (/Rain|Drizzle|Showers/.test(cond)) return '🌧';
  return '☀';
}

function renderLpClocks() {
  const box = el('lp-clocks');
  if (!box) return;
  box.innerHTML = LP_CITIES.map(([name, tz]) => {
    const t = new Date().toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const w = lpWeather.find((x) => x.name === name);
    return `<div class="lp-clock"><div class="lp-city">${esc(name)}</div><div class="lp-time">${t}</div><div class="lp-wx">${w ? `${wxGlyph(w.cond)} ${w.temp}°F · ${esc(w.cond)}` : ''}</div></div>`;
  }).join('');
}

function setLp(id, html) { const e = el(id); if (e) { e.innerHTML = html; wireRows(e); } }

function heatGrid(rows, byName) {
  return `<div class="heat">${rows.map(([sym, label]) => {
    const q = byName[sym];
    const p = q && !q.error ? q.changePct : 0;
    const a = Math.min(0.85, Math.abs(p) / 6 * 0.7 + 0.15);
    const bg = q && !q.error ? (p >= 0 ? `rgba(42,166,63,${a})` : `rgba(255,61,87,${a})`) : '#11151b';
    return `<div class="heat-cell click" data-sym="${esc(sym)}" style="background:${bg}">
      <div class="hc-sym">${esc(label)}</div><div class="hc-pct">${q && !q.error ? (p >= 0 ? '+' : '') + fmtNum(p) + '%' : '—'}</div></div>`;
  }).join('')}</div>`;
}

// jagged mini line chart with a dark technical grid (Bloomberg-style)
function drawMiniChart(id, closes, color) {
  const c = el(id);
  if (!c || !closes || closes.length < 2) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = c.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  c.width = Math.floor(rect.width * dpr); c.height = Math.floor(rect.height * dpr);
  const cx = c.getContext('2d'); cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = rect.width, H = rect.height;
  cx.clearRect(0, 0, W, H); cx.fillStyle = '#000'; cx.fillRect(0, 0, W, H);
  let lo = Math.min(...closes), hi = Math.max(...closes); const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.01 || 1; lo -= pad; hi += pad;
  cx.strokeStyle = '#122230'; cx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { const y = Math.round((i / 4) * H) + 0.5; cx.beginPath(); cx.moveTo(0, y); cx.lineTo(W, y); cx.stroke(); }
  for (let i = 0; i <= 8; i++) { const x = Math.round((i / 8) * W) + 0.5; cx.beginPath(); cx.moveTo(x, 0); cx.lineTo(x, H); cx.stroke(); }
  cx.beginPath();
  closes.forEach((v, i) => { const x = (i / (closes.length - 1)) * W, y = H - ((v - lo) / (hi - lo)) * H; i ? cx.lineTo(x, y) : cx.moveTo(x, y); });
  cx.strokeStyle = color; cx.lineWidth = 1; cx.lineCap = 'butt'; cx.lineJoin = 'miter'; cx.stroke();
}

function compactBoard(rows, byName) {
  return `<div class="tbl-wrap"><table class="data">${rows.map(([sym, label]) => {
    const q = byName[sym];
    if (!q || q.error) return `<tr><td class="sym">${esc(label)}</td><td class="num muted" colspan="2">—</td></tr>`;
    return `<tr class="click" data-sym="${esc(sym)}"><td class="sym">${esc(label)}</td>
      <td class="num ${q._flash || ''}">${fmtPrice(q.price)}</td>
      <td class="num ${chgClass(q.change)}">${arrow(q.change)}${fmtNum(Math.abs(q.changePct))}%</td></tr>`;
  }).join('')}</table></div>`;
}

async function showLaunchpad() {
  state.view = 'LAUNCH'; setActiveTabs('HOME'); markFunc(null); setTab('LAUNCH Launchpad', 'HOME');
  const P = (title, id, cls = '', body = '<div class="loading">…</div>') =>
    `<div class="lp-panel ${cls}"><div class="lp-head">${title}</div><div class="lp-body pad0" id="${id}">${body}</div></div>`;
  el('view').innerHTML = `<div class="fa-screen">` + fnBar('LAUNCHPAD', 'LAUNCH', 'LAUNCH') + `<div class="lp-grid">
    <div class="lp-panel"><div class="lp-head">WORLD CLOCKS</div><div class="lp-body" id="lp-clocks"><div class="loading">…</div></div></div>
    ${P('MAJOR INDICES', 'lp-idx')}
    ${P('TOP GAINERS', 'lp-mov')}
    <div class="lp-panel"><div class="lp-head">GICS SECTOR MONITOR</div><div class="lp-body" id="lp-sect"><div class="loading">…</div></div></div>
    ${P('FX MAJORS', 'lp-fx')}
    ${P('COMMODITIES', 'lp-cmd')}
    ${P('US RATES / YIELDS', 'lp-rate')}
    ${P('INDEX FUTURES', 'lp-fut')}
    ${P('CRYPTO', 'lp-cryp')}
    ${P('TRENDING', 'lp-trend')}
    ${P('WATCHLIST HEATMAP', 'lp-heat')}
    ${P('EQUITY WATCHLIST', 'lp-ewatch')}
    <div class="lp-panel"><div class="lp-head">S&amp;P 500 · INTRADAY</div><div class="lp-body"><div class="lp-wrap-canvas"><canvas id="lp-chart" class="lp-canvas"></canvas></div></div></div>
    ${P('GLOBAL MACRO NEWS', 'lp-news', 'span2', '<div class="loading">…</div>')}
    ${P('NEWS DETAIL', 'lp-newsd', 'span2')}
    ${P('MOST ACTIVE', 'lp-active')}
    <div class="lp-panel"><div class="lp-head">SECTOR BREADTH</div><div class="lp-body" id="lp-breadth"><div class="loading">…</div></div></div>
    <div class="lp-panel"><div class="lp-head">US YIELD CURVE</div><div class="lp-body"><div class="lp-wrap-canvas"><canvas id="lp-curve" class="lp-canvas"></canvas></div></div></div>
  </div></div>`;
  renderLpClocks();
  setTimeout(showToast, 2500);
  api('/api/weather').then((w) => { lpWeather = w; renderLpClocks(); }).catch(() => {});

  const idx = [['^GSPC', 'S&P 500'], ['^IXIC', 'Nasdaq'], ['^DJI', 'Dow'], ['^RUT', 'Russell 2K'], ['^VIX', 'VIX'], ['^TNX', 'US 10Y'], ['^FTSE', 'FTSE'], ['^N225', 'Nikkei']];
  const fx = [['EURUSD=X', 'EUR/USD'], ['GBPUSD=X', 'GBP/USD'], ['USDJPY=X', 'USD/JPY'], ['USDCNY=X', 'USD/CNY'], ['USDCHF=X', 'USD/CHF'], ['DX-Y.NYB', 'Dollar Idx']];
  const cmd = [['GC=F', 'Gold'], ['SI=F', 'Silver'], ['CL=F', 'WTI'], ['BZ=F', 'Brent'], ['NG=F', 'Nat Gas'], ['HG=F', 'Copper']];
  const rate = [['^IRX', '3-Month'], ['^FVX', '5-Year'], ['^TNX', '10-Year'], ['^TYX', '30-Year']];
  const fut = [['ES=F', 'S&P Fut'], ['NQ=F', 'Nasdaq Fut'], ['YM=F', 'Dow Fut'], ['RTY=F', 'Rus Fut'], ['GC=F', 'Gold Fut'], ['CL=F', 'Crude Fut']];
  quoteBoard([...idx, ...fx, ...cmd, ...rate, ...fut].map((r) => r[0])).then((bn) => {
    setLp('lp-idx', boardTable(idx, bn, { spark: false }));
    setLp('lp-fx', compactBoard(fx, bn));
    setLp('lp-cmd', compactBoard(cmd, bn));
    setLp('lp-rate', compactBoard(rate, bn));
    setLp('lp-fut', compactBoard(fut, bn));
    // yield curve from the four benchmark tenors
    const curve = rate.map(([s]) => bn[s]?.price).filter((v) => v != null);
    drawMiniChart('lp-curve', curve.length >= 2 ? curve : [4.4, 4.2, 4.5, 4.9], '#ffe45c');
  }).catch(() => {});

  // heatmap + equity watchlist share one quote batch
  const heatList = [...state.watchlist, 'SPY', 'QQQ', 'DIA', 'IWM', ...SECTORS.map((r) => r[0])];
  quoteBoard(heatList).then((bn) => {
    setLp('lp-heat', heatGrid(heatList.map((s) => [s, s.replace('=F', '')]), bn));
    setLp('lp-ewatch', `<div class="tbl-wrap"><table class="data">
      <tr><th>SYM</th><th class="num">LAST</th><th class="num">CHG%</th><th>1D</th></tr>
      ${state.watchlist.map((s) => { const q = bn[s] || {}; return `<tr class="click" data-sym="${esc(s)}">
        <td class="sym">${esc(s)}</td><td class="num">${fmtPrice(q.price)}</td>
        <td class="num ${chgClass(q.change)}">${arrow(q.change || 0)}${fmtNum(Math.abs(q.changePct || 0))}%</td>
        <td class="spark-td">${sparkCell(s)}</td></tr>`; }).join('')}</table></div>`);
  }).catch(() => {});

  api('/api/crypto').then((coins) => {
    setLp('lp-cryp', `<div class="tbl-wrap"><table class="data">${coins.slice(0, 9).map((c) => `<tr class="click" data-sym="${esc(c.symbol)}-USD">
      <td class="sym">${esc(c.symbol)}</td><td class="num">${fmtPrice(c.price)}</td>
      <td class="num ${chgClass(c.changePct)}">${arrow(c.changePct)}${fmtNum(Math.abs(c.changePct))}%</td></tr>`).join('')}</table></div>`);
  }).catch(() => {});

  api('/api/trending').then((d) => quoteBoard((d.symbols || []).slice(0, 10)).then((bn) => {
    setLp('lp-trend', compactBoard((d.symbols || []).slice(0, 10).map((s) => [s, s]), bn));
  })).catch(() => {});

  api('/api/movers?type=gainers').then((d) => {
    setLp('lp-mov', `<div class="tbl-wrap"><table class="data">
      ${d.rows.slice(0, 9).map((r) => `<tr class="click" data-sym="${esc(r.symbol)}">
        <td class="sym">${esc(r.symbol)}</td><td class="num">${fmtPrice(r.price)}</td>
        <td class="num ${chgClass(r.change)}">${arrow(r.change)}${fmtNum(Math.abs(r.changePct))}%</td>
        <td class="spark-td">${sparkCell(r.symbol)}</td></tr>`).join('')}</table></div>`);
  }).catch(() => {});
  api('/api/movers?type=actives').then((d) => {
    setLp('lp-active', `<div class="tbl-wrap"><table class="data">
      ${d.rows.slice(0, 12).map((r) => `<tr class="click" data-sym="${esc(r.symbol)}">
        <td class="sym">${esc(r.symbol)}</td><td class="num">${fmtPrice(r.price)}</td>
        <td class="num ${chgClass(r.change)}">${arrow(r.change)}${fmtNum(Math.abs(r.changePct))}%</td>
        <td class="num muted">${fmtBig(r.volume)}</td></tr>`).join('')}</table></div>`);
  }).catch(() => {});

  quoteBoard(SECTORS.map((r) => r[0])).then((bn) => {
    const max = Math.max(0.5, ...SECTORS.map(([s]) => Math.abs(bn[s]?.changePct || 0)));
    setLp('lp-sect', SECTORS.map(([s, name]) => {
      const p = bn[s]?.changePct || 0;
      const w = (Math.abs(p) / max) * 48;
      return `<div class="sect-row click" data-sym="${esc(s)}">
        <span class="sect-name">${esc(name)}</span>
        <span class="sect-track"><span class="sect-bar ${chgClass(p)}" style="width:${w}%;${p < 0 ? 'right' : 'left'}:50%"></span></span>
        <span class="sect-pct ${chgClass(p)}">${p >= 0 ? '+' : ''}${fmtNum(p)}%</span></div>`;
    }).join(''));
    const up = SECTORS.filter(([s]) => (bn[s]?.changePct || 0) > 0).length;
    const dn = SECTORS.length - up;
    const upPct = (up / SECTORS.length) * 100;
    setLp('lp-breadth', `<div style="padding:4px 8px;font-family:var(--font-data);display:flex;gap:10px;align-items:center">
      <canvas id="lp-donut" style="width:64px;height:64px;flex-shrink:0"></canvas>
      <div style="flex:1;min-width:0">
        <div style="display:flex;justify-content:space-between;font-size:12px"><span class="pos">▲ ${up} Adv</span><span class="neg">${dn} Dec ▼</span></div>
        <div style="height:12px;background:var(--red-down);margin:4px 0;display:flex"><div style="height:100%;background:var(--green-fill);width:${upPct}%"></div></div>
        <div class="muted" style="font-size:11px">GICS · ${fmtNum(upPct, 0)}% advancing · Breadth ${up >= dn ? '<span class="pos">POSITIVE</span>' : '<span class="neg">NEGATIVE</span>'}</div>
      </div></div>`);
    setTimeout(() => drawDonut(el('lp-donut'), [{ v: up, color: '#2aa63f' }, { v: dn, color: '#ff3d57' }]), 30);
  }).catch(() => {});

  api('/api/history/%5EGSPC?range=1d').then((d) => {
    drawMiniChart('lp-chart', d.candles.map((c) => c.c), d.candles.length && d.candles[d.candles.length - 1].c >= d.candles[0].c ? '#00c853' : '#ff3d57');
  }).catch(() => {});

  api('/api/news?symbol=SPY').then((d) => {
    const items = d.items || [];
    const n = el('lp-news');
    if (n) n.innerHTML = `<div style="padding:2px 4px">${newsHTML(items, 16)}</div>`;
    const nd = el('lp-newsd');
    const lead = items[0];
    if (nd && lead) nd.innerHTML = `<div style="padding:5px 8px;font-family:var(--font-data)">
      <div style="color:var(--yellow);font-size:14px;font-weight:bold;line-height:1.2">${esc(lead.title)}</div>
      <div class="news-meta" style="margin:3px 0"><span class="src">${esc(lead.source || '')}</span> · ${timeAgo(lead.time)} · <span class="muted">Bloomberg First Word</span></div>
      <div style="color:var(--orange);font-size:12px;line-height:1.4">${esc((lead.summary || 'Wire coverage spanning global equities, rates, FX, and commodities. Headlines refresh continuously; select any story to open the full text. Cross-asset moves, central-bank commentary, and earnings updates are aggregated here.').slice(0, 420))}</div>
      ${items.slice(1, 4).map((it) => `<div style="margin-top:4px;font-size:12px;color:var(--white)">• ${esc(it.title)} <span class="muted">— ${esc(it.source || '')}</span></div>`).join('')}
    </div>`;
  }).catch(() => {});
}


/* ============================ NEW FUNCTIONS ============================ */

/* ---- ANR: analyst recommendations */
const GRADE_COLORS = { strongBuy: '#1a7a2e', buy: '#2aa63f', hold: '#f6a313', sell: '#d8622a', strongSell: '#ff3d57' };

async function showANR() {
  if (!state.symbol) { msg('Load a security first', true); return; }
  setActiveTabs(null); markFunc('ANR');
  el('view').innerHTML = `<div class="fa-screen">` + fnBar('ANALYST RECOMMENDATIONS', 'ANR', eqBox()) + `<div class="mon-grid cols-2 tfill">
    <div class="section">${secBar('CONSENSUS')}<div class="sec-body" id="anr-c"><div class="loading">…</div></div></div>
    <div class="section">${secBar('RECOMMENDATION TREND')}<div class="sec-body" id="anr-t"><div class="loading">…</div></div></div>
    <div class="section span2">${secBar('RATING CHANGES & PRICE-TARGET ACTIONS')}<div class="sec-body pad0" id="anr-h"><div class="loading">…</div></div></div>
  </div></div>`;
  try {
    const a = await api(`/api/analyst/${encodeURIComponent(state.symbol)}`);
    const q = state.quote || {};
    const recCls = /buy/i.test(a.recommendationKey) ? 'rec-buy' : /sell|under/i.test(a.recommendationKey) ? 'rec-sell' : 'rec-hold';
    const row = (k, v, cls = '') => `<div class="kv"><span class="k">${esc(k)}</span><span class="v ${cls}">${v}</span></div>`;
    el('anr-c').innerHTML = `
      <div style="margin:2px 0 4px"><span class="rec-badge ${recCls}">${esc((a.recommendationKey || 'N/A').toUpperCase())}</span>
      <span class="muted" style="margin-left:8px">score ${fmtRatio(a.recommendationMean)}/5 · 1 = Strong Buy</span></div>
      <div class="kv-grid" style="grid-template-columns:1fr">
        ${row('Mean Price Target', fmtPrice(a.targetMean), 'hl')}
        ${row('High / Low Target', `${fmtPrice(a.targetHigh)} / ${fmtPrice(a.targetLow)}`)}
        ${row('Upside to Mean', a.targetMean && q.price ? `<span class="${chgClass(a.targetMean - q.price)}">${fmtPct(((a.targetMean - q.price) / q.price) * 100)}</span>` : '—')}
        ${row('# Analysts', fmtRatio(a.numberOfAnalysts, 0))}
      </div>`;
    const periods = { '0m': 'Current', '-1m': '1 Mo Ago', '-2m': '2 Mo Ago', '-3m': '3 Mo Ago' };
    el('anr-t').innerHTML = (a.trend || []).map((t) => {
      const total = (t.strongBuy || 0) + (t.buy || 0) + (t.hold || 0) + (t.sell || 0) + (t.strongSell || 0) || 1;
      const seg = (n, key) => (n ? `<div title="${key} ${n}" style="width:${(n / total) * 100}%;background:${GRADE_COLORS[key]};display:flex;align-items:center;justify-content:center;color:#000;font-size:10px">${n}</div>` : '');
      return `<div style="margin:3px 0">
        <div class="muted" style="font-size:10px">${esc(periods[t.period] || t.period)} · ${total} analysts</div>
        <div style="display:flex;height:16px;border:1px solid var(--grid)">${seg(t.strongBuy, 'strongBuy')}${seg(t.buy, 'buy')}${seg(t.hold, 'hold')}${seg(t.sell, 'sell')}${seg(t.strongSell, 'strongSell')}</div>
      </div>`;
    }).join('') + `<div class="muted" style="font-size:10px;margin-top:4px">
      <span style="color:${GRADE_COLORS.strongBuy}">▉</span> Str Buy <span style="color:${GRADE_COLORS.buy}">▉</span> Buy
      <span style="color:${GRADE_COLORS.hold}">▉</span> Hold <span style="color:${GRADE_COLORS.sell}">▉</span> Sell
      <span style="color:${GRADE_COLORS.strongSell}">▉</span> Str Sell</div>`;
    const actCls = (act) => (act === 'up' ? 'pos' : act === 'down' ? 'neg' : act === 'init' ? 'blue' : 'muted');
    const actLbl = { up: 'UPGRADE', down: 'DOWNGRADE', init: 'INITIATE', main: 'MAINTAIN', reit: 'REITERATE' };
    el('anr-h').innerHTML = `<div class="tbl-wrap"><table class="data">
      <tr><th>DATE</th><th>FIRM</th><th>ACTION</th><th>FROM</th><th>TO</th><th class="num">PT</th><th class="num">PRIOR PT</th></tr>
      ${(a.history || []).map((h) => `<tr>
        <td class="muted">${fmtDate(h.time)}</td><td class="hl">${esc(h.firm)}</td>
        <td class="${actCls(h.action)}">${esc(actLbl[h.action] || (h.action || '').toUpperCase())}</td>
        <td class="muted">${esc(h.fromGrade || '—')}</td><td class="est-i">${esc(h.toGrade || '—')}</td>
        <td class="num">${h.target ? fmtPrice(h.target) : '—'}</td>
        <td class="num muted">${h.priorTarget ? fmtPrice(h.priorTarget) : '—'}</td>
      </tr>`).join('')}
    </table></div>`;
  } catch (err) { el('view').querySelector('.mon-grid').innerHTML = `<div class="err">${esc(err.message)}</div>`; }
}

/* ---- HDS: holders */
async function showHDS() {
  if (!state.symbol) { msg('Load a security first', true); return; }
  setActiveTabs(null); markFunc('HDS');
  el('view').innerHTML = `<div class="fa-screen">` + fnBar('SECURITY OWNERSHIP', 'HDS', eqBox()) + `<div class="mon-grid cols-2 tfill">
    <div class="section">${secBar('OWNERSHIP BREAKDOWN')}<div class="sec-body" id="hds-b"><div class="loading">…</div></div></div>
    <div class="section">${secBar('INSIDER HOLDERS')}<div class="sec-body pad0" id="hds-i"><div class="loading">…</div></div></div>
    <div class="section">${secBar('TOP INSTITUTIONAL HOLDERS')}<div class="sec-body pad0" id="hds-inst"><div class="loading">…</div></div></div>
    <div class="section">${secBar('TOP FUND HOLDERS')}<div class="sec-body pad0" id="hds-f"><div class="loading">…</div></div></div>
  </div></div>`;
  try {
    const h = await api(`/api/holders/${encodeURIComponent(state.symbol)}`);
    const row = (k, v, cls = '') => `<div class="kv"><span class="k">${esc(k)}</span><span class="v ${cls}">${v}</span></div>`;
    el('hds-b').innerHTML = `<div class="kv-grid" style="grid-template-columns:1fr">
      ${row('% Held by Insiders', h.breakdown.insidersPct != null ? fmtPct(h.breakdown.insidersPct * 100) : '—', 'hl')}
      ${row('% Held by Institutions', h.breakdown.institutionsPct != null ? fmtPct(h.breakdown.institutionsPct * 100) : '—', 'hl')}
      ${row('% of Float (Institutions)', h.breakdown.institutionsFloatPct != null ? fmtPct(h.breakdown.institutionsFloatPct * 100) : '—')}
      ${row('# Institutions', fmtRatio(h.breakdown.institutionsCount, 0))}
    </div>`;
    const ownTable = (list) => `<div class="tbl-wrap"><table class="data">
      <tr><th>HOLDER</th><th class="num">SHARES</th><th class="num">%HELD</th><th class="num">VALUE</th><th class="num">Δ%</th><th>AS OF</th></tr>
      ${(list || []).map((o) => `<tr>
        <td class="hl">${esc(o.name)}</td><td class="num">${fmtBig(o.position)}</td>
        <td class="num">${o.pctHeld != null ? fmtPct(o.pctHeld * 100) : '—'}</td>
        <td class="num">${fmtBig(o.value)}</td>
        <td class="num ${chgClass(o.pctChange)}">${o.pctChange != null ? fmtPct(o.pctChange * 100) : '—'}</td>
        <td class="muted">${esc(o.reportDate)}</td>
      </tr>`).join('')}
    </table></div>`;
    el('hds-inst').innerHTML = ownTable(h.institutions);
    el('hds-f').innerHTML = ownTable(h.funds);
    el('hds-i').innerHTML = `<div class="tbl-wrap"><table class="data">
      <tr><th>NAME</th><th>RELATION</th><th class="num">SHARES</th><th>LATEST TRANSACTION</th><th>DATE</th></tr>
      ${(h.insiders || []).map((o) => `<tr>
        <td class="hl">${esc(o.name)}</td><td class="muted">${esc(o.relation || '')}</td>
        <td class="num">${fmtBig(o.position)}</td><td class="est-i">${esc(o.latestTrans || '—')}</td><td class="muted">${esc(o.date)}</td>
      </tr>`).join('')}
    </table></div>`;
  } catch (err) { el('view').querySelector('.mon-grid').innerHTML = `<div class="err">${esc(err.message)}</div>`; }
}

/* ---- DVD: dividends */
async function showDVD() {
  if (!state.symbol) { msg('Load a security first', true); return; }
  setActiveTabs(null); markFunc('DVD');
  el('view').innerHTML = `<div class="fa-screen">` + fnBar('DIVIDEND / SPLIT HISTORY', 'DVD', eqBox()) + `<div class="mon-grid cols-2 tfill">
    <div class="section">${secBar('DIVIDEND SUMMARY')}<div class="sec-body" id="dvd-s"><div class="loading">…</div></div></div>
    <div class="section">${secBar('PAYMENT TREND')}<div class="sec-body pad0"><div class="mon-chart"><canvas id="dvd-chart"></canvas></div></div></div>
    <div class="section">${secBar('DIVIDEND PAYMENTS (10Y)')}<div class="sec-body pad0" id="dvd-t"><div class="loading">…</div></div></div>
    <div class="section">${secBar('STOCK SPLITS')}<div class="sec-body pad0" id="dvd-sp"><div class="loading">…</div></div></div>
  </div></div>`;
  try {
    const d = await api(`/api/dividends/${encodeURIComponent(state.symbol)}`);
    const divs = d.dividends || [];
    if (!divs.length) { el('dvd-s').innerHTML = '<div class="muted">No dividends on record for this security.</div>'; el('dvd-t').innerHTML = ''; }
    else {
      const ttm = divs.slice(0, 4).reduce((a, x) => a + x.amount, 0);
      const yield_ = d.price ? (ttm / d.price) * 100 : null;
      const first = divs[divs.length - 1], last = divs[0];
      const years = (last.date - first.date) / (365.25 * 86400);
      const cagr = years > 1 && first.amount > 0 ? (Math.pow(last.amount / first.amount, 1 / years) - 1) * 100 : null;
      const row = (k, v, cls = '') => `<div class="kv"><span class="k">${esc(k)}</span><span class="v ${cls}">${v}</span></div>`;
      el('dvd-s').innerHTML = `<div class="kv-grid" style="grid-template-columns:1fr">
        ${row('Last Payment', fmtNum(last.amount, 4), 'hl')}
        ${row('Last Ex-Date', fmtDate(last.date))}
        ${row('Trailing 12M Total', fmtNum(ttm, 4))}
        ${row('Indicated Yield', yield_ != null ? fmtPct(yield_) : '—', 'hl')}
        ${row('Growth (CAGR since ' + new Date(first.date * 1000).getFullYear() + ')', cagr != null ? `<span class="${chgClass(cagr)}">${fmtPct(cagr)}</span>` : '—')}
        ${row('Payments on Record', String(divs.length))}
      </div>`;
      el('dvd-t').innerHTML = `<div class="tbl-wrap"><table class="data">
        <tr><th>EX-DATE</th><th class="num">AMOUNT</th><th class="num">Δ vs PRIOR</th></tr>
        ${divs.map((x, i) => {
          const prior = divs[i + 1];
          const chg = prior ? ((x.amount - prior.amount) / prior.amount) * 100 : null;
          return `<tr><td class="hl">${fmtDate(x.date)}</td><td class="num">${fmtNum(x.amount, 4)}</td>
            <td class="num ${chg == null ? 'muted' : chgClass(chg)}">${chg == null ? '—' : (chg >= 0 ? '+' : '') + fmtNum(chg, 1) + '%'}</td></tr>`;
        }).join('')}
      </table></div>`;
      setTimeout(() => drawMiniChart('dvd-chart', [...divs].reverse().map((x) => x.amount), '#ffe45c'), 30);
    }
    el('dvd-sp').innerHTML = (d.splits || []).length
      ? `<div class="tbl-wrap"><table class="data"><tr><th>DATE</th><th>RATIO</th></tr>
        ${d.splits.map((sp) => `<tr><td class="hl">${fmtDate(sp.date)}</td><td class="est-i">${esc(sp.ratio)}</td></tr>`).join('')}</table></div>`
      : '<div class="muted" style="padding:6px">No splits on record.</div>';
  } catch (err) { el('view').querySelector('.mon-grid').innerHTML = `<div class="err">${esc(err.message)}</div>`; }
}

/* ---- HP: historical price table */
async function showHP(range = '3mo') {
  if (!state.symbol) { msg('Load a security first', true); return; }
  setActiveTabs(null); markFunc('HP');
  const tabs = ['1mo', '3mo', '6mo', '1y'].map((r) =>
    `<button class="tab hp-tab ${r === range ? 'active' : ''}" data-r="${r}">${r.toUpperCase()}</button>`).join('');
  el('view').innerHTML = `<div class="fa-screen">` + fnBar('HISTORICAL PRICE TABLE', 'HP', eqBox())
    + `<div class="sec-bar" style="position:static">DAILY OHLCV <span class="tabs">${tabs}</span></div>
    <div id="hp-body" style="flex:1;min-height:0;overflow:auto"><div class="loading">…</div></div></div>`;
  el('view').querySelectorAll('.hp-tab').forEach((b) => b.addEventListener('click', () => showHP(b.dataset.r)));
  try {
    const d = await api(`/api/history/${encodeURIComponent(state.symbol)}?range=${range}`);
    const c = [...(d.candles || [])].reverse();
    el('hp-body').innerHTML = `<div class="tbl-wrap"><table class="data">
      <tr><th>DATE</th><th class="num">OPEN</th><th class="num">HIGH</th><th class="num">LOW</th><th class="num">CLOSE</th><th class="num">%CHG</th><th class="num">VOLUME</th></tr>
      ${c.map((x, i) => {
        const prior = c[i + 1];
        const chg = prior ? ((x.c - prior.c) / prior.c) * 100 : null;
        return `<tr><td class="hl">${fmtDate(x.t)}</td>
          <td class="num">${fmtPrice(x.o)}</td><td class="num">${fmtPrice(x.h)}</td>
          <td class="num">${fmtPrice(x.l)}</td><td class="num est-i">${fmtPrice(x.c)}</td>
          <td class="num ${chg == null ? 'muted' : chgClass(chg)}">${chg == null ? '—' : (chg >= 0 ? '+' : '') + fmtNum(chg) + '%'}</td>
          <td class="num muted">${fmtBig(x.v)}</td></tr>`;
      }).join('')}
    </table></div>`;
  } catch (err) { el('hp-body').innerHTML = `<div class="err">${esc(err.message)}</div>`; }
}

/* ---- BQ: composite quote */
async function showBQ() {
  if (!state.symbol) { msg('Load a security first', true); return; }
  setActiveTabs(null); markFunc('BQ');
  el('view').innerHTML = `<div class="fa-screen">` + fnBar('COMPOSITE QUOTE', 'BQ', eqBox()) + `<div class="mon-grid cols-3 tfill">
    <div class="section">${secBar('LAST TRADE')}<div class="sec-body" id="bq-p"><div class="loading">…</div></div></div>
    <div class="section">${secBar('BID / ASK')}<div class="sec-body" id="bq-ba"><div class="loading">…</div></div></div>
    <div class="section">${secBar('RANGES')}<div class="sec-body" id="bq-r"><div class="loading">…</div></div></div>
    <div class="section span2">${secBar('INTRADAY')}<div class="sec-body pad0"><div class="mon-chart"><canvas id="bq-chart"></canvas></div></div></div>
    <div class="section">${secBar('TRADE DATA')}<div class="sec-body" id="bq-t"><div class="loading">…</div></div></div>
  </div></div>`;
  try {
    const q = state.quote || await api(`/api/quote/${encodeURIComponent(state.symbol)}`);
    const rangeBar = (lo, hi, cur) => {
      if (lo == null || hi == null || cur == null || hi <= lo) return '<div class="muted">—</div>';
      const p = ((cur - lo) / (hi - lo)) * 100;
      return `<div style="position:relative;height:14px;background:var(--panel-2);border:1px solid var(--grid);margin:3px 0">
        <div style="position:absolute;top:-1px;bottom:-1px;left:${p}%;width:2px;background:var(--yellow)"></div></div>
        <div style="display:flex;justify-content:space-between;font-size:10px" class="muted"><span>${fmtPrice(lo)}</span><span class="hl">${fmtPrice(cur)}</span><span>${fmtPrice(hi)}</span></div>`;
    };
    el('bq-p').innerHTML = `
      <div class="${chgClass(q.change)}" style="font-size:38px;font-weight:bold;line-height:1">${fmtPrice(q.price)}</div>
      <div class="${chgClass(q.change)}" style="font-size:16px">${fmtChange(q.change, q.changePct)}</div>
      <div class="muted" style="font-size:11px;margin-top:4px">${esc(q.exchange || '')} · ${esc(q.currency || '')} · ${q.marketTime ? new Date(q.marketTime * 1000).toLocaleString() : ''}</div>`;
    el('bq-r').innerHTML = `
      <div class="muted" style="font-size:10px">DAY RANGE</div>${rangeBar(q.dayLow, q.dayHigh, q.price)}
      <div class="muted" style="font-size:10px;margin-top:8px">52-WEEK RANGE</div>${rangeBar(q.low52w, q.high52w, q.price)}`;
    const row = (k, v, cls = '') => `<div class="kv"><span class="k">${esc(k)}</span><span class="v ${cls}">${v}</span></div>`;
    el('bq-t').innerHTML = `<div class="kv-grid" style="grid-template-columns:1fr">
      ${row('Open', fmtPrice(q.open))}${row('Prev Close', fmtPrice(q.prevClose))}
      ${row('Volume', fmtBig(q.volume), 'hl')}
      ${row('Value Traded', q.price && q.volume ? fmtBig(q.price * q.volume) : '—')}
    </div>`;
    api(`/api/summary/${encodeURIComponent(state.symbol)}`).then((sm) => {
      el('bq-ba').innerHTML = `
        <div style="display:flex;gap:12px;align-items:baseline">
          <div><div class="muted" style="font-size:10px">BID</div><div class="pos" style="font-size:24px;font-weight:bold">${fmtPrice(sm.bid)}</div><div class="muted">x${fmtRatio(sm.bidSize, 0)}</div></div>
          <div><div class="muted" style="font-size:10px">ASK</div><div class="neg" style="font-size:24px;font-weight:bold">${fmtPrice(sm.ask)}</div><div class="muted">x${fmtRatio(sm.askSize, 0)}</div></div>
        </div>
        <div class="kv-grid" style="grid-template-columns:1fr;margin-top:4px">
          ${row('Spread', sm.bid && sm.ask ? fmtNum(sm.ask - sm.bid, 2) : '—')}
          ${row('Avg Volume', fmtBig(sm.avgVolume))}
          ${row('Market Cap', fmtBig(sm.marketCap), 'hl')}
          ${row('Beta', fmtRatio(sm.beta))}
        </div>`;
    }).catch(() => { el('bq-ba').innerHTML = '<div class="muted">bid/ask unavailable</div>'; });
    loadMonChart('bq-chart', state.symbol);
  } catch (err) { el('view').querySelector('.mon-grid').innerHTML = `<div class="err">${esc(err.message)}</div>`; }
}

/* ---- EQS: equity screener */
async function showEQS(scr = 'ugrowth') {
  state.view = 'EQS'; setActiveTabs(null); markFunc(null); setTab('EQS Screener', 'EQS');
  el('view').innerHTML = `<div class="fa-screen">` + fnBar('EQUITY SCREENER', 'EQS', 'EQS Screening')
    + `<div class="fa-tabs" id="eqs-tabs"></div>
    <div id="eqs-body" style="flex:1;min-height:0;overflow:auto"><div class="loading">…</div></div></div>`;
  try {
    const d = await api(`/api/screener?scr=${encodeURIComponent(scr)}`);
    el('eqs-tabs').innerHTML = (d.screens || []).map(([k, t], i) =>
      `<button class="fa-tab ${k === d.key ? 'active' : ''}" data-scr="${k}"><span class="n">${i + 1})</span>${esc(t.toUpperCase())}</button>`).join('');
    el('eqs-tabs').querySelectorAll('.fa-tab').forEach((b) => b.addEventListener('click', () => showEQS(b.dataset.scr)));
    el('eqs-body').innerHTML = `<div class="tbl-wrap"><table class="data">
      <tr><th>#</th><th>SYM</th><th>NAME</th><th class="num">LAST</th><th class="num">CHG</th><th class="num">CHG%</th><th>1D</th><th class="num">VOLUME</th><th class="num">MKT CAP</th></tr>
      ${(d.rows || []).map((r, i) => `<tr class="click" data-sym="${esc(r.symbol)}">
        <td class="muted">${i + 1}</td><td class="sym">${esc(r.symbol)}</td><td class="muted">${esc((r.name || '').slice(0, 28))}</td>
        <td class="num">${fmtPrice(r.price)}</td>
        <td class="num ${chgClass(r.change)}">${arrow(r.change)} ${fmtNum(Math.abs(r.change))}</td>
        <td class="num ${chgClass(r.change)}">${fmtNum(Math.abs(r.changePct))}%</td>
        <td class="spark-td">${sparkCell(r.symbol)}</td>
        <td class="num">${fmtBig(r.volume)}</td><td class="num">${fmtBig(r.marketCap)}</td>
      </tr>`).join('')}
    </table></div>`;
    wireRows(el('eqs-body'));
  } catch (err) { el('eqs-body').innerHTML = `<div class="err">${esc(err.message)}</div>`; }
}

/* ---- BTMM: treasury & money markets composite */
async function showBTMM() {
  state.view = 'BTMM'; setActiveTabs(null); markFunc(null); setTab('BTMM Money Mkts', 'BTMM');
  const YIELDS = [['^IRX', 'US 3-Month Bill'], ['^FVX', 'US 5-Year'], ['^TNX', 'US 10-Year'], ['^TYX', 'US 30-Year']];
  const FXM = [['EURUSD=X', 'EUR/USD'], ['GBPUSD=X', 'GBP/USD'], ['USDJPY=X', 'USD/JPY'], ['DX-Y.NYB', 'Dollar Idx']];
  const IFUT = [['ES=F', 'S&P Fut'], ['NQ=F', 'Nasdaq Fut'], ['YM=F', 'Dow Fut'], ['GC=F', 'Gold Fut'], ['CL=F', 'Crude Fut']];
  el('view').innerHTML = `<div class="fa-screen">` + fnBar('US TREASURY & MONEY MARKETS', 'BTMM', 'BTMM Monitor') + `<div class="mon-grid cols-3 tfill">
    <div class="section">${secBar('GOVT YIELDS (%)')}<div class="sec-body pad0" id="bt-y"><div class="loading">…</div></div></div>
    <div class="section">${secBar('TREASURY FUTURES')}<div class="sec-body pad0" id="bt-tf"><div class="loading">…</div></div></div>
    <div class="section">${secBar('KEY SPREADS (bp)')}<div class="sec-body" id="bt-sp"><div class="loading">…</div></div></div>
    <div class="section">${secBar('FX')}<div class="sec-body pad0" id="bt-fx"><div class="loading">…</div></div></div>
    <div class="section">${secBar('INDEX / CMDTY FUTURES')}<div class="sec-body pad0" id="bt-if"><div class="loading">…</div></div></div>
    <div class="section">${secBar('US YIELD CURVE')}<div class="sec-body pad0"><div class="mon-chart"><canvas id="bt-curve"></canvas></div></div></div>
  </div></div>`;
  try {
    const byName = await quoteBoard([...YIELDS, ...RATE_FUT, ...FXM, ...IFUT].map((r) => r[0]));
    const put = (id, rows) => { const e = el(id); if (e) { e.innerHTML = compactBoard(rows, byName); wireRows(e); } };
    put('bt-y', YIELDS); put('bt-tf', RATE_FUT); put('bt-fx', FXM); put('bt-if', IFUT);
    const g = (sy) => byName[sy]?.price;
    const bp = (a, b) => (a != null && b != null ? Math.round((a - b) * 100) : null);
    const sp = (k, v) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v ${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${v == null ? '—' : (v > 0 ? '+' : '') + v + ' bp'}</span></div>`;
    el('bt-sp').innerHTML = `<div class="kv-grid" style="grid-template-columns:1fr">
      ${sp('10Y − 3M', bp(g('^TNX'), g('^IRX')))}${sp('10Y − 5Y', bp(g('^TNX'), g('^FVX')))}
      ${sp('30Y − 10Y', bp(g('^TYX'), g('^TNX')))}
      <div class="kv"><span class="k">Curve Shape</span><span class="v ${bp(g('^TNX'), g('^IRX')) >= 0 ? 'pos' : 'neg'}">${bp(g('^TNX'), g('^IRX')) >= 0 ? 'NORMAL' : 'INVERTED'}</span></div>
    </div>`;
    drawMiniChart('bt-curve', [g('^IRX'), g('^FVX'), g('^TNX'), g('^TYX')].filter((v) => v != null), '#ffe45c');
  } catch (err) { el('view').querySelector('.mon-grid').innerHTML = `<div class="err">${esc(err.message)}</div>`; }
}

/* ---- GMM: global macro movers */
async function showGMM() {
  state.view = 'GMM'; setActiveTabs(null); markFunc(null); setTab('GMM Macro Movers', 'GMM');
  el('view').innerHTML = `<div class="fa-screen">` + fnBar('GLOBAL MACRO MOVERS', 'GMM', 'GMM Monitor') + `<div class="mon-grid cols-2">
    <div class="section">${secBar('BIGGEST GAINS — GLOBAL CROSS-ASSET')}<div class="sec-body pad0" id="gmm-up"><div class="loading">…</div></div></div>
    <div class="section">${secBar('BIGGEST DECLINES — GLOBAL CROSS-ASSET')}<div class="sec-body pad0" id="gmm-dn"><div class="loading">…</div></div></div>
  </div></div>`;
  const UNIVERSE = [];
  Object.entries(WEI_REGIONS).forEach(([region, rows]) => rows.forEach(([sy, nm]) => UNIVERSE.push([sy, nm, 'Index'])));
  [['EURUSD=X', 'EUR/USD'], ['GBPUSD=X', 'GBP/USD'], ['USDJPY=X', 'USD/JPY'], ['USDCNY=X', 'USD/CNY'], ['DX-Y.NYB', 'Dollar Idx']].forEach(([sy, nm]) => UNIVERSE.push([sy, nm, 'Curncy']));
  [['GC=F', 'Gold'], ['SI=F', 'Silver'], ['CL=F', 'WTI'], ['BZ=F', 'Brent'], ['NG=F', 'Nat Gas'], ['HG=F', 'Copper'], ['ZC=F', 'Corn'], ['ZW=F', 'Wheat']].forEach(([sy, nm]) => UNIVERSE.push([sy, nm, 'Comdty']));
  [['BTC-USD', 'Bitcoin'], ['ETH-USD', 'Ethereum']].forEach(([sy, nm]) => UNIVERSE.push([sy, nm, 'Crypto']));
  try {
    const byName = await quoteBoard(UNIVERSE.map((r) => r[0]));
    const rows = UNIVERSE
      .map(([sy, nm, cls]) => ({ sy, nm, cls, q: byName[sy] }))
      .filter((r) => r.q && !r.q.error && r.q.changePct != null)
      .sort((a, b) => b.q.changePct - a.q.changePct);
    const tbl = (list) => `<div class="tbl-wrap"><table class="data">
      <tr><th>NAME</th><th>CLASS</th><th class="num">LAST</th><th class="num">CHG%</th></tr>
      ${list.map((r) => `<tr class="click" data-sym="${esc(r.sy)}">
        <td class="sym">${esc(r.nm)}</td><td><span class="ac-key">${esc(r.cls)}</span></td>
        <td class="num">${fmtPrice(r.q.price)}</td>
        <td class="num ${chgClass(r.q.change)}">${arrow(r.q.change)} ${fmtNum(Math.abs(r.q.changePct))}%</td>
      </tr>`).join('')}
    </table></div>`;
    el('gmm-up').innerHTML = tbl(rows.slice(0, 18));
    el('gmm-dn').innerHTML = tbl([...rows].reverse().slice(0, 18));
    wireRows(el('gmm-up')); wireRows(el('gmm-dn'));
  } catch (err) { el('view').querySelector('.mon-grid').innerHTML = `<div class="err">${esc(err.message)}</div>`; }
}

/* ---- NI: news by topic */
async function showNI(topic) {
  state.view = 'NI'; setActiveTabs(null); markFunc(null); setTab(`NI ${topic}`.slice(0, 22), `NI ${topic}`);
  el('view').innerHTML = `<div class="fa-screen">` + fnBar(`NEWS — ${topic.toUpperCase()}`, 'NI', 'NI News')
    + `<div class="sec-body" style="flex:1;overflow:auto" id="ni-body"><div class="loading">…</div></div></div>`;
  try {
    const d = await api(`/api/news?q=${encodeURIComponent(topic)}`);
    el('ni-body').innerHTML = newsHTML(d.items || [], 30);
  } catch (err) { el('ni-body').innerHTML = `<div class="err">${esc(err.message)}</div>`; }
}

/* ============================ PANL: multi-panel ============================ */

let panlActive = 0;
function showPanl(nArg) {
  if (window !== window.top) return msg('PANL unavailable inside a panel', true);
  const n = parseInt(nArg, 10);
  const existing = el('panl');
  if (!n || n <= 1) {
    if (existing) existing.remove();
    return msg('Single-panel workspace');
  }
  const count = n >= 4 ? 4 : 2;
  if (existing) existing.remove();
  const div = document.createElement('div');
  div.id = 'panl';
  div.innerHTML = `<div class="panl-bar"><span class="panl-t">MULTI-PANEL WORKSPACE — ${count} PANELS · ACTIVE PANEL HAS THE BLINKING BORDER</span>
    <span class="panl-btns"><button class="tb-btn" data-p="1">PANL 1</button><button class="tb-btn" data-p="2">PANL 2</button><button class="tb-btn" data-p="4">PANL 4</button><button class="tb-btn" id="panl-cycle">PANEL ⭾</button></span></div>
    <div class="panl-grid p${count}">${Array.from({ length: count }, (_, i) =>
      `<div class="panl-cell" data-i="${i}"><span class="panl-num">P${i + 1}</span><iframe src="${location.pathname}" title="Panel ${i + 1}"></iframe></div>`).join('')}</div>`;
  document.body.appendChild(div);
  panlActive = 0; updPanlActive();
  div.querySelectorAll('.panl-btns .tb-btn[data-p]').forEach((b) => b.addEventListener('click', () => showPanl(b.dataset.p)));
  el('panl-cycle').addEventListener('click', cyclePanel);
  div.querySelectorAll('.panl-cell').forEach((c) => c.addEventListener('mousedown', () => { panlActive = parseInt(c.dataset.i, 10); updPanlActive(); }));
  msg(`${count}-panel workspace — PANEL cycles panels, PANL 1 exits`);
}
function updPanlActive() {
  document.querySelectorAll('.panl-cell').forEach((c, i) => c.classList.toggle('active', i === panlActive));
}
function cyclePanel() {
  const cells = document.querySelectorAll('.panl-cell');
  if (!cells.length) return msg('No panels open — PANL 2 or PANL 4 first', true);
  panlActive = (panlActive + 1) % cells.length;
  updPanlActive();
  const f = cells[panlActive].querySelector('iframe');
  if (f) f.focus();
}

/* ---------------------------------------------------------------- HELP */

function showHelp() {
  state.view = 'HELP'; setActiveTabs(null); markFunc(null); setTab('HELP Guide', 'HELP');
  el('view').innerHTML = fnBar('TERMINAL GUIDE', 'HELP', 'HELP') + `<div class="help-body">
    <h2>OPENTERM</h2>
    <p>A Bloomberg-style market terminal. Type a command in the amber line and press <span class="ex">GO</span> (Enter). Commands are <b>SECURITY</b> then <b>FUNCTION</b>, just like a Bloomberg &lt;GO&gt; string.</p>
    <div class="sec-bar" style="position:static;margin:8px 0 4px">SECURITY FUNCTIONS</div>
    <div class="tbl-wrap"><table class="data">
      <tr><th>COMMAND</th><th>FUNCTION</th></tr>
      <tr><td>AAPL</td><td>Load a security (opens the price graph)</td></tr>
      <tr><td>AAPL DES</td><td>Description — profile, identification, market data</td></tr>
      <tr><td>AAPL GP</td><td>Price graph — candles/line, 1D → MAX, crosshair OHLC</td></tr>
      <tr><td>AAPL GIP</td><td>Intraday price graph</td></tr>
      <tr><td>AAPL FA</td><td>Financial analysis — overview + multi-year income/balance/cash-flow/ratios</td></tr>
      <tr><td>AAPL ERN</td><td>Earnings — quarterly surprise, annual revenue/earnings</td></tr>
      <tr><td>AAPL CN</td><td>Company news</td></tr>
    </table></div>
    <div class="sec-bar" style="position:static;margin:8px 0 4px">MARKET MONITORS</div>
    <div class="tbl-wrap"><table class="data">
      <tr><th>COMMAND</th><th>FUNCTION</th></tr>
      <tr><td>HOME / LAUNCH</td><td>Launchpad — world clocks, indices, movers, sectors, macro news</td></tr>
      <tr><td>WEI</td><td>World equity indices (Americas / EMEA / Asia-Pac)</td></tr>
      <tr><td>MOST</td><td>Market movers — gainers, losers, most active</td></tr>
      <tr><td>CMDTY</td><td>Commodities — energy, metals, agriculture</td></tr>
      <tr><td>GOVT</td><td>US Treasury yields & futures</td></tr>
      <tr><td>FX</td><td>Currency rates (ECB reference)</td></tr>
      <tr><td>CRYP</td><td>Cryptocurrency market</td></tr>
      <tr><td>TOP</td><td>Top market news</td></tr>
      <tr><td>W</td><td>Watchlist — <span class="ex">W ADD NVDA</span> / <span class="ex">W DEL NVDA</span></td></tr>
      <tr><td>S apple</td><td>Security finder (search by name or ticker)</td></tr>
      <tr><td>EQS</td><td>Equity screener — 8 predefined screens</td></tr>
      <tr><td>GMM</td><td>Global macro movers — cross-asset ranked</td></tr>
      <tr><td>BTMM</td><td>US treasury & money markets composite</td></tr>
      <tr><td>NI TECH</td><td>News by topic</td></tr>
      <tr><td>AAPL ANR / HDS / DVD / HP / BQ</td><td>Analyst recs · holders · dividends · price table · quote</td></tr>
      <tr><td>VOD LN EQUITY</td><td>Bloomberg grammar — venue + yellow key (LN=London, GY=Xetra, JT=Tokyo…)</td></tr>
      <tr><td>SPX INDEX · EURUSD CRNCY · GOLD CMDTY</td><td>Yellow-key symbol mapping</td></tr>
      <tr><td>MENU</td><td>Back to previous screen · ↑/↓ recall commands · HIST history</td></tr>
      <tr><td>PANL 2 / PANL 4</td><td>Multi-panel workspace · PANEL cycles panels</td></tr>
      <tr><td>4</td><td>Type a number + GO to open that numbered menu item</td></tr>
      <tr><td>HELP</td><td>This screen</td></tr>
    </table></div>
    <p class="note">Symbols use Yahoo conventions: indices <span class="ex">^GSPC</span>, FX <span class="ex">EURUSD=X</span>, futures <span class="ex">GC=F</span>, crypto <span class="ex">BTC-USD</span>, non-US <span class="ex">BMW.DE</span>, <span class="ex">7203.T</span>.</p>
    <p class="note">Data: Yahoo Finance (quotes, charts, fundamentals, movers), CoinGecko (crypto), ECB via Frankfurter (FX), optional Finnhub key for richer news/profiles. Free-tier data is delayed — for information only, not investment advice.</p>
  </div>`;
}

/* ----------------------------------------------------------- commands */

/* Bloomberg command grammar: TICKER [VENUE] [YELLOW KEY] [FUNCTION] <GO> */
const VENUES = { US: '', UN: '', UW: '', LN: '.L', GY: '.DE', GR: '.DE', FP: '.PA', IM: '.MI', SM: '.MC', NA: '.AS', SW: '.SW', VX: '.SW', JT: '.T', JP: '.T', HK: '.HK', AU: '.AX', AT: '.AX', CT: '.TO', IN: '.NS', KS: '.KS', TT: '.TW', BZ: '.SA' };
const YELLOW_KEYS = ['EQUITY', 'INDEX', 'CRNCY', 'CURNCY', 'CMDTY', 'COMDTY', 'GOVT', 'CORP', 'MUNI', 'PFD', 'MMKT'];
const IDX_ALIAS = { SPX: '^GSPC', INDU: '^DJI', DJI: '^DJI', CCMP: '^IXIC', NDX: '^NDX', RTY: '^RUT', VIX: '^VIX', UKX: '^FTSE', DAX: '^GDAXI', CAC: '^FCHI', SX5E: '^STOXX50E', IBEX: '^IBEX', NKY: '^N225', HSI: '^HSI', AS51: '^AXJO', SENSEX: '^BSESN', NIFTY: '^NSEI', KOSPI: '^KS11', SPTSX: '^GSPTSE', IBOV: '^BVSP', MEXBOL: '^MXX' };
const CMDTY_ALIAS = { GC: 'GC=F', GOLD: 'GC=F', SI: 'SI=F', SILVER: 'SI=F', CL: 'CL=F', WTI: 'CL=F', CO: 'BZ=F', BRENT: 'BZ=F', NG: 'NG=F', HG: 'HG=F', PL: 'PL=F', PA: 'PA=F', ZC: 'ZC=F', ZW: 'ZW=F', ZS: 'ZS=F', KC: 'KC=F', SB: 'SB=F', CT: 'CT=F', CC: 'CC=F', ES: 'ES=F', NQ: 'NQ=F', YM: 'YM=F' };
const GOVT_ALIAS = { USGG3M: '^IRX', USGG5YR: '^FVX', USGG10YR: '^TNX', USGG10: '^TNX', USGG30YR: '^TYX' };

function parseSecurityTokens(toks) {
  let yellow = null;
  if (toks.length && YELLOW_KEYS.includes(toks[toks.length - 1])) yellow = toks.pop();
  let venue = null;
  if (toks.length === 2 && VENUES[toks[1]] !== undefined) venue = toks.pop();
  const raw = toks.join('');
  if (!raw) return null;
  if (yellow === 'INDEX') return IDX_ALIAS[raw] || ('^' + raw);
  if (yellow === 'CRNCY' || yellow === 'CURNCY') {
    if (raw === 'DXY' || raw === 'DX') return 'DX-Y.NYB';
    if (raw.length === 6) return raw + '=X';
    if (raw.length === 3) return raw === 'USD' ? 'DX-Y.NYB' : raw + 'USD=X';
    return raw;
  }
  if (yellow === 'CMDTY' || yellow === 'COMDTY') return CMDTY_ALIAS[raw] || (raw.includes('=') ? raw : raw + '=F');
  if (yellow === 'GOVT') return GOVT_ALIAS[raw] || raw;
  return raw + (venue ? VENUES[venue] : '');
}

/* navigation stack (MENU = back) + persistent command history */
const navStack = [];
const fwdStack = [];
const cmdHistory = JSON.parse(localStorage.getItem('openterm.hist') || '[]');
let histIdx = -1;
function pushHistory(c) {
  if (!c) return;
  if (cmdHistory[0] !== c) {
    cmdHistory.unshift(c);
    if (cmdHistory.length > 60) cmdHistory.length = 60;
    localStorage.setItem('openterm.hist', JSON.stringify(cmdHistory));
  }
  histIdx = -1;
}

function runNumbered(n) {
  if (n === 96 || n === 97 || n === 98) {
    const b = document.querySelector(`.fn-act[data-act="${n === 96 ? 'actions' : n === 97 ? 'export' : 'settings'}"]`);
    return b ? b.click() : msg(`No ${n}) action here`, true);
  }
  const fa = document.querySelectorAll('.fa-tabs .fa-tab');
  if (fa.length && n >= 1 && n <= fa.length) return fa[n - 1].click();
  const sf = document.querySelectorAll('#sec-funcs .sec-func');
  if (sf.length && n >= 1 && n <= sf.length) return sf[n - 1].click();
  msg(`No menu item ${n}) on this screen`, true);
}

function runCommand(raw, opts = {}) {
  let input = raw.trim().toUpperCase();
  if (!input) return;
  msg('');
  const parts = input.split(/\s+/);
  while (parts.length && (parts[parts.length - 1] === 'GO' || parts[parts.length - 1] === '<GO>')) parts.pop();
  if (!parts.length) return;
  input = parts.join(' ');
  const [head, ...rest] = parts;

  // MENU acts as back; FWD replays
  if (head === 'MENU' || head === 'BACK') {
    if (navStack.length >= 2) { fwdStack.push(navStack.pop()); return runCommand(navStack[navStack.length - 1], { noPush: true }); }
    return runCommand('HOME', { noPush: true });
  }
  if (head === 'FWD' || head === 'FORWARD') {
    const nxt = fwdStack.pop();
    return nxt ? runCommand(nxt) : msg('Nothing to go forward to', true);
  }
  // pure number = numbered menu item on the current screen
  if (/^\d{1,3}$/.test(input)) return runNumbered(parseInt(input, 10));

  if (!opts.noPush) {
    if (navStack[navStack.length - 1] !== input) navStack.push(input);
    if (navStack.length > 40) navStack.shift();
    fwdStack.length = 0;
    pushHistory(input);
  }

  const topLevel = {
    HOME: showLaunchpad, LAUNCH: showLaunchpad, LP: showLaunchpad,
    WEI: showWEI, MOST: showMovers, MOV: showMovers, MOVERS: showMovers,
    CMDTY: showCommodities, COMD: showCommodities, GOVT: showRates, RATES: showRates, YCRV: showRates,
    FX: showFX, WCRS: showFX, CRYP: showCrypto, CRYPTO: showCrypto, TOP: showTopNews,
    EQS: showEQS, SCRN: showEQS, BTMM: showBTMM, GMM: showGMM,
    HIST: showHist, CMND: showHist,
    HELP: showHelp, '?': showHelp,
  };
  if (topLevel[head] && !rest.length) return topLevel[head]();
  if (head === 'EQS' && rest.length) return showEQS(rest[0].toLowerCase());
  if (head === 'NI') return showNI(rest.join(' ') || 'markets');
  if (head === 'PANL') return showPanl(rest[0]);
  if (head === 'PANEL') return cyclePanel();

  if (head === 'S' || head === 'SECF' || head === 'SEARCH') {
    const q = rest.join(' ');
    return q ? showSearch(q) : msg('Usage: S <name or ticker>', true);
  }
  if (head === 'W' || head === 'WL' || head === 'PORT') {
    const op = rest[0];
    if (op === 'ADD' && rest[1]) {
      if (!state.watchlist.includes(rest[1])) { state.watchlist.push(rest[1]); saveWatchlist(); }
      msg(`${rest[1]} added to watchlist`);
      return showWatchlist();
    }
    if ((op === 'DEL' || op === 'RM' || op === 'REMOVE') && rest[1]) {
      state.watchlist = state.watchlist.filter((s) => s !== rest[1]);
      saveWatchlist(); msg(`${rest[1]} removed`);
      return showWatchlist();
    }
    return showWatchlist();
  }

  // bare per-security functions act on the loaded security
  const secFns = ['DES', 'GP', 'GIP', 'FA', 'ERN', 'CN', 'N', 'ANR', 'HDS', 'DVD', 'HP', 'BQ'];
  if (secFns.includes(head) && !rest.length) {
    if (!state.symbol) return msg('Load a security first — e.g. AAPL', true);
    return runFunc(head === 'N' ? 'CN' : head);
  }

  // SECURITY [VENUE] [YELLOW KEY] [FUNCTION] — full Bloomberg grammar
  const toks = [...parts];
  let fn = 'GP';
  if (toks.length > 1 && secFns.includes(toks[toks.length - 1])) {
    fn = toks.pop();
    if (fn === 'N') fn = 'CN';
  }
  const symbol = parseSecurityTokens(toks);
  if (!symbol) return msg('Unrecognized command — HELP <GO>', true);
  return loadSecurity(symbol, fn);
}

/* HIST — command history screen */
function showHist() {
  state.view = 'HIST'; setActiveTabs(null); markFunc(null); setTab('HIST Cmnd History', 'HIST');
  el('view').innerHTML = `<div class="fa-screen">` + fnBar('COMMAND HISTORY', 'HIST', 'CMND HISTORY')
    + `<div class="sec-body" style="flex:1;overflow:auto"><div class="tbl-wrap"><table class="data">
      <tr><th>#</th><th>COMMAND</th></tr>
      ${cmdHistory.map((c, i) => `<tr class="click hist-row" data-cmd="${esc(c)}"><td class="muted">${i + 1})</td><td class="hl">${esc(c)}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">No commands yet.</td></tr>'}
    </table></div></div></div>`;
  el('view').querySelectorAll('.hist-row').forEach((r) => r.addEventListener('click', () => runCommand(r.dataset.cmd)));
}

/* ------------------------------------------------------- autocomplete */

let acTimer, acItems = [], acSel = -1;
const KNOWN = new Set(['HOME', 'WEI', 'MOST', 'MOV', 'MOVERS', 'CMDTY', 'GOVT', 'RATES', 'FX', 'CRYP', 'CRYPTO', 'TOP', 'HELP', 'MENU', 'W', 'WL', 'PORT', 'S', 'SECF', 'DES', 'GP', 'GIP', 'FA', 'ERN', 'CN', 'N']);

const FUNC_DEFS = [
  ['HOME', 'Launchpad'], ['WEI', 'World Equity Indices'], ['MOST', 'Market Movers'], ['EQS', 'Equity Screener'],
  ['GMM', 'Global Macro Movers'], ['BTMM', 'Treasury & Money Mkts'], ['CMDTY', 'Commodities'], ['GOVT', 'Rates & Yields'],
  ['FX', 'Currencies'], ['CRYP', 'Crypto'], ['TOP', 'Top News'], ['NI', 'News by Topic'], ['W', 'Watchlist'],
  ['HIST', 'Command History'], ['DES', 'Description'], ['GP', 'Price Graph'], ['GIP', 'Intraday'], ['FA', 'Financial Analysis'],
  ['ERN', 'Earnings'], ['CN', 'Company News'], ['ANR', 'Analyst Recs'], ['HDS', 'Holders'], ['DVD', 'Dividends'],
  ['HP', 'Historical Prices'], ['BQ', 'Quote'], ['PANL', 'Multi-Panel'], ['HELP', 'Guide'],
];

function yellowTag(t) {
  t = (t || '').toLowerCase();
  if (t.includes('index')) return 'Index';
  if (t.includes('etf')) return 'Equity';
  if (t.includes('currency')) return 'Curncy';
  if (t.includes('future')) return 'Comdty';
  if (t.includes('crypto')) return 'Crypto';
  if (t.includes('option')) return 'Option';
  return 'Equity';
}

function hideAC() { el('autocomplete').classList.add('hidden'); acItems = []; acSel = -1; }
function acPick(item) {
  hideAC(); el('cmd').value = '';
  if (item.t === 'fn') runCommand(item.code);
  else loadSecurity(item.symbol, 'GP');
}
function renderAC() {
  const box = el('autocomplete');
  if (!acItems.length) return hideAC();
  box.innerHTML = acItems.map((q, i) => (q.t === 'fn'
    ? `<div class="ac-row ${i === acSel ? 'sel' : ''}" data-i="${i}">
        <span class="ac-sym blue">${esc(q.code)}</span><span class="ac-name">${esc(q.name)}</span><span class="ac-key fn">Function</span></div>`
    : `<div class="ac-row ${i === acSel ? 'sel' : ''}" data-i="${i}">
        <span class="ac-sym">${esc(q.symbol)}</span><span class="ac-name">${esc(q.name)}</span>
        <span class="ac-exch">${esc(q.exchange || '')}</span><span class="ac-key">${yellowTag(q.type)}</span></div>`)).join('');
  box.classList.remove('hidden');
  box.querySelectorAll('.ac-row').forEach((r) => r.addEventListener('mousedown', (e) => {
    e.preventDefault(); acPick(acItems[parseInt(r.dataset.i, 10)]);
  }));
}
function onCmdInput() {
  const v = el('cmd').value.trim();
  clearTimeout(acTimer);
  histIdx = -1;
  if (!v || /\s/.test(v) || KNOWN.has(v.toUpperCase())) return hideAC();
  const fns = FUNC_DEFS.filter(([c]) => c.startsWith(v.toUpperCase())).slice(0, 3)
    .map(([code, name]) => ({ t: 'fn', code, name }));
  acTimer = setTimeout(async () => {
    try {
      const d = await api(`/api/search?q=${encodeURIComponent(v)}`);
      acItems = [...fns, ...d.quotes.slice(0, 7)];
      acSel = -1; renderAC();
    } catch { acItems = fns; acSel = -1; renderAC(); }
  }, 200);
}

/* --------------------------------------------------------- news ticker */

async function loadTicker() {
  try {
    const data = await api('/api/news?symbol=SPY');
    const txt = data.items.slice(0, 15).map((n) => n.title).join('  <span class="tk-sep">•</span>  ');
    const tk = el('news-ticker');
    tk.innerHTML = txt + '  <span class="tk-sep">•</span>  ';
    // simple marquee
    let x = tk.parentElement.clientWidth;
    const w = tk.scrollWidth;
    if (window._tkTimer) clearInterval(window._tkTimer);
    window._tkTimer = setInterval(() => {
      x -= 1; if (x < -w) x = tk.parentElement.clientWidth;
      tk.style.transform = `translateX(${x}px)`;
    }, 30);
  } catch { /* ignore */ }
}

/* --------------------------------------------------------------- tape */

async function refreshTape() {
  try {
    const byName = await quoteBoard(TAPE.map((t) => t[0]));
    el('tape').innerHTML = TAPE.map(([sym, label]) => {
      const q = byName[sym]; if (!q || q.error) return '';
      return `<span class="tape-item" data-sym="${esc(sym)}"><span class="t-sym">${esc(label)}</span>
        <span class="t-px ${q._flash || ''}">${fmtPrice(q.price)}</span><span class="${chgClass(q.change)}">${arrow(q.change)}${fmtNum(Math.abs(q.changePct))}%</span></span>`;
    }).join('');
    el('tape').querySelectorAll('.tape-item').forEach((it) => it.addEventListener('click', () => loadSecurity(it.dataset.sym, 'GP')));
  } catch { /* keep previous */ }
}

async function refreshSecQuote() {
  if (!state.symbol) return;
  try { const q = await api(`/api/quote/${encodeURIComponent(state.symbol)}`); state.quote = q; renderSecHeader(q); markFunc(state.func); }
  catch { /* transient */ }
}

/* -------------------------------------------------------------- keybar */

const KEYS = [
  ['HOME', 'Launchpad', 'k-orange'], ['WEI', 'World Idx', 'k-yellow'], ['MOST', 'Movers', 'k-yellow'],
  ['EQS', 'Screener', 'k-yellow'], ['GMM', 'Macro Mov', 'k-yellow'], ['BTMM', 'Money Mkt', 'k-yellow'],
  ['CMDTY', 'Cmdty', 'k-yellow'], ['GOVT', 'Rates', 'k-yellow'], ['FX', 'FX', 'k-yellow'],
  ['CRYP', 'Crypto', 'k-yellow'], ['TOP', 'News', 'k-blue'], ['DES', 'Desc', 'k-cyan'],
  ['GP', 'Graph', 'k-green'], ['FA', 'Fundmtls', 'k-cyan'], ['ERN', 'Earnings', 'k-cyan'],
  ['ANR', 'Analyst', 'k-cyan'], ['HDS', 'Holders', 'k-cyan'], ['DVD', 'Dividends', 'k-cyan'],
  ['W', 'Watchlist', 'k-orange'], ['PANL 4', 'Panels', 'k-red'], ['HELP', 'Help', 'k-blue'],
];
function buildKeybar() {
  el('keybar').innerHTML = KEYS.map(([cmd, label, cls]) =>
    `<button class="fkey ${cls}" data-cmd="${cmd}">${cmd}<small>${label}</small></button>`).join('');
  el('keybar').querySelectorAll('.fkey').forEach((b) => b.addEventListener('click', () => runCommand(b.dataset.cmd)));
}

/* --------------------------------------------------------------- init */

function init() {
  buildKeybar();
  showLaunchpad();
  refreshTape();
  loadTicker();
  tickClock();

  setInterval(tickClock, 1000);
  setInterval(refreshTape, 30_000);
  setInterval(refreshSecQuote, 15_000);
  setInterval(() => { if (state.view === 'LAUNCH') showLaunchpad(); }, 90_000);
  setInterval(loadTicker, 300_000);

  // chrome + help wiring
  el('help-btn').addEventListener('click', () => runCommand('HELP'));
  document.querySelector('.chr-menu').addEventListener('click', () => runCommand('HELP'));
  document.querySelector('.chr-ic.help').addEventListener('click', () => runCommand('HELP'));
  el('chr-sec').addEventListener('click', () => { if (el('chr-sec').dataset.cmd) loadSecurity(el('chr-sec').dataset.cmd, state.func || 'GP'); });
  const arrows = document.querySelectorAll('.chr-arrow');
  if (arrows[0]) arrows[0].addEventListener('click', () => runCommand('MENU'));
  if (arrows[1]) arrows[1].addEventListener('click', () => runCommand('FWD'));

  const cmd = el('cmd');
  cmd.addEventListener('input', onCmdInput);
  cmd.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && acItems.length) { e.preventDefault(); acSel = (acSel + 1) % acItems.length; renderAC(); }
    else if (e.key === 'ArrowUp' && acItems.length) { e.preventDefault(); acSel = (acSel - 1 + acItems.length) % acItems.length; renderAC(); }
    else if (e.key === 'ArrowUp') {  // command history recall
      e.preventDefault();
      if (histIdx < cmdHistory.length - 1) { histIdx++; cmd.value = cmdHistory[histIdx] || ''; }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histIdx > 0) { histIdx--; cmd.value = cmdHistory[histIdx] || ''; }
      else { histIdx = -1; cmd.value = ''; }
    }
    else if (e.key === 'Escape') hideAC();
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (acSel >= 0 && acItems[acSel]) acPick(acItems[acSel]);
      else { hideAC(); const v = cmd.value; cmd.value = ''; runCommand(v); }
    }
  });
  cmd.addEventListener('blur', () => setTimeout(hideAC, 150));
  el('go-btn').addEventListener('click', () => { const v = cmd.value; cmd.value = ''; hideAC(); runCommand(v); cmd.focus(); });

  // red function-bar action buttons (96/97/98), delegated since the bar re-renders
  el('view').addEventListener('click', (e) => {
    const btn = e.target.closest('.fn-act');
    if (!btn) return;
    if (btn.dataset.act === 'export') exportCSV();
    else showHelp(); // ACTIONS / SETTINGS → command menu
  });

  window.addEventListener('resize', () => { if (chartEl && el('chart')) resizeChart(); });

  // keep focus on command line (desktop only — avoid popping mobile keyboard)
  if (!matchMedia('(pointer: coarse)').matches) {
    document.addEventListener('keydown', (e) => {
      if (e.target === cmd || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.length === 1) cmd.focus();
    });
  }
}

init();
