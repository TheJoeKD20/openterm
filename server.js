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

// undici.request (not fetch): fetch adds Sec-Fetch-Mode/Accept-Language headers
// that Yahoo's edge rejects with 429.
async function getJSON(url, headers = {}) {
  const res = await request(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, dispatcher });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    await res.body.dump();
    throw new Error(`${res.statusCode} for ${url}`);
  }
  return res.body.json();
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
      .map(cleanSymbol);
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

app.get('/api/status', (_req, res) => {
  res.json({ ok: true, finnhub: Boolean(FINNHUB_KEY) });
});

app.listen(PORT, () => {
  console.log(`OpenTerm running at http://localhost:${PORT}`);
  console.log(`Finnhub key: ${FINNHUB_KEY ? 'configured' : 'not set (using free no-key fallbacks)'}`);
});
