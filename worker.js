/*
 * OpenTerm — Cloudflare Worker edition.
 *
 * Serves the static frontend (public/ via the ASSETS binding) and implements
 * the same /api/* proxy as server.js using the Workers runtime's native fetch.
 * Deploy with `wrangler deploy` (see wrangler.toml and the README).
 *
 * Env vars (wrangler secret / vars):
 *   FINNHUB_API_KEY  optional — richer news & profiles
 */

const UA = 'Mozilla/5.0';
const YF = 'https://query1.finance.yahoo.com';

/* ------------------------------------------------------ per-isolate cache */
const cache = new Map();
function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.promise;
  const promise = fn().catch((err) => { cache.delete(key); throw err; });
  cache.set(key, { exp: Date.now() + ttlMs, promise });
  return promise;
}

async function getJSON(url, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers } });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res.json();
}

const SYM_RE = /^[A-Za-z0-9^.\-=]{1,15}$/;
function cleanSymbol(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (!SYM_RE.test(s)) throw new Error('invalid symbol');
  return s;
}
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
const fail = (err) => json({ error: String(err.message || err) }, 502);
const num = (x) => (x && typeof x === 'object' && 'raw' in x ? x.raw : (typeof x === 'number' ? x : null));

/* ----------------------------------------------------- yahoo cookie+crumb */
let yahooAuth = { cookie: '', crumb: '', exp: 0 };
async function getYahooAuth(force = false) {
  if (!force && yahooAuth.crumb && yahooAuth.exp > Date.now()) return yahooAuth;
  const r1 = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': UA } });
  const raw = typeof r1.headers.getSetCookie === 'function' ? r1.headers.getSetCookie() : [r1.headers.get('set-cookie')];
  const cookie = (raw || []).filter(Boolean).map((c) => String(c).split(';')[0]).join('; ');
  const r2 = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookie } });
  const crumb = (await r2.text()).trim();
  if (!crumb || crumb.length > 40) throw new Error('could not obtain Yahoo crumb');
  yahooAuth = { cookie, crumb, exp: Date.now() + 25 * 60_000 };
  return yahooAuth;
}
async function getAuthedJSON(buildUrl) {
  let auth = await getYahooAuth();
  let res = await fetch(buildUrl(auth.crumb), { headers: { 'User-Agent': UA, Accept: 'application/json', Cookie: auth.cookie } });
  if (res.status === 401 || res.status === 403) {
    auth = await getYahooAuth(true);
    res = await fetch(buildUrl(auth.crumb), { headers: { 'User-Agent': UA, Accept: 'application/json', Cookie: auth.cookie } });
  }
  if (!res.ok) throw new Error(`${res.status} from Yahoo`);
  return res.json();
}

/* ----------------------------------------------------------- yahoo core */
async function yahooChart(symbol, range, interval) {
  const url = `${YF}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false&events=div%2Csplit`;
  const data = await getJSON(url);
  const result = data.chart && data.chart.result && data.chart.result[0];
  if (!result) throw new Error(data.chart?.error?.description || `no data for ${symbol}`);
  return result;
}
function quoteFromMeta(m) {
  const price = m.regularMarketPrice, prev = m.chartPreviousClose ?? m.previousClose ?? price;
  return {
    symbol: m.symbol, name: m.longName || m.shortName || m.symbol, price,
    change: price - prev, changePct: prev ? ((price - prev) / prev) * 100 : 0, prevClose: prev,
    open: m.regularMarketOpen ?? null, dayHigh: m.regularMarketDayHigh ?? null, dayLow: m.regularMarketDayLow ?? null,
    high52w: m.fiftyTwoWeekHigh ?? null, low52w: m.fiftyTwoWeekLow ?? null, volume: m.regularMarketVolume ?? null,
    currency: m.currency, exchange: m.fullExchangeName || m.exchangeName, type: m.instrumentType,
    marketTime: m.regularMarketTime ?? null, timezone: m.timezone || '',
  };
}
const RANGES = { '1d': '5m', '5d': '15m', '1mo': '1d', '3mo': '1d', '6mo': '1d', '1y': '1d', '5y': '1wk', max: '1mo' };
const SCREENERS = { gainers: 'day_gainers', losers: 'day_losers', actives: 'most_actives' };

const INCOME_ROWS = [['annualTotalRevenue', 'Revenue'], ['annualCostOfRevenue', 'Cost of Revenue'], ['annualGrossProfit', 'Gross Profit'], ['annualResearchAndDevelopment', 'R&D'], ['annualSellingGeneralAndAdministration', 'SG&A'], ['annualOperatingExpense', 'Operating Expense'], ['annualOperatingIncome', 'Operating Income'], ['annualEBITDA', 'EBITDA'], ['annualEBIT', 'EBIT'], ['annualInterestExpense', 'Interest Expense'], ['annualPretaxIncome', 'Pretax Income'], ['annualTaxProvision', 'Tax Provision'], ['annualNetIncome', 'Net Income'], ['annualDilutedEPS', 'Diluted EPS'], ['annualBasicAverageShares', 'Avg Shares']];
const BALANCE_ROWS = [['annualCashAndCashEquivalents', 'Cash & Equivalents'], ['annualOtherShortTermInvestments', 'Short-Term Investments'], ['annualAccountsReceivable', 'Accounts Receivable'], ['annualOtherReceivables', 'Other Receivables'], ['annualInventory', 'Inventory'], ['annualOtherCurrentAssets', 'Other Current Assets'], ['annualCurrentAssets', 'Total Current Assets'], ['annualGrossPPE', 'Gross PP&E'], ['annualAccumulatedDepreciation', 'Accumulated Depreciation'], ['annualNetPPE', 'Net PP&E'], ['annualGoodwill', 'Goodwill'], ['annualOtherIntangibleAssets', 'Intangibles'], ['annualOtherNonCurrentAssets', 'Other Non-Current Assets'], ['annualTotalAssets', 'Total Assets'], ['annualAccountsPayable', 'Accounts Payable'], ['annualCurrentAccruedExpenses', 'Accrued Expenses'], ['annualCurrentDeferredRevenue', 'Deferred Revenue'], ['annualCurrentDebt', 'Short-Term Debt'], ['annualCurrentLiabilities', 'Total Current Liab.'], ['annualLongTermDebt', 'Long-Term Debt'], ['annualOtherNonCurrentLiabilities', 'Other Non-Current Liab.'], ['annualTotalLiabilitiesNetMinorityInterest', 'Total Liabilities'], ['annualTotalDebt', 'Total Debt'], ['annualCommonStock', 'Common Stock'], ['annualRetainedEarnings', 'Retained Earnings'], ['annualTreasuryStock', 'Treasury Stock'], ['annualMinorityInterest', 'Minority Interest'], ['annualStockholdersEquity', 'Total Equity']];
const CASHFLOW_ROWS = [['annualOperatingCashFlow', 'Cash from Operations'], ['annualCapitalExpenditure', 'Capital Expenditure'], ['annualFreeCashFlow', 'Free Cash Flow'], ['annualInvestingCashFlow', 'Cash from Investing'], ['annualCashDividendsPaid', 'Dividends Paid'], ['annualRepurchaseOfCapitalStock', 'Stock Repurchased'], ['annualFinancingCashFlow', 'Cash from Financing'], ['annualEndCashPosition', 'End Cash Position'], ['annualChangesInCash', 'Net Change in Cash']];
const ALL_FIN_TYPES = [...INCOME_ROWS, ...BALANCE_ROWS, ...CASHFLOW_ROWS].map((r) => r[0]);

const WMO = { 0: 'Clear', 1: 'Clear', 2: 'P.Cloudy', 3: 'Cloudy', 45: 'Fog', 48: 'Fog', 51: 'Drizzle', 53: 'Drizzle', 55: 'Drizzle', 61: 'Rain', 63: 'Rain', 65: 'Heavy Rain', 71: 'Snow', 73: 'Snow', 75: 'Snow', 80: 'Showers', 81: 'Showers', 82: 'Showers', 95: 'Storm', 96: 'Storm', 99: 'Storm' };
const CITIES = [{ name: 'NEW YORK', lat: 40.71, lon: -74.01 }, { name: 'LONDON', lat: 51.51, lon: -0.13 }, { name: 'HONG KONG', lat: 22.32, lon: 114.17 }, { name: 'TOKYO', lat: 35.68, lon: 139.65 }];

/* ------------------------------------------------------------- handlers */
async function handleApi(url, env) {
  const p = url.pathname;
  const qs = url.searchParams;
  const FIN = env.FINNHUB_API_KEY || '';

  if (p.startsWith('/api/quote/')) {
    const s = cleanSymbol(p.split('/').pop());
    return json(await cached(`q:${s}`, 10_000, async () => quoteFromMeta((await yahooChart(s, '1d', '1m')).meta)));
  }
  if (p === '/api/quotes') {
    const syms = String(qs.get('symbols') || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 40).map(cleanSymbol);
    const settled = await Promise.allSettled(syms.map((s) => cached(`q:${s}`, 10_000, async () => quoteFromMeta((await yahooChart(s, '1d', '1m')).meta))));
    return json(settled.map((r, i) => (r.status === 'fulfilled' ? r.value : { symbol: syms[i], error: String(r.reason?.message || r.reason) })));
  }
  if (p.startsWith('/api/history/')) {
    const s = cleanSymbol(p.split('/').pop());
    const range = RANGES[qs.get('range')] ? qs.get('range') : '1mo';
    const result = await cached(`h:${s}:${range}`, 60_000, () => yahooChart(s, range, RANGES[range]));
    const ts = result.timestamp || [], q = result.indicators.quote[0] || {}, candles = [];
    for (let i = 0; i < ts.length; i++) {
      if (q.close?.[i] == null) continue;
      candles.push({ t: ts[i], o: q.open?.[i] ?? q.close[i], h: q.high?.[i] ?? q.close[i], l: q.low?.[i] ?? q.close[i], c: q.close[i], v: q.volume?.[i] ?? 0 });
    }
    return json({ symbol: s, range, interval: RANGES[range], meta: quoteFromMeta(result.meta), candles });
  }
  if (p === '/api/spark') {
    const syms = String(qs.get('symbols') || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 40).map(cleanSymbol);
    if (!syms.length) return json({});
    const range = ['1d', '5d', '1mo', '3mo'].includes(qs.get('range')) ? qs.get('range') : '1d';
    const interval = range === '1d' ? '5m' : range === '5d' ? '30m' : '1d';
    return json(await cached(`spark:${range}:${syms.join(',')}`, 60_000, async () => {
      const data = await getJSON(`${YF}/v8/finance/spark?symbols=${encodeURIComponent(syms.join(','))}&range=${range}&interval=${interval}`);
      const out = {};
      for (const sym of syms) {
        const s = data[sym]; if (!s || !s.close) continue;
        const close = s.close.filter((v) => v != null), prev = s.chartPreviousClose ?? s.previousClose ?? close[0], last = close[close.length - 1];
        out[sym] = { close, prev, last, changePct: prev ? ((last - prev) / prev) * 100 : 0 };
      }
      return out;
    }));
  }
  if (p === '/api/search') {
    const q = String(qs.get('q') || '').slice(0, 60);
    if (!q) return json({ quotes: [] });
    const data = await cached(`s:${q.toLowerCase()}`, 300_000, () => getJSON(`${YF}/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=12&newsCount=0`));
    return json({ quotes: (data.quotes || []).filter((it) => it.symbol).map((it) => ({ symbol: it.symbol, name: it.longname || it.shortname || it.symbol, exchange: it.exchDisp || it.exchange, type: it.typeDisp || it.quoteType, sector: it.sectorDisp || it.sector || '', industry: it.industryDisp || it.industry || '' })) });
  }
  if (p === '/api/movers') {
    const type = SCREENERS[qs.get('type')] ? qs.get('type') : 'gainers';
    return json({ type, rows: await cached(`mov:${type}`, 60_000, async () => {
      const data = await getJSON(`${YF}/v1/finance/screener/predefined/saved?count=25&scrIds=${SCREENERS[type]}`);
      return (data.finance?.result?.[0]?.quotes || []).map((q) => ({ symbol: q.symbol, name: q.shortName || q.longName || q.symbol, price: q.regularMarketPrice, change: q.regularMarketChange, changePct: q.regularMarketChangePercent, volume: q.regularMarketVolume, marketCap: q.marketCap ?? null, exchange: q.fullExchangeName || '' }));
    }) });
  }
  if (p === '/api/weather') {
    return json(await cached('weather', 900_000, async () => {
      const lat = CITIES.map((c) => c.lat).join(','), lon = CITIES.map((c) => c.lon).join(',');
      const arr = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&temperature_unit=fahrenheit`);
      const list = Array.isArray(arr) ? arr : [arr];
      return CITIES.map((c, i) => ({ name: c.name, temp: Math.round(list[i]?.current?.temperature_2m ?? 0), cond: WMO[list[i]?.current?.weather_code] || '—' }));
    }));
  }
  if (p === '/api/fx') {
    const base = /^[A-Z]{3}$/.test(String(qs.get('base') || '').toUpperCase()) ? qs.get('base').toUpperCase() : 'USD';
    return json(await cached(`fx:${base}`, 300_000, async () => {
      const symbols = ['EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'CNY', 'INR', 'MXN', 'BRL', 'KRW', 'SEK', 'NOK', 'ZAR', 'USD'].filter((c) => c !== base).join(',');
      const from = new Date(Date.now() - 8 * 864e5).toISOString().slice(0, 10);
      const series = await getJSON(`https://api.frankfurter.dev/v1/${from}..?base=${base}&symbols=${symbols}`);
      const dates = Object.keys(series.rates || {}).sort(), last = series.rates[dates[dates.length - 1]] || {}, prev = series.rates[dates[dates.length - 2]] || last;
      return { base, date: dates[dates.length - 1] || '', rates: Object.keys(last).sort().map((ccy) => ({ ccy, rate: last[ccy], change: prev[ccy] ? last[ccy] - prev[ccy] : 0, changePct: prev[ccy] ? ((last[ccy] - prev[ccy]) / prev[ccy]) * 100 : 0 })) };
    }));
  }
  if (p === '/api/crypto') {
    return json(await cached('crypto', 60_000, async () => {
      const coins = await getJSON('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=25&page=1&sparkline=false&price_change_percentage=24h');
      return coins.map((c) => ({ id: c.id, symbol: (c.symbol || '').toUpperCase(), name: c.name, price: c.current_price, changePct: c.price_change_percentage_24h ?? 0, marketCap: c.market_cap, volume: c.total_volume, high24h: c.high_24h, low24h: c.low_24h }));
    }));
  }
  if (p === '/api/news') {
    const symbol = cleanSymbol(qs.get('symbol') || 'SPY');
    return json({ symbol, items: await cached(`n:${symbol}`, 120_000, async () => {
      if (FIN) {
        const to = new Date().toISOString().slice(0, 10), from = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
        const data = await getJSON(`https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}&token=${FIN}`);
        return data.slice(0, 30).map((n) => ({ title: n.headline, source: n.source, url: n.url, time: n.datetime, summary: n.summary || '' }));
      }
      const data = await getJSON(`${YF}/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=0&newsCount=20`);
      return (data.news || []).map((n) => ({ title: n.title, source: n.publisher, url: n.link, time: n.providerPublishTime, summary: '' }));
    }) });
  }
  if (p.startsWith('/api/summary/')) {
    const symbol = cleanSymbol(p.split('/').pop());
    return json(await cached(`sum:${symbol}`, 600_000, async () => {
      const modules = 'summaryDetail,defaultKeyStatistics,financialData,price,summaryProfile,calendarEvents,earnings';
      const j = await getAuthedJSON((crumb) => `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`);
      const r = j.quoteSummary?.result?.[0];
      if (!r) throw new Error(j.quoteSummary?.error?.description || 'no fundamentals');
      const sd = r.summaryDetail || {}, ks = r.defaultKeyStatistics || {}, fd = r.financialData || {}, pr = r.price || {}, sp = r.summaryProfile || {}, ce = r.calendarEvents || {}, ea = r.earnings || {};
      return {
        symbol, name: pr.longName || pr.shortName || symbol, sector: sp.sector || '', industry: sp.industry || '', website: sp.website || '', country: sp.country || '', employees: num(sp.fullTimeEmployees), summary: sp.longBusinessSummary || '',
        marketCap: num(pr.marketCap) ?? num(sd.marketCap), peTrailing: num(sd.trailingPE), peForward: num(sd.forwardPE) ?? num(ks.forwardPE), pegRatio: num(ks.pegRatio), priceToBook: num(ks.priceToBook), eps: num(ks.trailingEps), beta: num(sd.beta) ?? num(ks.beta),
        dividendYield: num(sd.dividendYield), dividendRate: num(sd.dividendRate), payoutRatio: num(sd.payoutRatio), sharesOut: num(ks.sharesOutstanding), floatShares: num(ks.floatShares), heldPctInsiders: num(ks.heldPercentInsiders), heldPctInstitutions: num(ks.heldPercentInstitutions), shortPctFloat: num(ks.shortPercentOfFloat),
        profitMargin: num(fd.profitMargins) ?? num(ks.profitMargins), operatingMargin: num(fd.operatingMargins), grossMargin: num(fd.grossMargins), roe: num(fd.returnOnEquity), roa: num(fd.returnOnAssets), revenue: num(fd.totalRevenue), revenueGrowth: num(fd.revenueGrowth), earningsGrowth: num(fd.earningsGrowth), ebitda: num(fd.ebitda), totalCash: num(fd.totalCash), totalDebt: num(fd.totalDebt), debtToEquity: num(fd.debtToEquity), currentRatio: num(fd.currentRatio), freeCashflow: num(fd.freeCashflow),
        targetMean: num(fd.targetMeanPrice), targetHigh: num(fd.targetHighPrice), targetLow: num(fd.targetLowPrice), recommendationKey: fd.recommendationKey || '', recommendationMean: num(fd.recommendationMean), numberOfAnalysts: num(fd.numberOfAnalystOpinions),
        high52w: num(sd.fiftyTwoWeekHigh), low52w: num(sd.fiftyTwoWeekLow), avgVolume: num(sd.averageVolume),
        nextEarningsDate: (ce.earnings?.earningsDate || []).map(num).filter(Boolean)[0] || null,
        earningsQuarterly: (ea.earningsChart?.quarterly || []).map((q) => ({ period: q.date, actual: num(q.actual), estimate: num(q.estimate) })),
        yearly: (ea.financialsChart?.yearly || []).map((y) => ({ year: y.date, revenue: num(y.revenue), earnings: num(y.earnings) })),
      };
    }));
  }
  if (p.startsWith('/api/financials/')) {
    const symbol = cleanSymbol(p.split('/').pop());
    return json(await cached(`fin:${symbol}`, 3_600_000, async () => {
      const url2 = `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}?symbol=${encodeURIComponent(symbol)}&type=${ALL_FIN_TYPES.join(',')}&period1=1230768000&period2=2000000000&merge=false`;
      const j = await getAuthedJSON((crumb) => `${url2}&crumb=${encodeURIComponent(crumb)}`);
      const series = j.timeseries?.result || [], byType = {}, yearSet = new Set();
      for (const s of series) {
        const type = s.meta?.type?.[0];
        if (!type || !Array.isArray(s[type])) continue;
        const m = {};
        for (const pt of s[type]) { if (!pt) continue; const yr = (pt.asOfDate || '').slice(0, 4), val = pt.reportedValue?.raw; if (yr && val != null) { m[yr] = val; yearSet.add(yr); } }
        byType[type] = m;
      }
      const populated = [...yearSet].filter((y) => ALL_FIN_TYPES.some((t) => byType[t]?.[y] != null));
      const years = populated.sort().reverse().slice(0, 4);
      if (!years.length) throw new Error('no financial history available');
      const rows = (spec) => spec.map(([type, label]) => ({ label, values: years.map((y) => byType[type]?.[y] ?? null) })).filter((r) => r.values.some((v) => v != null));
      return { symbol, years, income: rows(INCOME_ROWS), balance: rows(BALANCE_ROWS), cashflow: rows(CASHFLOW_ROWS) };
    }));
  }
  if (p.startsWith('/api/profile/')) {
    const symbol = cleanSymbol(p.split('/').pop());
    return json(await cached(`p:${symbol}`, 3_600_000, async () => {
      const data = await getJSON(`${YF}/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=6&newsCount=0`);
      const hit = (data.quotes || []).find((it) => it.symbol === symbol) || (data.quotes || [])[0];
      if (!hit) return {};
      return { name: hit.longname || hit.shortname || symbol, sector: hit.sectorDisp || hit.sector || '', industry: hit.industryDisp || hit.industry || '', exchange: hit.exchDisp || hit.exchange || '', country: '', currency: '', marketCap: null, sharesOut: null, ipo: '', web: '', logo: '' };
    }));
  }
  if (p === '/api/status') return json({ ok: true, finnhub: Boolean(FIN), runtime: 'cloudflare-worker' });
  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try { return await handleApi(url, env); } catch (err) { return fail(err); }
    }
    // static assets (public/) served via the ASSETS binding
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
  },
};
