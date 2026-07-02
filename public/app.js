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

/* -------------------------------------------------------------- state */

const state = {
  symbol: null,
  quote: null,
  func: null,        // active per-security function code
  view: 'home',      // active top-level view
  range: '6mo',
  chartType: 'candle',
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
  el('clock').textContent = now.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const open = marketOpen();
  const s = el('mkt-status');
  s.classList.toggle('open', open);
  s.classList.toggle('closed', !open);
  el('mkt-status-text').textContent = open ? 'US OPEN' : 'US CLOSED';
}

/* ------------------------------------------------------- view render */

function setActiveTabs(view) {
  document.querySelectorAll('.top-tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.cmd === view));
}

function secBar(title, right = '', extra = '') {
  return `<div class="sec-bar"><span>${title}</span><span class="right">${right}</span>${extra}</div>`;
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
  el('sec-exch').textContent = [q.exchange, q.currency].filter(Boolean).join(' · ');
  const p = el('sec-price');
  p.textContent = fmtPrice(q.price);
  p.className = chgClass(q.change);
  const c = el('sec-change');
  c.textContent = fmtChange(q.change, q.changePct);
  c.className = chgClass(q.change);
  el('sec-time').textContent = q.marketTime
    ? `As of ${new Date(q.marketTime * 1000).toLocaleString()} ${q.timezone} · Prev ${fmtPrice(q.prevClose)} · O ${fmtPrice(q.open)} · H ${fmtPrice(q.dayHigh)} · L ${fmtPrice(q.dayLow)} · Vol ${fmtBig(q.volume)}`
    : '';
  el('sec-funcs').innerHTML = SEC_FUNCS.map(([code, label], i) =>
    `<button class="sec-func" data-func="${code}"><span class="n">${i + 1})</span>${code} <span class="muted" style="font-weight:400">${label}</span></button>`).join('');
  el('sec-funcs').querySelectorAll('.sec-func').forEach((b) =>
    b.addEventListener('click', () => runFunc(b.dataset.func)));
}

function markFunc(code) {
  state.func = code;
  document.querySelectorAll('.sec-func').forEach((b) =>
    b.classList.toggle('active', b.dataset.func === code));
}

function runFunc(code) {
  markFunc(code);
  if (code === 'GP') return showChart('6mo');
  if (code === 'GIP') return showChart('1d');
  if (code === 'DES') return showDES();
  if (code === 'FA') return showFA();
  if (code === 'ERN') return showERN();
  if (code === 'CN' || code === 'N') return showNews();
  return showChart('6mo');
}

/* -------------------------------------------------------------- chart */

const RANGE_LABELS = [['1d', '1D'], ['5d', '5D'], ['1mo', '1M'], ['3mo', '3M'],
  ['6mo', '6M'], ['1y', '1Y'], ['5y', '5Y'], ['max', 'MAX']];

let chartEl, ctx, hoverIdx = -1;

async function showChart(range) {
  if (!state.symbol) { msg('Load a security first — e.g. AAPL GP', true); return; }
  if (range) state.range = range;
  setActiveTabs(null);
  el('view').innerHTML = `
    <div id="screen-chart">
      <div id="chart-toolbar">
        <span class="tb-label">RANGE</span>
        ${RANGE_LABELS.map(([r, l]) => `<button class="tb-btn rbtn" data-range="${r}">${l}</button>`).join('')}
        <span class="tb-label">TYPE</span>
        <button class="tb-btn tbtn" data-type="candle">CANDLE</button>
        <button class="tb-btn tbtn" data-type="line">LINE</button>
      </div>
      <div id="chart-wrap"><canvas id="chart"></canvas></div>
      <div id="chart-legend"></div>
    </div>`;
  chartEl = el('chart');
  ctx = chartEl.getContext('2d');
  el('view').querySelectorAll('.rbtn').forEach((b) => {
    b.classList.toggle('active', b.dataset.range === state.range);
    b.addEventListener('click', () => { state.range = b.dataset.range; markFunc(b.dataset.range === '1d' ? 'GIP' : 'GP'); showChart(); });
  });
  el('view').querySelectorAll('.tbtn').forEach((b) => {
    b.classList.toggle('active', b.dataset.type === state.chartType);
    b.addEventListener('click', () => { state.chartType = b.dataset.type; el('view').querySelectorAll('.tbtn').forEach((x) => x.classList.toggle('active', x === b)); drawChart(); });
  });
  attachChartEvents();
  try {
    const data = await api(`/api/history/${encodeURIComponent(state.symbol)}?range=${state.range}`);
    state.candles = data.candles;
    hoverIdx = -1;
    resizeChart();
  } catch (err) { msg(`chart: ${err.message}`, true); el('chart-legend').innerHTML = `<span class="neg">${esc(err.message)}</span>`; }
}

function attachChartEvents() {
  const move = (clientX) => {
    if (!state.candles.length) return;
    const rect = chartEl.getBoundingClientRect();
    const M = { left: 8, right: 62 };
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
  ctx.fillStyle = '#050505';
  ctx.fillRect(0, 0, W, H);
  if (!candles.length) return;

  const M = { top: 12, right: 62, bottom: 22, left: 8 };
  const volH = Math.max(28, Math.floor((H - M.top - M.bottom) * 0.16));
  const priceH = H - M.top - M.bottom - volH - 6;
  const plotW = W - M.left - M.right;
  const n = candles.length;

  let lo = Infinity, hi = -Infinity, maxV = 0;
  for (const c of candles) { if (c.l < lo) lo = c.l; if (c.h > hi) hi = c.h; if (c.v > maxV) maxV = c.v; }
  const pad = (hi - lo) * 0.06 || hi * 0.01 || 1;
  lo -= pad; hi += pad;
  const xAt = (i) => M.left + ((i + 0.5) / n) * plotW;
  const yAt = (p) => M.top + (1 - (p - lo) / (hi - lo)) * priceH;
  const volTop = M.top + priceH + 6;

  ctx.font = '10px monospace';
  ctx.textBaseline = 'middle';
  for (let g = 0; g <= 6; g++) {
    const p = lo + ((hi - lo) * g) / 6, y = yAt(p);
    ctx.strokeStyle = '#171717';
    ctx.beginPath(); ctx.moveTo(M.left, y); ctx.lineTo(W - M.right, y); ctx.stroke();
    ctx.fillStyle = '#8f8f8f'; ctx.textAlign = 'left';
    ctx.fillText(fmtPrice(p), W - M.right + 5, y);
  }
  const intraday = ['1d', '5d'].includes(state.range);
  const ticks = Math.max(2, Math.floor(plotW / 100));
  ctx.fillStyle = '#8f8f8f'; ctx.textAlign = 'center';
  for (let g = 0; g <= ticks; g++) {
    const i = Math.min(n - 1, Math.round((g / ticks) * (n - 1)));
    ctx.fillText(xLabel(candles[i].t, intraday), xAt(i), H - M.bottom / 2);
  }
  const bw = Math.max(1, (plotW / n) * 0.7);
  for (let i = 0; i < n; i++) {
    const c = candles[i], h = maxV ? (c.v / maxV) * volH : 0;
    ctx.fillStyle = c.c >= c.o ? 'rgba(51,221,136,0.32)' : 'rgba(255,75,75,0.32)';
    ctx.fillRect(xAt(i) - bw / 2, volTop + volH - h, bw, h);
  }
  if (state.chartType === 'line' || n > 240) {
    ctx.beginPath();
    for (let i = 0; i < n; i++) { const x = xAt(i), y = yAt(candles[i].c); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.strokeStyle = '#ff7a00'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.lineTo(xAt(n - 1), M.top + priceH); ctx.lineTo(xAt(0), M.top + priceH); ctx.closePath();
    const g = ctx.createLinearGradient(0, M.top, 0, M.top + priceH);
    g.addColorStop(0, 'rgba(255,122,0,0.20)'); g.addColorStop(1, 'rgba(255,122,0,0)');
    ctx.fillStyle = g; ctx.fill(); ctx.lineWidth = 1;
  } else {
    for (let i = 0; i < n; i++) {
      const c = candles[i], x = xAt(i), up = c.c >= c.o;
      ctx.strokeStyle = ctx.fillStyle = up ? '#33dd88' : '#ff4b4b';
      ctx.beginPath(); ctx.moveTo(x, yAt(c.h)); ctx.lineTo(x, yAt(c.l)); ctx.stroke();
      const top = yAt(Math.max(c.o, c.c)), bh = Math.max(1, Math.abs(yAt(c.o) - yAt(c.c)));
      ctx.fillRect(x - bw / 2, top, bw, bh);
    }
  }
  if (state.quote?.prevClose > lo && state.quote?.prevClose < hi) {
    const y = yAt(state.quote.prevClose);
    ctx.strokeStyle = '#4d4d4d'; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(M.left, y); ctx.lineTo(W - M.right, y); ctx.stroke(); ctx.setLineDash([]);
  }
  if (hoverIdx >= 0 && hoverIdx < n) {
    const c = candles[hoverIdx], x = xAt(hoverIdx), y = yAt(c.c);
    ctx.strokeStyle = 'rgba(255,122,0,0.6)'; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, M.top); ctx.lineTo(x, volTop + volH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(M.left, y); ctx.lineTo(W - M.right, y); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#ff7a00'; ctx.textAlign = 'left'; ctx.fillText(fmtPrice(c.c), W - M.right + 5, y);
    el('chart-legend').innerHTML =
      `${esc(xLabel(c.t, intraday))}  O:<span class="flat">${fmtPrice(c.o)}</span> H:<span class="pos">${fmtPrice(c.h)}</span> L:<span class="neg">${fmtPrice(c.l)}</span> C:<span class="${chgClass(c.c - c.o)}">${fmtPrice(c.c)}</span> VOL:${fmtBig(c.v)}`;
  } else {
    const f = candles[0], l = candles[n - 1], chg = l.c - f.c, pct = f.c ? (chg / f.c) * 100 : 0;
    el('chart-legend').innerHTML =
      `${esc(state.symbol)} ${esc(state.range.toUpperCase())} · chg <span class="${chgClass(chg)}">${fmtChange(chg, pct)}</span> · HI ${fmtPrice(Math.max(...candles.map((c) => c.h)))} · LO ${fmtPrice(Math.min(...candles.map((c) => c.l)))} · hover for OHLC`;
  }
}

/* ---------------------------------------------------------------- DES */

async function showDES() {
  if (!state.symbol) { msg('Load a security first', true); return; }
  setActiveTabs(null);
  el('view').innerHTML = secBar(`DES — SECURITY DESCRIPTION`, esc(state.symbol)) +
    `<div class="sec-body"><div class="loading">Loading…</div></div>`;
  const body = el('view').querySelector('.sec-body');
  try {
    const [q, p, s] = await Promise.all([
      api(`/api/quote/${encodeURIComponent(state.symbol)}`),
      api(`/api/profile/${encodeURIComponent(state.symbol)}`).catch(() => ({})),
      api(`/api/summary/${encodeURIComponent(state.symbol)}`).catch(() => null),
    ]);
    const kv = (k, v, hl) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v ${hl ? 'hl' : ''}">${v}</span></div>`;
    const off52 = q.high52w ? ((q.price - q.high52w) / q.high52w) * 100 : null;
    body.innerHTML = `
      ${s && s.summary ? `<div class="biz-summary">${esc(s.summary.slice(0, 520))}${s.summary.length > 520 ? '…' : ''}</div>` : ''}
      <div class="sec-bar" style="position:static;margin:4px 0">IDENTIFICATION</div>
      <div class="kv-grid">
        ${kv('Name', esc(s?.name || p.name || q.name))}
        ${kv('Ticker', esc(q.symbol), true)}
        ${kv('Type', esc(q.type || '—'))}
        ${kv('Exchange', esc(p.exchange || q.exchange || '—'))}
        ${kv('Sector', esc(s?.sector || p.sector || '—'))}
        ${kv('Industry', esc(s?.industry || p.industry || '—'))}
        ${kv('Country', esc(s?.country || p.country || '—'))}
        ${kv('Currency', esc(q.currency || '—'))}
        ${s?.employees ? kv('Employees', fmtBig(s.employees)) : ''}
        ${s?.website ? kv('Website', `<a class="blue" href="${esc(s.website)}" target="_blank" rel="noopener">${esc(s.website.replace(/^https?:\/\//, ''))}</a>`) : ''}
      </div>
      <div class="sec-bar" style="position:static;margin:8px 0 4px">MARKET DATA</div>
      <div class="kv-grid">
        ${kv('Last', fmtPrice(q.price), true)}
        ${kv('Change', `<span class="${chgClass(q.change)}">${fmtChange(q.change, q.changePct)}</span>`)}
        ${kv('Prev Close', fmtPrice(q.prevClose))}
        ${kv('Open', fmtPrice(q.open))}
        ${kv('Day Range', `${fmtPrice(q.dayLow)} – ${fmtPrice(q.dayHigh)}`)}
        ${kv('52W Range', `${fmtPrice(q.low52w)} – ${fmtPrice(q.high52w)}`)}
        ${off52 != null ? kv('% Off 52W Hi', `<span class="${chgClass(off52)}">${fmtPct(off52)}</span>`) : ''}
        ${kv('Volume', fmtBig(q.volume))}
        ${s?.avgVolume ? kv('Avg Volume', fmtBig(s.avgVolume)) : ''}
        ${kv('Market Cap', fmtBig(s?.marketCap ?? p.marketCap), true)}
        ${s?.sharesOut ? kv('Shares Out', fmtBig(s.sharesOut)) : (p.sharesOut ? kv('Shares Out', fmtBig(p.sharesOut)) : '')}
        ${s?.beta != null ? kv('Beta', fmtRatio(s.beta)) : ''}
      </div>`;
  } catch (err) { body.innerHTML = `<div class="err">${esc(err.message)}</div>`; }
}

/* ----------------------------------------------------------------- FA */

async function showFA() {
  if (!state.symbol) { msg('Load a security first', true); return; }
  setActiveTabs(null);
  el('view').innerHTML = secBar('FA — FINANCIAL ANALYSIS', esc(state.symbol)) +
    `<div class="sec-body"><div class="loading">Loading fundamentals…</div></div>`;
  const body = el('view').querySelector('.sec-body');
  try {
    const s = await api(`/api/summary/${encodeURIComponent(state.symbol)}`);
    const kv = (k, v, hl) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v ${hl ? 'hl' : ''}">${v}</span></div>`;
    const recKey = (s.recommendationKey || '').toLowerCase();
    const recCls = /buy/.test(recKey) ? 'rec-buy' : /sell|underperform/.test(recKey) ? 'rec-sell' : 'rec-hold';
    const q = state.quote || {};
    // analyst target bar
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
    body.innerHTML = `
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
      ${tgt}`;
  } catch (err) {
    body.innerHTML = `<div class="err">Fundamentals unavailable: ${esc(err.message)}</div>
      <div class="muted" style="padding:8px">Yahoo's fundamentals endpoint requires a session token that can rate-limit. Try again shortly, or add a Finnhub key for an alternate source.</div>`;
  }
}

/* ---------------------------------------------------------------- ERN */

async function showERN() {
  if (!state.symbol) { msg('Load a security first', true); return; }
  setActiveTabs(null);
  el('view').innerHTML = secBar('ERN — EARNINGS', esc(state.symbol)) +
    `<div class="sec-body"><div class="loading">Loading earnings…</div></div>`;
  const body = el('view').querySelector('.sec-body');
  try {
    const s = await api(`/api/summary/${encodeURIComponent(state.symbol)}`);
    const q = s.earningsQuarterly || [];
    const y = s.yearly || [];
    if (!q.length && !y.length) { body.innerHTML = '<div class="muted">No earnings data available for this security.</div>'; return; }
    const maxEps = Math.max(1, ...q.flatMap((r) => [Math.abs(r.actual || 0), Math.abs(r.estimate || 0)]));
    const qHtml = q.map((r) => {
      const beat = r.actual != null && r.estimate != null ? r.actual - r.estimate : null;
      const bh = (v) => `${Math.max(2, (Math.abs(v || 0) / maxEps) * 56)}px`;
      return `<div class="earn-col">
        <div class="earn-beat ${beat == null ? 'muted' : chgClass(beat)}">${beat == null ? '' : (beat >= 0 ? '+' : '') + fmtNum(beat)}</div>
        <div class="earn-bars">
          <div class="earn-bar est" style="height:${bh(r.estimate)}" title="Est ${fmtNum(r.estimate)}"></div>
          <div class="earn-bar act" style="height:${bh(r.actual)}" title="Act ${fmtNum(r.actual)}"></div>
        </div>
        <div class="earn-lbl">${esc(r.period)}</div>
      </div>`;
    }).join('');
    body.innerHTML = `
      <div class="sec-bar" style="position:static;margin:2px 0 4px">QUARTERLY EPS — ESTIMATE vs ACTUAL</div>
      <div class="earn-row">${qHtml}</div>
      <div class="muted" style="font-size:11px"><span style="color:var(--grey-2)">▉</span> estimate &nbsp; <span style="color:var(--orange)">▉</span> actual &nbsp; number = surprise</div>
      <div class="sec-bar" style="position:static;margin:10px 0 4px">ANNUAL REVENUE & EARNINGS</div>
      <div class="tbl-wrap"><table class="data">
        <tr><th>YEAR</th><th class="num">REVENUE</th><th class="num">EARNINGS</th><th class="num">NET MARGIN</th></tr>
        ${y.map((r) => `<tr><td class="hl">${esc(r.year)}</td><td class="num">${fmtBig(r.revenue)}</td><td class="num">${fmtBig(r.earnings)}</td><td class="num">${r.revenue ? fmtPct((r.earnings / r.revenue) * 100) : '—'}</td></tr>`).join('')}
      </table></div>
      <div class="kv-grid" style="margin-top:10px">
        <div class="kv"><span class="k">Next Earnings Date</span><span class="v hl">${fmtDate(s.nextEarningsDate)}</span></div>
      </div>`;
  } catch (err) { body.innerHTML = `<div class="err">${esc(err.message)}</div>`; }
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
  el('view').innerHTML = secBar('CN — COMPANY NEWS', esc(state.symbol)) + `<div class="sec-body"><div class="loading">Loading…</div></div>`;
  const body = el('view').querySelector('.sec-body');
  try {
    const data = await api(`/api/news?symbol=${encodeURIComponent(state.symbol)}`);
    body.innerHTML = newsHTML(data.items);
  } catch (err) { body.innerHTML = `<div class="err">${esc(err.message)}</div>`; }
}

async function showTopNews() {
  state.view = 'TOP'; setActiveTabs('TOP'); markFunc(null);
  el('view').innerHTML = secBar('TOP — TOP MARKET NEWS', 'Live') + `<div class="sec-body"><div class="loading">Loading…</div></div>`;
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
  quotes.forEach((q) => { byName[q.symbol] = q; });
  return byName;
}

function boardTable(rows, byName, opts = {}) {
  const extraHead = opts.extraHead || '';
  const extraCell = opts.extraCell || (() => '');
  return `<div class="tbl-wrap"><table class="data">
    <tr><th>NAME</th><th class="num">LAST</th><th class="num">CHG</th><th class="num">CHG%</th>${extraHead}</tr>
    ${rows.map(([sym, label]) => {
      const q = byName[sym];
      if (!q || q.error) return `<tr><td>${esc(label)}</td><td class="num muted" colspan="3">n/a</td>${extraCell(null)}</tr>`;
      return `<tr class="click" data-sym="${esc(sym)}">
        <td><span class="sym-cell">${esc(label)}</span></td>
        <td class="num">${fmtPrice(q.price)}</td>
        <td class="num ${chgClass(q.change)}">${arrow(q.change)} ${fmtNum(Math.abs(q.change))}</td>
        <td class="num ${chgClass(q.change)}">${fmtNum(Math.abs(q.changePct))}%</td>
        ${extraCell(q)}
      </tr>`;
    }).join('')}
  </table></div>`;
}

function wireRows(container) {
  container.querySelectorAll('tr.click[data-sym]').forEach((tr) =>
    tr.addEventListener('click', () => loadSecurity(tr.dataset.sym, 'GP')));
}

/* -------------------------------------------------------- WEI (world) */

async function showWEI() {
  state.view = 'WEI'; setActiveTabs('WEI'); markFunc(null);
  el('view').innerHTML = secBar('WEI — WORLD EQUITY INDICES', 'Live') + `<div id="wei-body"><div class="loading">Loading…</div></div>`;
  try {
    const all = Object.values(WORLD).flat().map((r) => r[0]);
    const byName = await quoteBoard(all);
    el('wei-body').innerHTML = `<div class="grid-2">${Object.entries(WORLD).map(([region, rows]) => `
      <div class="section">${secBar(region)}<div class="sec-body" style="padding:0">${boardTable(rows, byName)}</div></div>`).join('')}</div>`;
    wireRows(el('wei-body'));
  } catch (err) { el('wei-body').innerHTML = `<div class="err">${esc(err.message)}</div>`; }
}

/* -------------------------------------------------------- CMDTY */

async function showCommodities() {
  state.view = 'CMDTY'; setActiveTabs(null); markFunc(null);
  el('view').innerHTML = secBar('CMDTY — COMMODITIES', 'Live') + `<div id="cmdty-body"><div class="loading">Loading…</div></div>`;
  try {
    const all = Object.values(COMMODITIES).flat().map((r) => r[0]);
    const byName = await quoteBoard(all);
    el('cmdty-body').innerHTML = Object.entries(COMMODITIES).map(([grp, rows]) => `
      <div class="section">${secBar(grp)}<div class="sec-body" style="padding:0">${boardTable(rows, byName)}</div></div>`).join('');
    wireRows(el('cmdty-body'));
  } catch (err) { el('cmdty-body').innerHTML = `<div class="err">${esc(err.message)}</div>`; }
}

/* -------------------------------------------------------- GOVT / rates */

async function showRates() {
  state.view = 'GOVT'; setActiveTabs(null); markFunc(null);
  el('view').innerHTML = secBar('GOVT — US TREASURY YIELDS & FUTURES', 'Live') + `<div id="rate-body"><div class="loading">Loading…</div></div>`;
  try {
    const byName = await quoteBoard([...RATES, ...RATE_FUT].map((r) => r[0]));
    el('rate-body').innerHTML = `<div class="grid-2">
      <div class="section">${secBar('BENCHMARK YIELDS (%)')}<div class="sec-body" style="padding:0">${boardTable(RATES, byName)}</div></div>
      <div class="section">${secBar('TREASURY FUTURES')}<div class="sec-body" style="padding:0">${boardTable(RATE_FUT, byName)}</div></div>
    </div>`;
    wireRows(el('rate-body'));
  } catch (err) { el('rate-body').innerHTML = `<div class="err">${esc(err.message)}</div>`; }
}

/* -------------------------------------------------------- MOST (movers) */

let moversType = 'gainers';
async function showMovers(type) {
  if (type) moversType = type;
  state.view = 'MOST'; setActiveTabs('MOST'); markFunc(null);
  const tabs = `<span class="tabs">${[['gainers', 'GAINERS'], ['losers', 'LOSERS'], ['actives', 'MOST ACTIVE']]
    .map(([t, l]) => `<button class="tab mv-tab ${t === moversType ? 'active' : ''}" data-mv="${t}">${l}</button>`).join('')}</span>`;
  el('view').innerHTML = secBar('MOST — US MARKET MOVERS', '', tabs) + `<div id="mv-body"><div class="loading">Loading…</div></div>`;
  el('view').querySelectorAll('.mv-tab').forEach((b) => b.addEventListener('click', () => showMovers(b.dataset.mv)));
  try {
    const data = await api(`/api/movers?type=${moversType}`);
    el('mv-body').innerHTML = `<div class="tbl-wrap"><table class="data">
      <tr><th>SYM</th><th>NAME</th><th class="num">LAST</th><th class="num">CHG</th><th class="num">CHG%</th><th class="num">VOLUME</th><th class="num">MKT CAP</th></tr>
      ${data.rows.map((r) => `<tr class="click" data-sym="${esc(r.symbol)}">
        <td class="sym">${esc(r.symbol)}</td><td class="muted">${esc((r.name || '').slice(0, 32))}</td>
        <td class="num">${fmtPrice(r.price)}</td>
        <td class="num ${chgClass(r.change)}">${arrow(r.change)} ${fmtNum(Math.abs(r.change))}</td>
        <td class="num ${chgClass(r.change)}">${fmtNum(Math.abs(r.changePct))}%</td>
        <td class="num">${fmtBig(r.volume)}</td><td class="num">${fmtBig(r.marketCap)}</td>
      </tr>`).join('')}
    </table></div>`;
    wireRows(el('mv-body'));
  } catch (err) { el('mv-body').innerHTML = `<div class="err">${esc(err.message)}</div>`; }
}

/* ----------------------------------------------------------------- FX */

async function showFX() {
  state.view = 'FX'; setActiveTabs(null); markFunc(null);
  el('view').innerHTML = secBar('FX — CURRENCY RATES (ECB REFERENCE)', '') + `<div id="fx-body"><div class="loading">Loading…</div></div>`;
  try {
    const data = await api('/api/fx?base=USD');
    el('fx-body').innerHTML = `
      <div class="sec-body" style="padding-bottom:0"><span class="muted">Base <span class="hl">USD</span> · ECB reference · ${esc(data.date)}</span></div>
      <div class="tbl-wrap"><table class="data">
        <tr><th>PAIR</th><th class="num">RATE</th><th class="num">CHG</th><th class="num">CHG%</th><th class="num">INVERSE</th></tr>
        ${data.rates.map((r) => `<tr class="click" data-sym="${esc(data.base + r.ccy)}=X">
          <td class="sym">${esc(data.base)}/${esc(r.ccy)}</td>
          <td class="num">${fmtNum(r.rate, 4)}</td>
          <td class="num ${chgClass(r.change)}">${arrow(r.change)} ${fmtNum(Math.abs(r.change), 4)}</td>
          <td class="num ${chgClass(r.changePct)}">${fmtNum(r.changePct)}%</td>
          <td class="num muted">${fmtNum(1 / r.rate, 4)}</td>
        </tr>`).join('')}
      </table></div>`;
    wireRows(el('fx-body'));
  } catch (err) { el('fx-body').innerHTML = `<div class="err">${esc(err.message)}</div>`; }
}

/* -------------------------------------------------------------- crypto */

async function showCrypto() {
  state.view = 'CRYP'; setActiveTabs(null); markFunc(null);
  el('view').innerHTML = secBar('CRYP — CRYPTOCURRENCY MARKET', 'CoinGecko') + `<div id="cryp-body"><div class="loading">Loading…</div></div>`;
  try {
    const coins = await api('/api/crypto');
    el('cryp-body').innerHTML = `<div class="tbl-wrap"><table class="data">
      <tr><th>#</th><th>SYM</th><th>NAME</th><th class="num">PRICE</th><th class="num">24H%</th><th class="num">24H RANGE</th><th class="num">MKT CAP</th><th class="num">VOLUME</th></tr>
      ${coins.map((c, i) => `<tr class="click" data-sym="${esc(c.symbol)}-USD">
        <td class="muted">${i + 1}</td><td class="sym">${esc(c.symbol)}</td><td class="muted">${esc(c.name)}</td>
        <td class="num">${fmtPrice(c.price)}</td>
        <td class="num ${chgClass(c.changePct)}">${arrow(c.changePct)} ${fmtNum(Math.abs(c.changePct))}%</td>
        <td class="num muted">${fmtPrice(c.low24h)} – ${fmtPrice(c.high24h)}</td>
        <td class="num">${fmtBig(c.marketCap)}</td><td class="num">${fmtBig(c.volume)}</td>
      </tr>`).join('')}
    </table></div>`;
    wireRows(el('cryp-body'));
  } catch (err) { el('cryp-body').innerHTML = `<div class="err">${esc(err.message)}</div>`; }
}

/* ---------------------------------------------------------- watchlist */

async function showWatchlist() {
  state.view = 'W'; setActiveTabs('W'); markFunc(null);
  const add = `<span class="right">Type "W ADD AAPL" / "W DEL AAPL"</span>`;
  el('view').innerHTML = secBar('W — WATCHLIST / PORTFOLIO MONITOR', '', add) + `<div id="wl-body"><div class="loading">Loading…</div></div>`;
  if (!state.watchlist.length) { el('wl-body').innerHTML = '<div class="muted" style="padding:12px">Watchlist empty. Add with <span class="hl">W ADD NVDA</span>.</div>'; return; }
  try {
    const quotes = await api(`/api/quotes?symbols=${encodeURIComponent(state.watchlist.join(','))}`);
    el('wl-body').innerHTML = `<div class="tbl-wrap"><table class="data">
      <tr><th>SYM</th><th>NAME</th><th class="num">LAST</th><th class="num">CHG</th><th class="num">CHG%</th><th class="num">VOLUME</th><th></th></tr>
      ${quotes.map((q) => q.error
        ? `<tr><td class="sym">${esc(q.symbol)}</td><td class="neg" colspan="6">unavailable</td></tr>`
        : `<tr class="click" data-sym="${esc(q.symbol)}">
            <td class="sym">${esc(q.symbol)}</td><td class="muted">${esc((q.name || '').slice(0, 30))}</td>
            <td class="num">${fmtPrice(q.price)}</td>
            <td class="num ${chgClass(q.change)}">${arrow(q.change)} ${fmtNum(Math.abs(q.change))}</td>
            <td class="num ${chgClass(q.change)}">${fmtNum(Math.abs(q.changePct))}%</td>
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
  state.view = 'SECF'; setActiveTabs(null); markFunc(null);
  el('view').innerHTML = secBar('SECF — SECURITY FINDER', esc(query)) + `<div id="sf-body"><div class="loading">Searching…</div></div>`;
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

/* ---------------------------------------------------------------- HOME */

async function showHome() {
  state.view = 'HOME'; setActiveTabs('HOME'); markFunc(null);
  el('view').innerHTML = `
    <div class="grid-2">
      <div class="section" id="home-idx">${secBar('WEI — WORLD INDICES')}<div class="sec-body" style="padding:0"><div class="loading">Loading…</div></div></div>
      <div class="section" id="home-mov">${secBar('MOST — TOP GAINERS')}<div class="sec-body" style="padding:0"><div class="loading">Loading…</div></div></div>
    </div>
    <div class="grid-2">
      <div class="section" id="home-cmdty">${secBar('CMDTY — COMMODITIES & RATES')}<div class="sec-body" style="padding:0"><div class="loading">Loading…</div></div></div>
      <div class="section" id="home-news">${secBar('TOP — MARKET NEWS')}<div class="sec-body"><div class="loading">Loading…</div></div></div>
    </div>`;
  // world indices (headline set)
  const idxRows = [['^GSPC', 'S&P 500'], ['^IXIC', 'Nasdaq'], ['^DJI', 'Dow Jones'], ['^RUT', 'Russell 2000'],
    ['^FTSE', 'FTSE 100'], ['^GDAXI', 'DAX'], ['^N225', 'Nikkei 225'], ['^HSI', 'Hang Seng'], ['^VIX', 'VIX']];
  const cmdtyRows = [['GC=F', 'Gold'], ['SI=F', 'Silver'], ['CL=F', 'WTI Crude'], ['BZ=F', 'Brent'],
    ['NG=F', 'Nat Gas'], ['HG=F', 'Copper'], ['^TNX', 'US 10Y Yield'], ['^TYX', 'US 30Y Yield'], ['DX-Y.NYB', 'US Dollar Idx']];
  quoteBoard([...idxRows, ...cmdtyRows].map((r) => r[0])).then((byName) => {
    const idx = el('home-idx'); if (idx) { idx.querySelector('.sec-body').innerHTML = boardTable(idxRows, byName); wireRows(idx); }
    const cm = el('home-cmdty'); if (cm) { cm.querySelector('.sec-body').innerHTML = boardTable(cmdtyRows, byName); wireRows(cm); }
  }).catch(() => {});
  api('/api/movers?type=gainers').then((data) => {
    const m = el('home-mov'); if (!m) return;
    m.querySelector('.sec-body').innerHTML = `<div class="tbl-wrap"><table class="data">
      <tr><th>SYM</th><th>NAME</th><th class="num">LAST</th><th class="num">CHG%</th></tr>
      ${data.rows.slice(0, 12).map((r) => `<tr class="click" data-sym="${esc(r.symbol)}">
        <td class="sym">${esc(r.symbol)}</td><td class="muted">${esc((r.name || '').slice(0, 22))}</td>
        <td class="num">${fmtPrice(r.price)}</td><td class="num ${chgClass(r.change)}">${arrow(r.change)} ${fmtNum(Math.abs(r.changePct))}%</td>
      </tr>`).join('')}</table></div>`;
    wireRows(m);
  }).catch(() => {});
  api('/api/news?symbol=SPY').then((data) => {
    const nw = el('home-news'); if (nw) nw.querySelector('.sec-body').innerHTML = newsHTML(data.items, 12);
  }).catch(() => {});
}

/* ---------------------------------------------------------------- HELP */

function showHelp() {
  state.view = 'HELP'; setActiveTabs(null); markFunc(null);
  el('view').innerHTML = secBar('HELP — TERMINAL GUIDE', '') + `<div class="help-body">
    <h2>OPENTERM</h2>
    <p>A Bloomberg-style market terminal. Type a command in the amber line and press <span class="ex">GO</span> (Enter). Commands are <b>SECURITY</b> then <b>FUNCTION</b>, just like a Bloomberg &lt;GO&gt; string.</p>
    <div class="sec-bar" style="position:static;margin:8px 0 4px">SECURITY FUNCTIONS</div>
    <div class="tbl-wrap"><table class="data">
      <tr><th>COMMAND</th><th>FUNCTION</th></tr>
      <tr><td>AAPL</td><td>Load a security (opens the price graph)</td></tr>
      <tr><td>AAPL DES</td><td>Description — profile, identification, market data</td></tr>
      <tr><td>AAPL GP</td><td>Price graph — candles/line, 1D → MAX, crosshair OHLC</td></tr>
      <tr><td>AAPL GIP</td><td>Intraday price graph</td></tr>
      <tr><td>AAPL FA</td><td>Fundamentals — valuation, margins, balance sheet, analyst targets</td></tr>
      <tr><td>AAPL ERN</td><td>Earnings — quarterly surprise, annual revenue/earnings</td></tr>
      <tr><td>AAPL CN</td><td>Company news</td></tr>
    </table></div>
    <div class="sec-bar" style="position:static;margin:8px 0 4px">MARKET MONITORS</div>
    <div class="tbl-wrap"><table class="data">
      <tr><th>COMMAND</th><th>FUNCTION</th></tr>
      <tr><td>HOME</td><td>Market overview dashboard</td></tr>
      <tr><td>WEI</td><td>World equity indices (Americas / EMEA / Asia-Pac)</td></tr>
      <tr><td>MOST</td><td>Market movers — gainers, losers, most active</td></tr>
      <tr><td>CMDTY</td><td>Commodities — energy, metals, agriculture</td></tr>
      <tr><td>GOVT</td><td>US Treasury yields & futures</td></tr>
      <tr><td>FX</td><td>Currency rates (ECB reference)</td></tr>
      <tr><td>CRYP</td><td>Cryptocurrency market</td></tr>
      <tr><td>TOP</td><td>Top market news</td></tr>
      <tr><td>W</td><td>Watchlist — <span class="ex">W ADD NVDA</span> / <span class="ex">W DEL NVDA</span></td></tr>
      <tr><td>S apple</td><td>Security finder (search by name or ticker)</td></tr>
      <tr><td>HELP</td><td>This screen</td></tr>
    </table></div>
    <p class="note">Symbols use Yahoo conventions: indices <span class="ex">^GSPC</span>, FX <span class="ex">EURUSD=X</span>, futures <span class="ex">GC=F</span>, crypto <span class="ex">BTC-USD</span>, non-US <span class="ex">BMW.DE</span>, <span class="ex">7203.T</span>.</p>
    <p class="note">Data: Yahoo Finance (quotes, charts, fundamentals, movers), CoinGecko (crypto), ECB via Frankfurter (FX), optional Finnhub key for richer news/profiles. Free-tier data is delayed — for information only, not investment advice.</p>
  </div>`;
}

/* ----------------------------------------------------------- commands */

function runCommand(raw) {
  const input = raw.trim().toUpperCase();
  if (!input) return;
  msg('');
  const [head, ...rest] = input.split(/\s+/);

  const topLevel = {
    HOME: showHome, WEI: showWEI, MOST: showMovers, MOV: showMovers, MOVERS: showMovers,
    CMDTY: showCommodities, COMD: showCommodities, GOVT: showRates, RATES: showRates, YCRV: showRates,
    FX: showFX, WCRS: showFX, CRYP: showCrypto, CRYPTO: showCrypto, TOP: showTopNews,
    HELP: showHelp, MENU: showHelp, '?': showHelp,
  };
  if (topLevel[head] && !rest.length) return topLevel[head]();
  if (head === 'MOST' || head === 'MOV' || head === 'MOVERS') return showMovers(rest[0]?.toLowerCase());

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
  const secFns = ['DES', 'GP', 'GIP', 'FA', 'ERN', 'CN', 'N'];
  if (secFns.includes(head) && !rest.length) {
    if (!state.symbol) return msg('Load a security first — e.g. AAPL', true);
    return runFunc(head === 'N' ? 'CN' : head);
  }

  // SYMBOL [FUNCTION]
  const fn = secFns.includes(rest[0]) ? (rest[0] === 'N' ? 'CN' : rest[0]) : 'GP';
  return loadSecurity(head, fn);
}

/* ------------------------------------------------------- autocomplete */

let acTimer, acItems = [], acSel = -1;
const KNOWN = new Set(['HOME', 'WEI', 'MOST', 'MOV', 'MOVERS', 'CMDTY', 'GOVT', 'RATES', 'FX', 'CRYP', 'CRYPTO', 'TOP', 'HELP', 'MENU', 'W', 'WL', 'PORT', 'S', 'SECF', 'DES', 'GP', 'GIP', 'FA', 'ERN', 'CN', 'N']);

function hideAC() { el('autocomplete').classList.add('hidden'); acItems = []; acSel = -1; }
function renderAC() {
  const box = el('autocomplete');
  if (!acItems.length) return hideAC();
  box.innerHTML = acItems.map((q, i) => `<div class="ac-row ${i === acSel ? 'sel' : ''}" data-sym="${esc(q.symbol)}">
    <span class="ac-sym">${esc(q.symbol)}</span><span class="ac-name">${esc(q.name)}</span><span class="ac-exch">${esc(q.exchange || '')}</span></div>`).join('');
  box.classList.remove('hidden');
  box.querySelectorAll('.ac-row').forEach((r) => r.addEventListener('mousedown', (e) => {
    e.preventDefault(); hideAC(); el('cmd').value = ''; loadSecurity(r.dataset.sym, 'GP');
  }));
}
function onCmdInput() {
  const v = el('cmd').value.trim();
  clearTimeout(acTimer);
  if (!v || /\s/.test(v) || KNOWN.has(v.toUpperCase())) return hideAC();
  acTimer = setTimeout(async () => {
    try { const d = await api(`/api/search?q=${encodeURIComponent(v)}`); acItems = d.quotes.slice(0, 8); acSel = -1; renderAC(); }
    catch { hideAC(); }
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
        <span class="t-px">${fmtPrice(q.price)}</span><span class="${chgClass(q.change)}">${arrow(q.change)}${fmtNum(Math.abs(q.changePct))}%</span></span>`;
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
  ['HOME', 'Home', 'k-orange'], ['WEI', 'World Idx', 'k-yellow'], ['MOST', 'Movers', 'k-yellow'],
  ['CMDTY', 'Cmdty', 'k-yellow'], ['GOVT', 'Rates', 'k-yellow'], ['FX', 'FX', 'k-yellow'],
  ['CRYP', 'Crypto', 'k-yellow'], ['TOP', 'News', 'k-blue'], ['DES', 'Desc', 'k-cyan'],
  ['GP', 'Graph', 'k-green'], ['FA', 'Fundmtls', 'k-cyan'], ['ERN', 'Earnings', 'k-cyan'],
  ['W', 'Watchlist', 'k-orange'], ['HELP', 'Help', 'k-blue'],
];
function buildKeybar() {
  el('keybar').innerHTML = KEYS.map(([cmd, label, cls]) =>
    `<button class="fkey ${cls}" data-cmd="${cmd}">${cmd}<small>${label}</small></button>`).join('');
  el('keybar').querySelectorAll('.fkey').forEach((b) => b.addEventListener('click', () => runCommand(b.dataset.cmd)));
}

/* --------------------------------------------------------------- init */

function init() {
  buildKeybar();
  showHome();
  refreshTape();
  loadTicker();
  tickClock();

  setInterval(tickClock, 1000);
  setInterval(refreshTape, 30_000);
  setInterval(refreshSecQuote, 15_000);
  setInterval(() => { if (state.view === 'HOME') showHome(); }, 60_000);
  setInterval(loadTicker, 300_000);

  document.querySelectorAll('.top-tab, #help-btn').forEach((b) =>
    b.addEventListener('click', () => runCommand(b.dataset.cmd)));

  const cmd = el('cmd');
  cmd.addEventListener('input', onCmdInput);
  cmd.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && acItems.length) { e.preventDefault(); acSel = (acSel + 1) % acItems.length; renderAC(); }
    else if (e.key === 'ArrowUp' && acItems.length) { e.preventDefault(); acSel = (acSel - 1 + acItems.length) % acItems.length; renderAC(); }
    else if (e.key === 'Escape') hideAC();
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (acSel >= 0 && acItems[acSel]) { const s = acItems[acSel].symbol; hideAC(); cmd.value = ''; loadSecurity(s, 'GP'); }
      else { hideAC(); const v = cmd.value; cmd.value = ''; runCommand(v); }
    }
  });
  cmd.addEventListener('blur', () => setTimeout(hideAC, 150));
  el('go-btn').addEventListener('click', () => { const v = cmd.value; cmd.value = ''; hideAC(); runCommand(v); cmd.focus(); });

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
