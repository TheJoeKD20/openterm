# OpenTerm — a Bloomberg-terminal-style market dashboard

A self-hosted, command-driven market terminal inspired by the Bloomberg Terminal,
built entirely on **free (or optionally cheap) market-data APIs**. Type
`AAPL GP` and hit Enter — your `<GO>` key.

![screens: GP price graph, DES description, N news, FX board, CRYP board]

## Quick start

```bash
npm install
npm start
# open http://localhost:8432
```

That's it — **no API keys required** for the default setup.

## Commands

| Command | Action |
|---|---|
| `AAPL` | Load a security (defaults to the price graph) |
| `AAPL GP` | Price graph — candlesticks/line, ranges 1D → MAX, crosshair OHLC readout |
| `AAPL DES` | Security description & key price data |
| `AAPL N` | Company news headlines |
| `GP` / `DES` / `N` | Switch function for the currently loaded security |
| `FX` | Currency board (ECB reference rates) |
| `CRYP` | Top-20 crypto market board |
| `S apple` | Security finder — search by company name or ticker |
| `W` | Refresh the watchlist |
| `W ADD NVDA` / `W DEL NVDA` | Manage the watchlist (persisted in your browser) |
| `HELP` | Command guide |

Symbols follow Yahoo conventions: indices `^GSPC`, FX pairs `EURUSD=X`,
futures `GC=F`, crypto `BTC-USD`, non-US listings `BMW.DE`, `7203.T`.

There's also an always-on index tape (S&P 500, Nasdaq, Dow, VIX, US 10Y, gold,
WTI, BTC, EURUSD), a live watchlist sidebar, and a top-news sidebar. Quotes
auto-refresh every 15s, the watchlist and tape every 30s.

## Data sources

| Source | Used for | Cost | Key needed? |
|---|---|---|---|
| [Yahoo Finance](https://finance.yahoo.com) (unofficial API) | Quotes, OHLC history, search, news fallback | Free | No |
| [CoinGecko](https://www.coingecko.com/en/api) | Crypto board | Free (public tier) | No |
| [Frankfurter](https://frankfurter.dev) (ECB rates) | FX board | Free | No |
| [Finnhub](https://finnhub.io) *(optional)* | Better company news & profiles | Free tier: 60 calls/min | Yes |

### Optional: add a Finnhub key

The terminal works fully without keys. If you want richer company news and
profile data (market cap, shares outstanding, IPO date, website):

1. Get a free key at [finnhub.io](https://finnhub.io) (60 API calls/min on the free tier).
2. Copy `.env.example` to set it, or just export it:

```bash
FINNHUB_API_KEY=your_key_here npm start
```

Keys stay server-side — the browser only ever talks to this app's own `/api/*`
endpoints, and an in-memory TTL cache (10s quotes / 60s charts / 2min news)
keeps request volume well inside free-tier limits.

### If you outgrow the free tiers

Good "cheap monthly" upgrade paths that slot into the same proxy layer:

- **Finnhub** — free 60 calls/min covers a lot; paid from ~$50/mo for more.
- **Twelve Data** — free 800 credits/day; paid from ~$29/mo, WebSocket streaming.
- **Polygon.io** — free end-of-day tier; from ~$29/mo for 15-min-delayed, unlimited calls.
- **Financial Modeling Prep** — free 250 req/day; from ~$22/mo, adds fundamentals/earnings.
- **Alpha Vantage** — free 25 req/day; ~$50/mo premium.

## Architecture

```
browser (public/)                 server.js (Express)          upstream APIs
┌───────────────────────┐        ┌────────────────────┐
│ index.html            │  /api  │ /api/quote/:sym    │──► Yahoo Finance
│ style.css  (terminal  │ ─────► │ /api/quotes?…      │──► Yahoo Finance
│ app.js      look)     │        │ /api/history/:sym  │──► Yahoo Finance
│  - command parser     │        │ /api/search?q=     │──► Yahoo Finance
│  - canvas chart engine│        │ /api/news?symbol=  │──► Finnhub or Yahoo
│  - watchlist (local-  │        │ /api/profile/:sym  │──► Finnhub or Yahoo
│    Storage)           │        │ /api/fx            │──► Frankfurter (ECB)
└───────────────────────┘        │ /api/crypto        │──► CoinGecko
                                 │ + TTL cache, keys  │
                                 └────────────────────┘
```

- **Zero build step** — vanilla JS/CSS, one `npm install` (express + undici).
- **Charts** are drawn on a raw `<canvas>` (candles, volume, crosshair, prev-close
  line) — no charting library.
- The server honors `HTTPS_PROXY`/`NO_PROXY` if set.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `8432` | HTTP port |
| `FINNHUB_API_KEY` | *(unset)* | Optional — richer news/profiles |

## Disclaimers

- This is an educational project. "Bloomberg" is a trademark of Bloomberg L.P.;
  this project is not affiliated with or endorsed by Bloomberg.
- The Yahoo Finance endpoints are unofficial and unauthenticated; they can
  change or rate-limit without notice. Don't build anything critical on them.
- Free-tier data is delayed and for information only — not investment advice.
