/* OpenTerm frontend — command-driven market terminal */
'use strict';

/* ------------------------------------------------------------ helpers */

const $ = (sel) => document.querySelector(sel);

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
  const dp = Math.abs(x) >= 1000 ? 2 : Math.abs(x) >= 1 ? 2 : 4;
  return fmtNum(x, dp);
}

function fmtBig(x) {
  if (x == null) return '—';
  const abs = Math.abs(x);
  if (abs >= 1e12) return fmtNum(x / 1e12) + 'T';
  if (abs >= 1e9) return fmtNum(x / 1e9) + 'B';
  if (abs >= 1e6) return fmtNum(x / 1e6) + 'M';
  if (abs >= 1e3) return fmtNum(x / 1e3) + 'K';
  return fmtNum(x, 0);
}

function chgClass(x) { return x > 0 ? 'pos' : x < 0 ? 'neg' : 'flat'; }
function arrow(x) { return x > 0 ? '▲' : x < 0 ? '▼' : '—'; }

function fmtChange(chg, pct) {
  return `${arrow(chg)} ${fmtNum(Math.abs(chg))} (${fmtNum(Math.abs(pct))}%)`;
}

function timeAgo(unixSec) {
  if (!unixSec) return '';
  const s = Math.max(0, Date.now() / 1000 - unixSec);
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* -------------------------------------------------------------- state */

const state = {
  symbol: null,
  quote: null,
  screen: 'help',
  range: '6mo',
  chartType: 'candle',
  candles: [],
  watchlist: JSON.parse(localStorage.getItem('openterm.watchlist') || 'null')
    || ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'SPY'],
};

const TAPE_SYMBOLS = [
  { sym: '^GSPC', label: 'S&P500' },
  { sym: '^IXIC', label: 'NASDAQ' },
  { sym: '^DJI', label: 'DOW' },
  { sym: '^VIX', label: 'VIX' },
  { sym: '^TNX', label: 'US10Y' },
  { sym: 'GC=F', label: 'GOLD' },
  { sym: 'CL=F', label: 'WTI' },
  { sym: 'BTC-USD', label: 'BTC' },
  { sym: 'EURUSD=X', label: 'EURUSD' },
];

function saveWatchlist() {
  localStorage.setItem('openterm.watchlist', JSON.stringify(state.watchlist));
}

/* ----------------------------------------------------------- messages */

function msg(text, isError = false) {
  const el = $('#cmd-msg');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

/* ------------------------------------------------------------ screens */

const SCREENS = ['help', 'chart', 'des', 'news', 'fx', 'cryp', 'search'];
const SCREEN_TITLES = {
  help: 'HELP — TERMINAL GUIDE',
  chart: 'GP — PRICE GRAPH',
  des: 'DES — SECURITY DESCRIPTION',
  news: 'N — COMPANY NEWS',
  fx: 'FX — CURRENCY RATES (ECB REF)',
  cryp: 'CRYP — CRYPTOCURRENCY MARKET',
  search: 'SECF — SECURITY FINDER',
};

function showScreen(name) {
  state.screen = name;
  for (const s of SCREENS) $(`#screen-${s}`).classList.toggle('hidden', s !== name);
  const sym = state.symbol ? `${state.symbol} ` : '';
  const perSecurity = ['chart', 'des', 'news'].includes(name);
  $('#main-title').textContent = (perSecurity ? sym : '') + SCREEN_TITLES[name];
  if (name === 'chart') resizeChart();
}

/* ----------------------------------------------------------- security */

async function loadSecurity(symbol, func = 'GP') {
  msg(`Loading ${symbol}…`);
  try {
    const quote = await api(`/api/quote/${encodeURIComponent(symbol)}`);
    state.symbol = quote.symbol;
    state.quote = quote;
    renderHeader(quote);
    msg(`${quote.symbol} loaded — ${quote.name}`);
    if (func === 'DES') await showDES();
    else if (func === 'N') await showNews();
    else await showChart();
    refreshMiniNews();
  } catch (err) {
    msg(`${symbol}: ${err.message}`, true);
  }
}

function renderHeader(q) {
  $('#sec-header').classList.remove('hidden');
  $('#sec-symbol').textContent = q.symbol;
  $('#sec-name').textContent = q.name || '';
  $('#sec-exch').textContent = [q.exchange, q.currency].filter(Boolean).join(' · ');
  $('#sec-price').textContent = fmtPrice(q.price);
  $('#sec-price').className = chgClass(q.change);
  $('#sec-change').textContent = fmtChange(q.change, q.changePct);
  $('#sec-change').className = chgClass(q.change);
  $('#sec-time').textContent = q.marketTime
    ? `as of ${new Date(q.marketTime * 1000).toLocaleString()} · ${q.timezone}` : '';
}

async function refreshQuote() {
  if (!state.symbol) return;
  try {
    const q = await api(`/api/quote/${encodeURIComponent(state.symbol)}`);
    state.quote = q;
    renderHeader(q);
  } catch { /* transient — keep last quote */ }
}

/* -------------------------------------------------------------- chart */

const chartEl = $('#chart');
const ctx = chartEl.getContext('2d');
let hoverIdx = -1;

const RANGE_LABELS = [
  ['1d', '1D'], ['5d', '5D'], ['1mo', '1M'], ['3mo', '3M'],
  ['6mo', '6M'], ['1y', '1Y'], ['5y', '5Y'], ['max', 'MAX'],
];

function buildChartToolbar() {
  const wrap = $('.range-btns');
  wrap.innerHTML = RANGE_LABELS.map(([r, label]) =>
    `<button class="tb-btn range-btn" data-range="${r}">${label}</button>`).join('');
  wrap.querySelectorAll('.range-btn').forEach((b) => {
    b.addEventListener('click', () => { state.range = b.dataset.range; showChart(); });
  });
  document.querySelectorAll('.type-btn').forEach((b) => {
    b.addEventListener('click', () => { state.chartType = b.dataset.type; syncToolbar(); drawChart(); });
  });
  syncToolbar();
}

function syncToolbar() {
  document.querySelectorAll('.range-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.range === state.range));
  document.querySelectorAll('.type-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.type === state.chartType));
}

async function showChart() {
  if (!state.symbol) { msg('Load a security first — e.g. AAPL <GO>', true); return; }
  showScreen('chart');
  syncToolbar();
  try {
    const data = await api(`/api/history/${encodeURIComponent(state.symbol)}?range=${state.range}`);
    state.candles = data.candles;
    hoverIdx = -1;
    drawChart();
  } catch (err) {
    msg(`chart: ${err.message}`, true);
  }
}

function resizeChart() {
  const wrap = $('#chart-wrap');
  if (!wrap || wrap.clientWidth === 0) return;
  const dpr = window.devicePixelRatio || 1;
  chartEl.width = Math.floor(wrap.clientWidth * dpr);
  chartEl.height = Math.floor(wrap.clientHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawChart();
}

function xTimeLabel(t, intraday) {
  const d = new Date(t * 1000);
  return intraday
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: '2-digit' });
}

function drawChart() {
  const candles = state.candles;
  const W = chartEl.width / (window.devicePixelRatio || 1);
  const H = chartEl.height / (window.devicePixelRatio || 1);
  if (!W || !H) return;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#050505';
  ctx.fillRect(0, 0, W, H);
  if (!candles.length) return;

  const M = { top: 12, right: 62, bottom: 22, left: 8 };
  const volH = Math.floor((H - M.top - M.bottom) * 0.16);
  const priceH = H - M.top - M.bottom - volH - 6;
  const plotW = W - M.left - M.right;
  const n = candles.length;

  let lo = Infinity, hi = -Infinity, maxV = 0;
  for (const c of candles) {
    if (c.l < lo) lo = c.l;
    if (c.h > hi) hi = c.h;
    if (c.v > maxV) maxV = c.v;
  }
  const pad = (hi - lo) * 0.05 || hi * 0.01 || 1;
  lo -= pad; hi += pad;

  const xAt = (i) => M.left + ((i + 0.5) / n) * plotW;
  const yAt = (p) => M.top + (1 - (p - lo) / (hi - lo)) * priceH;
  const volTop = M.top + priceH + 6;

  // horizontal gridlines + right axis labels
  ctx.font = '10px monospace';
  ctx.textBaseline = 'middle';
  const gridN = 6;
  for (let g = 0; g <= gridN; g++) {
    const p = lo + ((hi - lo) * g) / gridN;
    const y = yAt(p);
    ctx.strokeStyle = '#1a1a1a';
    ctx.beginPath(); ctx.moveTo(M.left, y); ctx.lineTo(W - M.right, y); ctx.stroke();
    ctx.fillStyle = '#8a8a8a';
    ctx.textAlign = 'left';
    ctx.fillText(fmtPrice(p), W - M.right + 6, y);
  }

  // x labels
  const intraday = ['1d', '5d'].includes(state.range);
  const ticks = Math.max(2, Math.floor(plotW / 110));
  ctx.fillStyle = '#8a8a8a';
  ctx.textAlign = 'center';
  for (let g = 0; g <= ticks; g++) {
    const i = Math.min(n - 1, Math.round((g / ticks) * (n - 1)));
    ctx.fillText(xTimeLabel(candles[i].t, intraday), xAt(i), H - M.bottom / 2);
  }

  // volume bars
  const bw = Math.max(1, (plotW / n) * 0.7);
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    const h = maxV ? (c.v / maxV) * volH : 0;
    ctx.fillStyle = c.c >= c.o ? 'rgba(0,210,106,0.35)' : 'rgba(255,59,59,0.35)';
    ctx.fillRect(xAt(i) - bw / 2, volTop + volH - h, bw, h);
  }

  // price series
  if (state.chartType === 'line' || n > 260) {
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = xAt(i), y = yAt(candles[i].c);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#ff9900';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    // area fade under the line
    ctx.lineTo(xAt(n - 1), M.top + priceH);
    ctx.lineTo(xAt(0), M.top + priceH);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, M.top, 0, M.top + priceH);
    grad.addColorStop(0, 'rgba(255,153,0,0.18)');
    grad.addColorStop(1, 'rgba(255,153,0,0)');
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.lineWidth = 1;
  } else {
    for (let i = 0; i < n; i++) {
      const c = candles[i];
      const x = xAt(i);
      const up = c.c >= c.o;
      ctx.strokeStyle = ctx.fillStyle = up ? '#00d26a' : '#ff3b3b';
      ctx.beginPath(); ctx.moveTo(x, yAt(c.h)); ctx.lineTo(x, yAt(c.l)); ctx.stroke();
      const top = yAt(Math.max(c.o, c.c));
      const bodyH = Math.max(1, Math.abs(yAt(c.o) - yAt(c.c)));
      ctx.fillRect(x - bw / 2, top, bw, bodyH);
    }
  }

  // previous-close reference line
  if (state.quote?.prevClose && state.quote.prevClose > lo && state.quote.prevClose < hi) {
    const y = yAt(state.quote.prevClose);
    ctx.strokeStyle = '#555';
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(M.left, y); ctx.lineTo(W - M.right, y); ctx.stroke();
    ctx.setLineDash([]);
  }

  // crosshair
  if (hoverIdx >= 0 && hoverIdx < n) {
    const c = candles[hoverIdx];
    const x = xAt(hoverIdx), y = yAt(c.c);
    ctx.strokeStyle = 'rgba(255,153,0,0.55)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, M.top); ctx.lineTo(x, volTop + volH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(M.left, y); ctx.lineTo(W - M.right, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#ff9900';
    ctx.textAlign = 'left';
    ctx.fillText(fmtPrice(c.c), W - M.right + 6, y);
    $('#chart-legend').innerHTML =
      `${esc(xTimeLabel(c.t, intraday))}  ` +
      `O:<span class="flat">${fmtPrice(c.o)}</span> H:<span class="pos">${fmtPrice(c.h)}</span> ` +
      `L:<span class="neg">${fmtPrice(c.l)}</span> C:<span class="${chgClass(c.c - c.o)}">${fmtPrice(c.c)}</span> ` +
      `VOL:${fmtBig(c.v)}`;
  } else {
    const first = candles[0], last = candles[n - 1];
    const chg = last.c - first.c;
    const pct = first.c ? (chg / first.c) * 100 : 0;
    $('#chart-legend').innerHTML =
      `${esc(state.symbol || '')} ${esc(state.range.toUpperCase())} ` +
      `range chg: <span class="${chgClass(chg)}">${fmtChange(chg, pct)}</span>  ` +
      `HI:${fmtPrice(Math.max(...candles.map((c) => c.h)))} LO:${fmtPrice(Math.min(...candles.map((c) => c.l)))}`;
  }
}

chartEl.addEventListener('mousemove', (e) => {
  if (!state.candles.length) return;
  const rect = chartEl.getBoundingClientRect();
  const M = { left: 8, right: 62 };
  const plotW = rect.width - M.left - M.right;
  const i = Math.round(((e.clientX - rect.left - M.left) / plotW) * state.candles.length - 0.5);
  hoverIdx = Math.max(0, Math.min(state.candles.length - 1, i));
  drawChart();
});
chartEl.addEventListener('mouseleave', () => { hoverIdx = -1; drawChart(); });
window.addEventListener('resize', () => { if (state.screen === 'chart') resizeChart(); });

/* ---------------------------------------------------------------- DES */

async function showDES() {
  if (!state.symbol) { msg('Load a security first — e.g. AAPL DES', true); return; }
  showScreen('des');
  const el = $('#screen-des');
  el.innerHTML = '<div class="flat">Loading…</div>';
  try {
    const [q, p] = await Promise.all([
      api(`/api/quote/${encodeURIComponent(state.symbol)}`),
      api(`/api/profile/${encodeURIComponent(state.symbol)}`).catch(() => ({})),
    ]);
    const row = (k, v) => `<div class="des-row"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`;
    const pctOff52 = q.high52w ? ((q.price - q.high52w) / q.high52w) * 100 : null;
    el.innerHTML = `
      <div class="des-heading">IDENTIFICATION</div>
      <div class="des-grid">
        ${row('Name', esc(p.name || q.name))}
        ${row('Symbol', esc(q.symbol))}
        ${row('Type', esc(q.type || '—'))}
        ${row('Exchange', esc(p.exchange || q.exchange || '—'))}
        ${row('Sector', esc(p.sector || '—'))}
        ${row('Industry', esc(p.industry || '—'))}
        ${row('Country', esc(p.country || '—'))}
        ${row('Currency', esc(q.currency || p.currency || '—'))}
        ${p.ipo ? row('IPO Date', esc(p.ipo)) : ''}
        ${p.web ? row('Website', `<a href="${esc(p.web)}" target="_blank" rel="noopener" style="color:var(--cyan)">${esc(p.web.replace(/^https?:\/\//, ''))}</a>`) : ''}
      </div>
      <div class="des-heading">PRICE DATA</div>
      <div class="des-grid">
        ${row('Last Price', fmtPrice(q.price))}
        ${row('Change', `<span class="${chgClass(q.change)}">${fmtChange(q.change, q.changePct)}</span>`)}
        ${row('Prev Close', fmtPrice(q.prevClose))}
        ${row('Open', fmtPrice(q.open))}
        ${row('Day Range', `${fmtPrice(q.dayLow)} – ${fmtPrice(q.dayHigh)}`)}
        ${row('52W Range', `${fmtPrice(q.low52w)} – ${fmtPrice(q.high52w)}`)}
        ${pctOff52 != null ? row('% Off 52W High', `<span class="${chgClass(pctOff52)}">${fmtNum(pctOff52)}%</span>`) : ''}
        ${row('Volume', fmtBig(q.volume))}
        ${p.marketCap ? row('Market Cap', fmtBig(p.marketCap)) : ''}
        ${p.sharesOut ? row('Shares Out', fmtBig(p.sharesOut)) : ''}
      </div>`;
  } catch (err) {
    el.innerHTML = `<div class="neg">DES failed: ${esc(err.message)}</div>`;
  }
}

/* --------------------------------------------------------------- news */

function newsHTML(items, limit = 30) {
  if (!items.length) return '<div class="flat" style="padding:8px">No stories found.</div>';
  return items.slice(0, limit).map((n) => `
    <div class="news-item">
      <a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a>
      <div class="news-meta"><span class="src">${esc(n.source || '')}</span> · ${timeAgo(n.time)}</div>
    </div>`).join('');
}

async function showNews() {
  if (!state.symbol) { msg('Load a security first — e.g. TSLA N', true); return; }
  showScreen('news');
  const el = $('#screen-news');
  el.innerHTML = '<div class="flat">Loading…</div>';
  try {
    const data = await api(`/api/news?symbol=${encodeURIComponent(state.symbol)}`);
    el.innerHTML = newsHTML(data.items);
  } catch (err) {
    el.innerHTML = `<div class="neg">news failed: ${esc(err.message)}</div>`;
  }
}

async function refreshMiniNews() {
  const el = $('#mini-news');
  try {
    const data = await api(`/api/news?symbol=${encodeURIComponent(state.symbol || 'SPY')}`);
    el.innerHTML = newsHTML(data.items, 8);
  } catch { el.innerHTML = '<div class="flat" style="padding:8px">news unavailable</div>'; }
}

/* ----------------------------------------------------------------- FX */

async function showFX() {
  showScreen('fx');
  const el = $('#screen-fx');
  el.innerHTML = '<div class="flat">Loading…</div>';
  try {
    const data = await api('/api/fx?base=USD');
    el.innerHTML = `
      <div class="flat" style="margin-bottom:4px">Base: <span class="pos">USD</span> · ECB reference rates · ${esc(data.date)}</div>
      <table class="data">
        <tr><th>PAIR</th><th class="num">RATE</th><th class="num">CHG</th><th class="num">CHG%</th></tr>
        ${data.rates.map((r) => `
          <tr class="click" data-sym="${esc(data.base + r.ccy)}=X">
            <td style="color:var(--amber);font-weight:bold">${esc(data.base)}/${esc(r.ccy)}</td>
            <td class="num">${fmtNum(r.rate, 4)}</td>
            <td class="num ${chgClass(r.change)}">${arrow(r.change)} ${fmtNum(Math.abs(r.change), 4)}</td>
            <td class="num ${chgClass(r.changePct)}">${fmtNum(r.changePct)}%</td>
          </tr>`).join('')}
      </table>
      <div class="flat" style="margin-top:6px;font-size:11px">Click a pair for its chart (Yahoo intraday data).</div>`;
    el.querySelectorAll('tr.click').forEach((tr) =>
      tr.addEventListener('click', () => loadSecurity(tr.dataset.sym, 'GP')));
  } catch (err) {
    el.innerHTML = `<div class="neg">FX failed: ${esc(err.message)}</div>`;
  }
}

/* -------------------------------------------------------------- crypto */

async function showCrypto() {
  showScreen('cryp');
  const el = $('#screen-cryp');
  el.innerHTML = '<div class="flat">Loading…</div>';
  try {
    const coins = await api('/api/crypto');
    el.innerHTML = `
      <table class="data">
        <tr><th>#</th><th>NAME</th><th class="num">PRICE</th><th class="num">24H%</th>
            <th class="num">24H RANGE</th><th class="num">MKT CAP</th><th class="num">VOLUME</th></tr>
        ${coins.map((c, i) => `
          <tr class="click" data-sym="${esc(c.symbol)}-USD">
            <td class="flat">${i + 1}</td>
            <td><span style="color:var(--amber);font-weight:bold">${esc(c.symbol)}</span> <span class="flat">${esc(c.name)}</span></td>
            <td class="num">${fmtPrice(c.price)}</td>
            <td class="num ${chgClass(c.changePct)}">${arrow(c.changePct)} ${fmtNum(Math.abs(c.changePct))}%</td>
            <td class="num flat">${fmtPrice(c.low24h)} – ${fmtPrice(c.high24h)}</td>
            <td class="num">${fmtBig(c.marketCap)}</td>
            <td class="num">${fmtBig(c.volume)}</td>
          </tr>`).join('')}
      </table>
      <div class="flat" style="margin-top:6px;font-size:11px">Source: CoinGecko · click a row for its chart.</div>`;
    el.querySelectorAll('tr.click').forEach((tr) =>
      tr.addEventListener('click', () => loadSecurity(tr.dataset.sym, 'GP')));
  } catch (err) {
    el.innerHTML = `<div class="neg">CRYP failed: ${esc(err.message)}</div>`;
  }
}

/* -------------------------------------------------------------- search */

async function showSearch(query) {
  showScreen('search');
  const el = $('#screen-search');
  el.innerHTML = '<div class="flat">Searching…</div>';
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(query)}`);
    if (!data.quotes.length) { el.innerHTML = `<div class="flat">No matches for "${esc(query)}".</div>`; return; }
    el.innerHTML = `
      <table class="data">
        <tr><th>SYMBOL</th><th>NAME</th><th>TYPE</th><th>EXCHANGE</th><th>SECTOR</th></tr>
        ${data.quotes.map((q) => `
          <tr class="click" data-sym="${esc(q.symbol)}">
            <td style="color:var(--amber);font-weight:bold">${esc(q.symbol)}</td>
            <td>${esc(q.name)}</td><td class="flat">${esc(q.type)}</td>
            <td class="flat">${esc(q.exchange)}</td><td class="flat">${esc(q.sector)}</td>
          </tr>`).join('')}
      </table>
      <div class="flat" style="margin-top:6px;font-size:11px">Click a row to load the security.</div>`;
    el.querySelectorAll('tr.click').forEach((tr) =>
      tr.addEventListener('click', () => loadSecurity(tr.dataset.sym, 'GP')));
  } catch (err) {
    el.innerHTML = `<div class="neg">search failed: ${esc(err.message)}</div>`;
  }
}

/* ---------------------------------------------------------- watchlist */

async function refreshWatchlist() {
  const el = $('#watchlist');
  if (!state.watchlist.length) {
    el.innerHTML = '<div class="wl-empty">Watchlist empty.<br>Add with: W ADD AAPL</div>';
    return;
  }
  try {
    const quotes = await api(`/api/quotes?symbols=${encodeURIComponent(state.watchlist.join(','))}`);
    el.innerHTML = quotes.map((q) => q.error
      ? `<div class="wl-row"><span class="wl-sym">${esc(q.symbol)}</span><span class="wl-name neg">error</span><span></span><span></span></div>`
      : `<div class="wl-row" data-sym="${esc(q.symbol)}">
           <span class="wl-sym">${esc(q.symbol)}</span>
           <span class="wl-name">${esc(q.name)}</span>
           <span class="wl-px ${chgClass(q.change)}">${fmtPrice(q.price)}</span>
           <span class="wl-chg ${chgClass(q.change)}">${arrow(q.change)}${fmtNum(Math.abs(q.changePct))}%</span>
         </div>`).join('');
    el.querySelectorAll('.wl-row[data-sym]').forEach((row) =>
      row.addEventListener('click', () => loadSecurity(row.dataset.sym, 'GP')));
  } catch {
    el.innerHTML = '<div class="wl-empty">quotes unavailable</div>';
  }
}

/* --------------------------------------------------------------- tape */

async function refreshTape() {
  const el = $('#tape');
  try {
    const quotes = await api(`/api/quotes?symbols=${encodeURIComponent(TAPE_SYMBOLS.map((t) => t.sym).join(','))}`);
    el.innerHTML = quotes.map((q, i) => {
      if (q.error) return '';
      const label = TAPE_SYMBOLS[i].label;
      return `<span class="tape-item" data-sym="${esc(q.symbol)}">
        <span class="t-sym">${esc(label)}</span>
        <span class="t-px">${fmtPrice(q.price)}</span>
        <span class="${chgClass(q.change)}">${arrow(q.change)}${fmtNum(Math.abs(q.changePct))}%</span>
      </span>`;
    }).join('');
    el.querySelectorAll('.tape-item').forEach((it) =>
      it.addEventListener('click', () => loadSecurity(it.dataset.sym, 'GP')));
  } catch { /* leave previous tape */ }
}

/* --------------------------------------------------------------- help */

function showHelp() {
  showScreen('help');
  $('#screen-help').innerHTML = `
    <h2>OPENTERM — MARKET TERMINAL</h2>
    <p>Type a command in the amber bar and press <span class="cmd-ex">ENTER</span> (that's your &lt;GO&gt; key).</p>
    <br>
    <table class="data">
      <tr><th>COMMAND</th><th>ACTION</th></tr>
      <tr><td>AAPL</td><td>Load a security (defaults to the price graph)</td></tr>
      <tr><td>AAPL GP</td><td>Price graph — candles/line, ranges 1D → MAX</td></tr>
      <tr><td>AAPL DES</td><td>Security description &amp; key price data</td></tr>
      <tr><td>AAPL N</td><td>Company news headlines</td></tr>
      <tr><td>GP / DES / N</td><td>Switch function for the loaded security</td></tr>
      <tr><td>FX</td><td>Currency board (ECB reference rates)</td></tr>
      <tr><td>CRYP</td><td>Top-20 crypto market board</td></tr>
      <tr><td>S APPLE</td><td>Security finder — search by name or ticker</td></tr>
      <tr><td>W</td><td>Show/refresh watchlist</td></tr>
      <tr><td>W ADD NVDA</td><td>Add a symbol to the watchlist</td></tr>
      <tr><td>W DEL NVDA</td><td>Remove a symbol from the watchlist</td></tr>
      <tr><td>HELP</td><td>This screen</td></tr>
    </table>
    <p class="note">Symbols follow Yahoo conventions: indices <span class="cmd-ex">^GSPC</span>,
      FX <span class="cmd-ex">EURUSD=X</span>, futures <span class="cmd-ex">GC=F</span>,
      crypto <span class="cmd-ex">BTC-USD</span>, non-US listings <span class="cmd-ex">BMW.DE</span>, <span class="cmd-ex">7203.T</span>.</p>
    <p class="note">Data: Yahoo Finance (quotes/charts/search), CoinGecko (crypto), ECB via Frankfurter (FX),
      optional Finnhub key for richer news &amp; profiles. Free-tier data — delayed, for information only, not investment advice.</p>`;
}

/* ----------------------------------------------------------- commands */

async function runCommand(raw) {
  const input = raw.trim().toUpperCase();
  if (!input) return;
  msg('');
  const parts = input.split(/\s+/);
  const [head, ...rest] = parts;

  if (head === 'HELP' || head === '?') return showHelp();
  if (head === 'FX') return showFX();
  if (head === 'CRYP' || head === 'CRYPTO') return showCrypto();
  if (head === 'S' || head === 'SECF' || head === 'SEARCH') {
    const q = rest.join(' ');
    if (!q) return msg('Usage: S <name or ticker>', true);
    return showSearch(q);
  }
  if (head === 'W' || head === 'WL') {
    const op = rest[0];
    if (op === 'ADD' && rest[1]) {
      const sym = rest[1];
      if (!state.watchlist.includes(sym)) { state.watchlist.push(sym); saveWatchlist(); }
      msg(`${sym} added to watchlist`);
      return refreshWatchlist();
    }
    if ((op === 'DEL' || op === 'RM' || op === 'REMOVE') && rest[1]) {
      state.watchlist = state.watchlist.filter((s) => s !== rest[1]);
      saveWatchlist();
      msg(`${rest[1]} removed from watchlist`);
      return refreshWatchlist();
    }
    msg('Watchlist refreshed — W ADD <SYM> / W DEL <SYM>');
    return refreshWatchlist();
  }

  // bare function keys act on the loaded security
  if (head === 'GP') return showChart();
  if (head === 'DES') return showDES();
  if (head === 'N' || head === 'CN') return showNews();

  // otherwise: SYMBOL [FUNCTION]
  const func = ['GP', 'DES', 'N', 'CN'].includes(rest[0]) ? (rest[0] === 'CN' ? 'N' : rest[0]) : 'GP';
  return loadSecurity(head, func);
}

/* ------------------------------------------------------- autocomplete */

let acTimer = null;
let acItems = [];
let acSel = -1;

function hideAC() { $('#autocomplete').classList.add('hidden'); acItems = []; acSel = -1; }

function renderAC() {
  const el = $('#autocomplete');
  if (!acItems.length) return hideAC();
  el.innerHTML = acItems.map((q, i) => `
    <div class="ac-row ${i === acSel ? 'sel' : ''}" data-sym="${esc(q.symbol)}">
      <span class="ac-sym">${esc(q.symbol)}</span>
      <span class="ac-name">${esc(q.name)}</span>
      <span class="ac-exch">${esc(q.exchange || '')}</span>
    </div>`).join('');
  el.classList.remove('hidden');
  el.querySelectorAll('.ac-row').forEach((row) =>
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      hideAC();
      $('#cmd').value = '';
      loadSecurity(row.dataset.sym, 'GP');
    }));
}

function onCmdInput() {
  const val = $('#cmd').value.trim();
  clearTimeout(acTimer);
  // only autocomplete a single bare token that isn't a known command
  if (!val || /\s/.test(val) || ['FX', 'CRYP', 'HELP', 'W', 'GP', 'DES', 'N', 'S'].includes(val.toUpperCase())) {
    return hideAC();
  }
  acTimer = setTimeout(async () => {
    try {
      const data = await api(`/api/search?q=${encodeURIComponent(val)}`);
      acItems = data.quotes.slice(0, 8);
      acSel = -1;
      renderAC();
    } catch { hideAC(); }
  }, 220);
}

/* -------------------------------------------------------------- clock */

function tickClock() {
  const now = new Date();
  $('#clock').textContent = now.toLocaleString([], {
    weekday: 'short', day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

/* --------------------------------------------------------------- init */

function init() {
  buildChartToolbar();
  showHelp();
  refreshTape();
  refreshWatchlist();
  refreshMiniNews();
  tickClock();

  setInterval(tickClock, 1000);
  setInterval(refreshQuote, 15_000);
  setInterval(refreshWatchlist, 30_000);
  setInterval(refreshTape, 30_000);
  setInterval(() => { if (state.screen === 'chart') showChart(); }, 60_000);

  const cmd = $('#cmd');
  cmd.addEventListener('input', onCmdInput);
  cmd.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && acItems.length) {
      e.preventDefault(); acSel = (acSel + 1) % acItems.length; renderAC();
    } else if (e.key === 'ArrowUp' && acItems.length) {
      e.preventDefault(); acSel = (acSel - 1 + acItems.length) % acItems.length; renderAC();
    } else if (e.key === 'Escape') {
      hideAC();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (acSel >= 0 && acItems[acSel]) {
        const sym = acItems[acSel].symbol;
        hideAC(); cmd.value = '';
        loadSecurity(sym, 'GP');
      } else {
        hideAC();
        const v = cmd.value;
        cmd.value = '';
        runCommand(v);
      }
    }
  });
  cmd.addEventListener('blur', () => setTimeout(hideAC, 150));
  $('#go-btn').addEventListener('click', () => {
    const v = cmd.value; cmd.value = ''; hideAC(); runCommand(v); cmd.focus();
  });
  // keep focus on the command line, Bloomberg-style
  document.addEventListener('keydown', (e) => {
    if (e.target === cmd || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.length === 1) cmd.focus();
  });
}

init();
