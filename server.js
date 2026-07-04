/*
 * OpenTerm server — proxies free market-data APIs and serves the frontend.
 *
 * Data sources (all free tiers):
 *   - Yahoo Finance (no key): quotes, OHLC history, search, screeners,
 *     trending, fundamentals (via cookie+crumb), news fallback
 *   - Finnhub (optional key): company news + profile
 *   - CoinGecko (no key): crypto board
 *   - Frankfurter / ECB (no key): FX rates
 *
 * Keys live server-side in env vars so they never reach the browser, and an
 * in-memory TTL cache keeps request volume comfortably inside free limits.
 */
const express = require('express');
const path = require('path');
const { request, EnvHttpProxyAgent } = require('undici');

const PORT = process.env.PORT || 8432;
const FINNHUB_KEY = process.env.FINNHUB_API_KEY || '';
// Yahoo's edge rejects some browser-like UA strings; the short form works reliably.
const UA = 'Mozilla/5.0';

// Honor HTTPS_PROXY / NO_PROXY when present (corporate networks, sandboxes).
const dispatcher = (process.env.HTTPS_PROXY || process.env.https_proxy)
  ? new EnvHttpProxyAgent()
  : undefined;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------------------------------------------------------- cache */

const cache = new Map();
function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.promise;
  const promise = fn().catch((err) => {
    cache.delete(key); // don't cache failures
    throw err;
  });
  cache.set(key, { exp: Date.now() + ttlMs, promise });
  return promise;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) if (v.exp < now) cache.delete(k);
}, 60_000).unref();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// undici.request (not fetch): fetch adds Sec-Fetch-Mode/Accept-Language headers
// that Yahoo's edge rejects with 429. Retry once on transient throttling.
async function getJSON(url, headers = {}, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    const res = await request(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, dispatcher });
    if (res.statusCode >= 200 && res.statusCode < 300) return res.body.json();
    await res.body.dump();
    if (attempt < retries && [429, 502, 503, 999].includes(res.statusCode)) { await sleep(200 * (attempt + 1)); continue; }
    // log the full URL server-side for debugging, but don't leak upstream
    // endpoint shape/query params to the client via the error message
    console.error(`upstream ${res.statusCode} for ${url}`);
    throw new Error(`upstream error (${res.statusCode})`);
  }
}

function fail(res, err) {
  console.error(err.message || err);
  res.status(502).json({ error: String(err.message || err) });
}

const SYM_RE = /^[A-Za-z0-9^.\-=]{1,15}$/;
function cleanSymbol(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (!SYM_RE.test(s)) throw new Error('invalid symbol');
  return s;
}
// non-throwing variant for batch endpoints — an invalid symbol should be
// silently dropped from a multi-symbol request, not abort the whole batch
function tryCleanSymbol(raw) {
  try { return cleanSymbol(raw); } catch { return null; }
}

/* ------------------------------------------------- yahoo cookie+crumb */

// quoteSummary / v7 endpoints require a session cookie and matching crumb.
let yahooAuth = { cookie: '', crumb: '', exp: 0 };

async function getYahooAuth(force = false) {
  if (!force && yahooAuth.crumb && yahooAuth.exp > Date.now()) return yahooAuth;
  const r1 = await request('https://fc.yahoo.com/', { headers: { 'User-Agent': UA }, dispatcher });
  await r1.body.dump();
  const raw = r1.headers['set-cookie'];
  const cookie = (Array.isArray(raw) ? raw : [raw])
    .filter(Boolean).map((c) => String(c).split(';')[0]).join('; ');
  const r2 = await request('https://query2.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, Cookie: cookie }, dispatcher,
  });
  const crumb = (await r2.body.text()).trim();
  if (!crumb || crumb.length > 40) throw new Error('could not obtain Yahoo crumb');
  yahooAuth = { cookie, crumb, exp: Date.now() + 25 * 60_000 };
  return yahooAuth;
}

async function getAuthedJSON(buildUrl) {
  let auth = await getYahooAuth();
  let res = await request(buildUrl(auth.crumb), {
    headers: { 'User-Agent': UA, Accept: 'application/json', Cookie: auth.cookie }, dispatcher,
  });
  if (res.statusCode === 401 || res.statusCode === 403) {
    await res.body.dump();
    auth = await getYahooAuth(true); // crumb expired — refresh once
    res = await request(buildUrl(auth.crumb), {
      headers: { 'User-Agent': UA, Accept: 'application/json', Cookie: auth.cookie }, dispatcher,
    });
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    await res.body.dump();
    throw new Error(`${res.statusCode} from Yahoo`);
  }
  return res.body.json();
}

/* ------------------------------------------------------- yahoo finance */

const YF = 'https://query1.finance.yahoo.com';

async function yahooChart(symbol, range, interval) {
  const url = `${YF}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false&events=div%2Csplit`;
  const data = await getJSON(url);
  const result = data.chart && data.chart.result && data.chart.result[0];
  if (!result) throw new Error(data.chart?.error?.description || `no data for ${symbol}`);
  return result;
}

function quoteFromMeta(meta) {
  const price = meta.regularMarketPrice;
  // Yahoo returns hollow "YHD" shells for delisted/typo symbols (e.g. APPL):
  // a result object with no price at all. Reject those instead of rendering 0.00.
  if (price == null) throw new Error(`no price data for ${meta.symbol || 'symbol'} — it may be delisted or invalid`);
  const prev = meta.chartPreviousClose ?? meta.previousClose ?? price;
  return {
    symbol: meta.symbol,
    name: meta.longName || meta.shortName || meta.symbol,
    price,
    change: price - prev,
    changePct: prev ? ((price - prev) / prev) * 100 : 0,
    prevClose: prev,
    open: meta.regularMarketOpen ?? null,
    dayHigh: meta.regularMarketDayHigh ?? null,
    dayLow: meta.regularMarketDayLow ?? null,
    high52w: meta.fiftyTwoWeekHigh ?? null,
    low52w: meta.fiftyTwoWeekLow ?? null,
    volume: meta.regularMarketVolume ?? null,
    currency: meta.currency,
    exchange: meta.fullExchangeName || meta.exchangeName,
    type: meta.instrumentType,
    marketTime: meta.regularMarketTime ?? null,
    timezone: meta.timezone || '',
  };
}

app.get('/api/quote/:symbol', async (req, res) => {
  try {
    const symbol = cleanSymbol(req.params.symbol);
    const q = await cached(`q:${symbol}`, 10_000, async () =>
      quoteFromMeta((await yahooChart(symbol, '1d', '1m')).meta));
    res.json(q);
  } catch (err) { fail(res, err); }
});

app.get('/api/quotes', async (req, res) => {
  try {
    const symbols = String(req.query.symbols || '')
      .split(',').map((s) => s.trim()).filter(Boolean).slice(0, 40)
      .map(tryCleanSymbol).filter(Boolean);
    const settled = await Promise.allSettled(symbols.map((s) =>
      cached(`q:${s}`, 10_000, async () => quoteFromMeta((await yahooChart(s, '1d', '1m')).meta))));
    res.json(settled.map((r, i) => (r.status === 'fulfilled'
      ? r.value
      : { symbol: symbols[i], error: String(r.reason?.message || r.reason) })));
  } catch (err) { fail(res, err); }
});

const RANGES = { '1d': '5m', '5d': '15m', '1mo': '1d', '3mo': '1d', '6mo': '1d', '1y': '1d', '5y': '1wk', 'max': '1mo' };

app.get('/api/history/:symbol', async (req, res) => {
  try {
    const symbol = cleanSymbol(req.params.symbol);
    const range = RANGES[req.query.range] ? req.query.range : '1mo';
    const interval = RANGES[range];
    const result = await cached(`h:${symbol}:${range}`, 60_000, () => yahooChart(symbol, range, interval));
    const ts = result.timestamp || [];
    const q = result.indicators.quote[0] || {};
    const candles = [];
    for (let i = 0; i < ts.length; i++) {
      if (q.close?.[i] == null) continue;
      candles.push({
        t: ts[i],
        o: q.open?.[i] ?? q.close[i],
        h: q.high?.[i] ?? q.close[i],
        l: q.low?.[i] ?? q.close[i],
        c: q.close[i],
        v: q.volume?.[i] ?? 0,
      });
    }
    res.json({ symbol, range, interval, meta: quoteFromMeta(result.meta), candles });
  } catch (err) { fail(res, err); }
});

app.get('/api/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').slice(0, 60);
    if (!q) return res.json({ quotes: [], news: [] });
    const url = `${YF}/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=12&newsCount=0`;
    const data = await cached(`s:${q.toLowerCase()}`, 300_000, () => getJSON(url));
    res.json({
      quotes: (data.quotes || [])
        .filter((it) => it.symbol)
        .map((it) => ({
          symbol: it.symbol,
          name: it.longname || it.shortname || it.symbol,
          exchange: it.exchDisp || it.exchange,
          type: it.typeDisp || it.quoteType,
          sector: it.sectorDisp || it.sector || '',
          industry: it.industryDisp || it.industry || '',
        })),
    });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------- movers */

const SCREENERS = {
  gainers: 'day_gainers',
  losers: 'day_losers',
  actives: 'most_actives',
};

function moverRow(q) {
  const price = q.regularMarketPrice;
  return {
    symbol: q.symbol,
    name: q.shortName || q.longName || q.symbol,
    price,
    change: q.regularMarketChange,
    changePct: q.regularMarketChangePercent,
    volume: q.regularMarketVolume,
    marketCap: q.marketCap ?? null,
    exchange: q.fullExchangeName || '',
  };
}

app.get('/api/movers', async (req, res) => {
  try {
    const type = SCREENERS[req.query.type] ? req.query.type : 'gainers';
    const rows = await cached(`mov:${type}`, 60_000, async () => {
      const url = `${YF}/v1/finance/screener/predefined/saved?count=25&scrIds=${SCREENERS[type]}`;
      const data = await getJSON(url);
      const list = data.finance?.result?.[0]?.quotes || [];
      return list.map(moverRow);
    });
    res.json({ type, rows });
  } catch (err) { fail(res, err); }
});

app.get('/api/trending', async (_req, res) => {
  try {
    const syms = await cached('trending', 300_000, async () => {
      const url = `${YF}/v1/finance/trending/US?count=15`;
      const data = await getJSON(url);
      return (data.finance?.result?.[0]?.quotes || []).map((q) => q.symbol).filter(Boolean);
    });
    res.json({ symbols: syms });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------- fundamentals */

const num = (x) => (x && typeof x === 'object' && 'raw' in x ? x.raw : (typeof x === 'number' ? x : null));

app.get('/api/summary/:symbol', async (req, res) => {
  try {
    const symbol = cleanSymbol(req.params.symbol);
    const data = await cached(`sum:${symbol}`, 600_000, async () => {
      const modules = 'summaryDetail,defaultKeyStatistics,financialData,price,summaryProfile,calendarEvents,earnings';
      const json = await getAuthedJSON((crumb) =>
        `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`);
      const r = json.quoteSummary?.result?.[0];
      if (!r) throw new Error(json.quoteSummary?.error?.description || 'no fundamentals');
      const sd = r.summaryDetail || {}, ks = r.defaultKeyStatistics || {},
        fd = r.financialData || {}, pr = r.price || {}, sp = r.summaryProfile || {},
        ce = r.calendarEvents || {}, ea = r.earnings || {};
      const earningsQuarterly = (ea.earningsChart?.quarterly || []).map((q) => ({
        period: q.date, actual: num(q.actual), estimate: num(q.estimate),
      }));
      const yearly = (ea.financialsChart?.yearly || []).map((y) => ({
        year: y.date, revenue: num(y.revenue), earnings: num(y.earnings),
      }));
      return {
        symbol,
        name: pr.longName || pr.shortName || symbol,
        sector: sp.sector || '',
        industry: sp.industry || '',
        website: sp.website || '',
        country: sp.country || '',
        employees: num(sp.fullTimeEmployees),
        summary: sp.longBusinessSummary || '',
        marketCap: num(pr.marketCap) ?? num(sd.marketCap),
        peTrailing: num(sd.trailingPE),
        peForward: num(sd.forwardPE) ?? num(ks.forwardPE),
        pegRatio: num(ks.pegRatio),
        priceToBook: num(ks.priceToBook),
        eps: num(ks.trailingEps),
        beta: num(sd.beta) ?? num(ks.beta),
        dividendYield: num(sd.dividendYield),
        dividendRate: num(sd.dividendRate),
        payoutRatio: num(sd.payoutRatio),
        sharesOut: num(ks.sharesOutstanding),
        floatShares: num(ks.floatShares),
        heldPctInsiders: num(ks.heldPercentInsiders),
        heldPctInstitutions: num(ks.heldPercentInstitutions),
        shortPctFloat: num(ks.shortPercentOfFloat),
        profitMargin: num(fd.profitMargins) ?? num(ks.profitMargins),
        operatingMargin: num(fd.operatingMargins),
        grossMargin: num(fd.grossMargins),
        roe: num(fd.returnOnEquity),
        roa: num(fd.returnOnAssets),
        revenue: num(fd.totalRevenue),
        revenueGrowth: num(fd.revenueGrowth),
        earningsGrowth: num(fd.earningsGrowth),
        grossProfits: num(fd.grossProfits),
        ebitda: num(fd.ebitda),
        totalCash: num(fd.totalCash),
        totalDebt: num(fd.totalDebt),
        debtToEquity: num(fd.debtToEquity),
        currentRatio: num(fd.currentRatio),
        freeCashflow: num(fd.freeCashflow),
        targetMean: num(fd.targetMeanPrice),
        targetHigh: num(fd.targetHighPrice),
        targetLow: num(fd.targetLowPrice),
        recommendationKey: fd.recommendationKey || '',
        recommendationMean: num(fd.recommendationMean),
        numberOfAnalysts: num(fd.numberOfAnalystOpinions),
        high52w: num(sd.fiftyTwoWeekHigh),
        low52w: num(sd.fiftyTwoWeekLow),
        avgVolume: num(sd.averageVolume),
        bid: num(sd.bid), ask: num(sd.ask),
        bidSize: num(sd.bidSize), askSize: num(sd.askSize),
        nextEarningsDate: (ce.earnings?.earningsDate || []).map(num).filter(Boolean)[0] || null,
        earningsQuarterly,
        yearly,
      };
    });
    res.json(data);
  } catch (err) { fail(res, err); }
});

/* ---------------------------------------------------------------- news */

app.get('/api/news', async (req, res) => {
  try {
    // free-text topic mode (NI <topic>): ?q= bypasses symbol validation
    if (req.query.q) {
      const q = String(req.query.q).slice(0, 40);
      const data = await cached(`nq:${q.toLowerCase()}`, 120_000, async () => {
        const url = `${YF}/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=0&newsCount=25`;
        const j = await getJSON(url);
        return (j.news || []).map((n) => ({ title: n.title, source: n.publisher, url: n.link, time: n.providerPublishTime, summary: '' }));
      });
      return res.json({ symbol: q, items: data });
    }
    const symbol = cleanSymbol(req.query.symbol || 'SPY');
    const items = await cached(`n:${symbol}`, 120_000, async () => {
      if (FINNHUB_KEY) {
        const to = new Date().toISOString().slice(0, 10);
        const from = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
        const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}&token=${FINNHUB_KEY}`;
        const data = await getJSON(url);
        return data.slice(0, 30).map((n) => ({
          title: n.headline, source: n.source, url: n.url, time: n.datetime, summary: n.summary || '',
        }));
      }
      const url = `${YF}/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=0&newsCount=20`;
      const data = await getJSON(url);
      return (data.news || []).map((n) => ({
        title: n.title, source: n.publisher, url: n.link, time: n.providerPublishTime, summary: '',
      }));
    });
    res.json({ symbol, items });
  } catch (err) { fail(res, err); }
});

/* -------------------------------------------------------------- profile */

app.get('/api/profile/:symbol', async (req, res) => {
  try {
    const symbol = cleanSymbol(req.params.symbol);
    const profile = await cached(`p:${symbol}`, 3_600_000, async () => {
      if (FINNHUB_KEY) {
        const url = `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`;
        const p = await getJSON(url);
        if (p && p.name) {
          return {
            name: p.name, sector: p.finnhubIndustry || '', industry: p.finnhubIndustry || '',
            exchange: p.exchange || '', country: p.country || '', currency: p.currency || '',
            marketCap: p.marketCapitalization ? p.marketCapitalization * 1e6 : null,
            sharesOut: p.shareOutstanding ? p.shareOutstanding * 1e6 : null,
            ipo: p.ipo || '', web: p.weburl || '', logo: p.logo || '',
          };
        }
      }
      const url = `${YF}/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=6&newsCount=0`;
      const data = await getJSON(url);
      const hit = (data.quotes || []).find((it) => it.symbol === symbol) || (data.quotes || [])[0];
      if (!hit) return {};
      return {
        name: hit.longname || hit.shortname || symbol,
        sector: hit.sectorDisp || hit.sector || '',
        industry: hit.industryDisp || hit.industry || '',
        exchange: hit.exchDisp || hit.exchange || '',
        country: '', currency: '', marketCap: null, sharesOut: null, ipo: '', web: '', logo: '',
      };
    });
    res.json(profile);
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------- fx board */

app.get('/api/fx', async (req, res) => {
  try {
    const base = /^[A-Z]{3}$/.test(String(req.query.base || '').toUpperCase())
      ? String(req.query.base).toUpperCase() : 'USD';
    const data = await cached(`fx:${base}`, 300_000, async () => {
      const symbols = ['EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'CNY', 'INR', 'MXN', 'BRL', 'KRW', 'SEK', 'NOK', 'ZAR', 'USD']
        .filter((c) => c !== base).join(',');
      const from = new Date(Date.now() - 8 * 864e5).toISOString().slice(0, 10);
      const url = `https://api.frankfurter.dev/v1/${from}..?base=${base}&symbols=${symbols}`;
      const series = await getJSON(url);
      const dates = Object.keys(series.rates || {}).sort();
      const last = series.rates[dates[dates.length - 1]] || {};
      const prev = series.rates[dates[dates.length - 2]] || last;
      return {
        base,
        date: dates[dates.length - 1] || '',
        rates: Object.keys(last).sort().map((ccy) => ({
          ccy,
          rate: last[ccy],
          change: prev[ccy] ? last[ccy] - prev[ccy] : 0,
          changePct: prev[ccy] ? ((last[ccy] - prev[ccy]) / prev[ccy]) * 100 : 0,
        })),
      };
    });
    res.json(data);
  } catch (err) { fail(res, err); }
});

/* ---------------------------------------------------------------- crypto */

app.get('/api/crypto', async (_req, res) => {
  try {
    const data = await cached('crypto', 60_000, async () => {
      const url = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=25&page=1&sparkline=false&price_change_percentage=24h';
      const coins = await getJSON(url);
      return coins.map((c) => ({
        id: c.id,
        symbol: (c.symbol || '').toUpperCase(),
        name: c.name,
        price: c.current_price,
        changePct: c.price_change_percentage_24h ?? 0,
        marketCap: c.market_cap,
        volume: c.total_volume,
        high24h: c.high_24h,
        low24h: c.low_24h,
      }));
    });
    res.json(data);
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------- sparklines (batch) */

// One upstream call returns close arrays for many symbols — ideal for grids.
app.get('/api/spark', async (req, res) => {
  try {
    const symbols = String(req.query.symbols || '')
      .split(',').map((s) => s.trim()).filter(Boolean).slice(0, 40).map(tryCleanSymbol).filter(Boolean);
    if (!symbols.length) return res.json({});
    const range = ['1d', '5d', '1mo', '3mo'].includes(req.query.range) ? req.query.range : '1d';
    const interval = range === '1d' ? '5m' : range === '5d' ? '30m' : '1d';
    const out = await cached(`spark:${range}:${symbols.join(',')}`, 60_000, async () => {
      const url = `${YF}/v8/finance/spark?symbols=${encodeURIComponent(symbols.join(','))}&range=${range}&interval=${interval}`;
      const data = await getJSON(url);
      const result = {};
      for (const sym of symbols) {
        const s = data[sym];
        if (!s || !s.close) continue;
        const close = s.close.filter((v) => v != null);
        const prev = s.chartPreviousClose ?? s.previousClose ?? close[0];
        const last = close[close.length - 1];
        result[sym] = { close, prev, last, changePct: prev ? ((last - prev) / prev) * 100 : 0 };
      }
      return result;
    });
    res.json(out);
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------- weather */

const WMO = { 0: 'Clear', 1: 'Clear', 2: 'P.Cloudy', 3: 'Cloudy', 45: 'Fog', 48: 'Fog', 51: 'Drizzle', 53: 'Drizzle', 55: 'Drizzle', 61: 'Rain', 63: 'Rain', 65: 'Heavy Rain', 71: 'Snow', 73: 'Snow', 75: 'Snow', 80: 'Showers', 81: 'Showers', 82: 'Showers', 95: 'Storm', 96: 'Storm', 99: 'Storm' };
const CITIES = [
  { name: 'NEW YORK', tz: 'America/New_York', lat: 40.71, lon: -74.01 },
  { name: 'LONDON', tz: 'Europe/London', lat: 51.51, lon: -0.13 },
  { name: 'HONG KONG', tz: 'Asia/Hong_Kong', lat: 22.32, lon: 114.17 },
  { name: 'TOKYO', tz: 'Asia/Tokyo', lat: 35.68, lon: 139.65 },
];

app.get('/api/weather', async (_req, res) => {
  try {
    const data = await cached('weather', 900_000, async () => {
      const lat = CITIES.map((c) => c.lat).join(',');
      const lon = CITIES.map((c) => c.lon).join(',');
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&temperature_unit=fahrenheit`;
      const arr = await getJSON(url);
      const list = Array.isArray(arr) ? arr : [arr];
      return CITIES.map((c, i) => ({
        name: c.name, tz: c.tz,
        temp: Math.round(list[i]?.current?.temperature_2m ?? 0),
        cond: WMO[list[i]?.current?.weather_code] || '—',
      }));
    });
    res.json(data);
  } catch (err) { fail(res, err); }
});

/* -------------------------------------------------- multi-year financials */

// Legacy quoteSummary statement modules were gutted; the current data lives in
// the fundamentals-timeseries feed, keyed by "annual<Metric>" type names.
const INCOME_ROWS = [
  ['annualTotalRevenue', 'Revenue'], ['annualCostOfRevenue', 'Cost of Revenue'], ['annualGrossProfit', 'Gross Profit'],
  ['annualResearchAndDevelopment', 'R&D'], ['annualSellingGeneralAndAdministration', 'SG&A'],
  ['annualOperatingExpense', 'Operating Expense'], ['annualOperatingIncome', 'Operating Income'],
  ['annualEBITDA', 'EBITDA'], ['annualEBIT', 'EBIT'], ['annualInterestExpense', 'Interest Expense'],
  ['annualPretaxIncome', 'Pretax Income'], ['annualTaxProvision', 'Tax Provision'], ['annualNetIncome', 'Net Income'],
  ['annualDilutedEPS', 'Diluted EPS'], ['annualBasicAverageShares', 'Avg Shares'],
];
const BALANCE_ROWS = [
  ['annualCashAndCashEquivalents', 'Cash & Equivalents'], ['annualOtherShortTermInvestments', 'Short-Term Investments'],
  ['annualAccountsReceivable', 'Accounts Receivable'], ['annualOtherReceivables', 'Other Receivables'],
  ['annualInventory', 'Inventory'], ['annualOtherCurrentAssets', 'Other Current Assets'],
  ['annualCurrentAssets', 'Total Current Assets'],
  ['annualGrossPPE', 'Gross PP&E'], ['annualAccumulatedDepreciation', 'Accumulated Depreciation'], ['annualNetPPE', 'Net PP&E'],
  ['annualGoodwill', 'Goodwill'], ['annualOtherIntangibleAssets', 'Intangibles'], ['annualOtherNonCurrentAssets', 'Other Non-Current Assets'],
  ['annualTotalAssets', 'Total Assets'],
  ['annualAccountsPayable', 'Accounts Payable'], ['annualCurrentAccruedExpenses', 'Accrued Expenses'],
  ['annualCurrentDeferredRevenue', 'Deferred Revenue'], ['annualCurrentDebt', 'Short-Term Debt'],
  ['annualCurrentLiabilities', 'Total Current Liab.'],
  ['annualLongTermDebt', 'Long-Term Debt'], ['annualOtherNonCurrentLiabilities', 'Other Non-Current Liab.'],
  ['annualTotalLiabilitiesNetMinorityInterest', 'Total Liabilities'], ['annualTotalDebt', 'Total Debt'],
  ['annualCommonStock', 'Common Stock'], ['annualRetainedEarnings', 'Retained Earnings'], ['annualTreasuryStock', 'Treasury Stock'],
  ['annualMinorityInterest', 'Minority Interest'], ['annualStockholdersEquity', 'Total Equity'],
];
const CASHFLOW_ROWS = [
  ['annualOperatingCashFlow', 'Cash from Operations'], ['annualCapitalExpenditure', 'Capital Expenditure'],
  ['annualFreeCashFlow', 'Free Cash Flow'], ['annualInvestingCashFlow', 'Cash from Investing'],
  ['annualCashDividendsPaid', 'Dividends Paid'], ['annualRepurchaseOfCapitalStock', 'Stock Repurchased'],
  ['annualFinancingCashFlow', 'Cash from Financing'], ['annualEndCashPosition', 'End Cash Position'],
  ['annualChangesInCash', 'Net Change in Cash'],
];
const ALL_FIN_TYPES = [...INCOME_ROWS, ...BALANCE_ROWS, ...CASHFLOW_ROWS].map((r) => r[0]);

app.get('/api/financials/:symbol', async (req, res) => {
  try {
    const symbol = cleanSymbol(req.params.symbol);
    const data = await cached(`fin:${symbol}`, 3_600_000, async () => {
      const url = `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}`
        + `?symbol=${encodeURIComponent(symbol)}&type=${ALL_FIN_TYPES.join(',')}&period1=1230768000&period2=2000000000&merge=false`;
      const json = await getAuthedJSON((crumb) => `${url}&crumb=${encodeURIComponent(crumb)}`);
      const series = json.timeseries?.result || [];
      const byType = {};
      const yearSet = new Set();
      for (const s of series) {
        const type = s.meta?.type?.[0];
        if (!type || !Array.isArray(s[type])) continue;
        const m = {};
        for (const pt of s[type]) {
          if (!pt) continue;
          const yr = (pt.asOfDate || '').slice(0, 4);
          const val = pt.reportedValue?.raw;
          if (yr && val != null) { m[yr] = val; yearSet.add(yr); }
        }
        byType[type] = m;
      }
      // keep the most recent years that actually carry data across the statements
      const populated = [...yearSet].filter((y) => ALL_FIN_TYPES.some((t) => byType[t]?.[y] != null));
      const years = populated.sort().reverse().slice(0, 4);
      if (!years.length) throw new Error('no financial history available');
      const rows = (spec) => spec
        .map(([type, label]) => ({ label, values: years.map((y) => byType[type]?.[y] ?? null) }))
        .filter((r) => r.values.some((v) => v != null));
      return { symbol, years, income: rows(INCOME_ROWS), balance: rows(BALANCE_ROWS), cashflow: rows(CASHFLOW_ROWS) };
    });
    res.json(data);
  } catch (err) { fail(res, err); }
});

/* -------------------------------------------------- ANR: analyst recs */

app.get('/api/analyst/:symbol', async (req, res) => {
  try {
    const symbol = cleanSymbol(req.params.symbol);
    const data = await cached(`anr:${symbol}`, 1_800_000, async () => {
      const modules = 'upgradeDowngradeHistory,recommendationTrend,financialData';
      const json = await getAuthedJSON((crumb) =>
        `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`);
      const r = json.quoteSummary?.result?.[0];
      if (!r) throw new Error('no analyst data');
      const fd = r.financialData || {};
      return {
        symbol,
        trend: (r.recommendationTrend?.trend || []).map((t) => ({
          period: t.period, strongBuy: t.strongBuy, buy: t.buy, hold: t.hold, sell: t.sell, strongSell: t.strongSell,
        })),
        history: (r.upgradeDowngradeHistory?.history || []).slice(0, 40).map((h) => ({
          time: h.epochGradeDate, firm: h.firm, toGrade: h.toGrade, fromGrade: h.fromGrade,
          action: h.action, target: h.currentPriceTarget ?? null, priorTarget: h.priorPriceTarget ?? null,
        })),
        targetMean: num(fd.targetMeanPrice), targetHigh: num(fd.targetHighPrice), targetLow: num(fd.targetLowPrice),
        recommendationKey: fd.recommendationKey || '', recommendationMean: num(fd.recommendationMean),
        numberOfAnalysts: num(fd.numberOfAnalystOpinions),
      };
    });
    res.json(data);
  } catch (err) { fail(res, err); }
});

/* -------------------------------------------------- HDS: holders */

app.get('/api/holders/:symbol', async (req, res) => {
  try {
    const symbol = cleanSymbol(req.params.symbol);
    const data = await cached(`hds:${symbol}`, 3_600_000, async () => {
      const modules = 'institutionOwnership,insiderHolders,majorHoldersBreakdown,fundOwnership';
      const json = await getAuthedJSON((crumb) =>
        `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`);
      const r = json.quoteSummary?.result?.[0];
      if (!r) throw new Error('no holders data');
      const mapOwn = (list) => (list || []).map((o) => ({
        name: o.organization, position: num(o.position), value: num(o.value),
        pctHeld: num(o.pctHeld), reportDate: o.reportDate?.fmt || '', pctChange: num(o.pctChange),
      }));
      const mb = r.majorHoldersBreakdown || {};
      return {
        symbol,
        institutions: mapOwn(r.institutionOwnership?.ownershipList),
        funds: mapOwn(r.fundOwnership?.ownershipList),
        insiders: (r.insiderHolders?.holders || []).map((h) => ({
          name: h.name, relation: h.relation, position: num(h.positionDirect) ?? num(h.positionIndirect),
          latestTrans: h.transactionDescription || '', date: h.latestTransDate?.fmt || '',
        })),
        breakdown: {
          insidersPct: num(mb.insidersPercentHeld), institutionsPct: num(mb.institutionsPercentHeld),
          institutionsFloatPct: num(mb.institutionsFloatPercentHeld), institutionsCount: num(mb.institutionsCount),
        },
      };
    });
    res.json(data);
  } catch (err) { fail(res, err); }
});

/* -------------------------------------------------- DVD: dividends */

app.get('/api/dividends/:symbol', async (req, res) => {
  try {
    const symbol = cleanSymbol(req.params.symbol);
    const data = await cached(`dvd:${symbol}`, 3_600_000, async () => {
      const url = `${YF}/v8/finance/chart/${encodeURIComponent(symbol)}?range=10y&interval=1mo&events=div%2Csplit`;
      const j = await getJSON(url);
      const r = j.chart?.result?.[0];
      if (!r) throw new Error('no dividend data');
      const divs = Object.values(r.events?.dividends || {})
        .map((d) => ({ date: d.date, amount: d.amount }))
        .sort((a, b) => b.date - a.date);
      const splits = Object.values(r.events?.splits || {})
        .map((s) => ({ date: s.date, ratio: `${s.numerator}:${s.denominator}` }))
        .sort((a, b) => b.date - a.date);
      return { symbol, price: r.meta?.regularMarketPrice ?? null, dividends: divs, splits };
    });
    res.json(data);
  } catch (err) { fail(res, err); }
});

/* -------------------------------------------------- EQS: screener */

const EQS_SCREENS = {
  gainers: ['day_gainers', 'Day Gainers'],
  losers: ['day_losers', 'Day Losers'],
  actives: ['most_actives', 'Most Actives'],
  ugrowth: ['undervalued_growth_stocks', 'Undervalued Growth'],
  gtech: ['growth_technology_stocks', 'Growth Technology'],
  ularge: ['undervalued_large_caps', 'Undervalued Large Caps'],
  smallcap: ['small_cap_gainers', 'Small-Cap Gainers'],
  aggsmall: ['aggressive_small_caps', 'Aggressive Small Caps'],
};

app.get('/api/screener', async (req, res) => {
  try {
    const key = EQS_SCREENS[req.query.scr] ? req.query.scr : 'ugrowth';
    const [scrId, title] = EQS_SCREENS[key];
    const rows = await cached(`eqs:${key}`, 300_000, async () => {
      const url = `${YF}/v1/finance/screener/predefined/saved?count=40&scrIds=${scrId}`;
      const data = await getJSON(url);
      return (data.finance?.result?.[0]?.quotes || []).map(moverRow);
    });
    res.json({ key, title, screens: Object.entries(EQS_SCREENS).map(([k, [, t]]) => [k, t]), rows });
  } catch (err) { fail(res, err); }
});

app.get('/api/status', (_req, res) => {
  res.json({ ok: true, finnhub: Boolean(FINNHUB_KEY) });
});

app.listen(PORT, () => {
  console.log(`OpenTerm running at http://localhost:${PORT}`);
  console.log(`Finnhub key: ${FINNHUB_KEY ? 'configured' : 'not set (using free no-key fallbacks)'}`);
});
