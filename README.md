<div align="center">

# 🟠 OPENTERM

### A Bloomberg-Terminal-style market terminal, powered entirely by free APIs.

Command-driven. Amber-on-black. Zero API keys required.
Type `AAPL GP` and hit `GO`.

[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-ff7a00.svg)](LICENSE)
[![Dependencies](https://img.shields.io/badge/deps-express%20%2B%20undici-informational)](package.json)
[![API Keys](https://img.shields.io/badge/API%20keys-none%20required-33dd88)](#-data-sources)
[![Build](https://img.shields.io/badge/build%20step-none-blue)](#-quick-start)

<img src="docs/screenshot-home.png" alt="OpenTerm market monitor" width="100%">

</div>

---

## ⚡ Quick start

```bash
git clone https://github.com/TheJoeKD20/bloomberg.git
cd bloomberg
npm install
npm start           # → http://localhost:8432
```

That's the whole setup. **No keys, no build step, no database.** One `npm install`
(just `express` + `undici`) and you're live.

---

## 🎯 Why

Bloomberg charges ~$32,000/yr per terminal. This is a love letter to that
interface — the amber command line, the solid-orange function bars, the
color-coded keyboard — wired up to **free market data** instead. It won't get
you Bloomberg chat or the FIGI graph, but for quotes, charts, fundamentals,
movers, FX, rates, and crypto it feels like the real thing.

It's a **command terminal, not a dashboard**: one full-screen function at a
time, driven by `SECURITY FUNCTION` strings exactly like a real `<GO>` command.

---

## ✨ Features

<table>
<tr><td width="50%" valign="top">

**📈 Securities**
- `GP` / `GIP` — hand-rolled `<canvas>` charts: candles + line, volume, crosshair OHLC, 8 ranges (1D → MAX)
- `DES` — full description & market data
- `FA` — fundamentals: valuation, margins, balance sheet, analyst price-target bar, buy/hold/sell consensus
- `ERN` — quarterly EPS surprise + annual revenue/earnings
- `CN` — company news

</td><td width="50%" valign="top">

**🌍 Market monitors**
- `WEI` — world equity indices (Americas / EMEA / Asia-Pac)
- `MOST` — movers: gainers, losers, most active
- `CMDTY` — energy, metals, agriculture
- `GOVT` — US Treasury yields & futures
- `FX` — ECB reference currency rates
- `CRYP` — top-25 crypto board
- `W` — persistent watchlist

</td></tr>
</table>

Plus a scrolling index tape, live news ticker, market-open indicator,
ticker autocomplete, and a fully **responsive layout that collapses cleanly
to mobile**.

<div align="center">
<img src="docs/screenshot-fundamentals.png" alt="Fundamentals (FA)" width="49%">
<img src="docs/screenshot-mobile.png" alt="Mobile view" width="24%">
</div>

---

## ⌨️ Command reference

| Command | Function |
|---|---|
| `AAPL` | Load a security (opens the price graph) |
| `AAPL DES` | Description — profile, identification, market data |
| `AAPL GP` / `GIP` | Price graph / intraday — candles, line, crosshair |
| `AAPL FA` | Fundamentals — valuation, margins, targets, ratings |
| `AAPL ERN` | Earnings — quarterly surprise & annual trend |
| `AAPL CN` | Company news |
| `WEI` | World equity indices |
| `MOST` | Market movers (gainers / losers / actives) |
| `CMDTY` | Commodities board |
| `GOVT` | US Treasury yields & futures |
| `FX` | Currency rates (ECB) |
| `CRYP` | Cryptocurrency market |
| `TOP` | Top market news |
| `W` · `W ADD NVDA` · `W DEL NVDA` | Watchlist |
| `S apple` | Security finder |
| `HELP` | In-terminal command guide |

Bare function codes (`GP`, `DES`, `FA`…) re-run against the loaded security.
Symbols follow Yahoo conventions: indices `^GSPC`, FX `EURUSD=X`, futures
`GC=F`, crypto `BTC-USD`, non-US `BMW.DE` / `7203.T`.

---

## 🔌 Data sources

| Source | Powers | Cost | Key? |
|---|---|---|:--:|
| [Yahoo Finance](https://finance.yahoo.com) *(unofficial)* | Quotes, charts, search, movers, **fundamentals**, news | Free | ❌ |
| [CoinGecko](https://www.coingecko.com/en/api) | Crypto board | Free | ❌ |
| [Frankfurter / ECB](https://frankfurter.dev) | FX rates | Free | ❌ |
| [Finnhub](https://finnhub.io) *(optional)* | Richer news & profiles | Free tier (60/min) | ✅ |

Everything runs keyless. Add a **free** Finnhub key only if you want upgraded
news/profiles:

```bash
FINNHUB_API_KEY=your_key_here npm start
```

Keys stay **server-side** — the browser only ever talks to this app's own
`/api/*` endpoints. An in-memory TTL cache (10s quotes · 60s charts/movers ·
2min news · 10min fundamentals) keeps request volume well inside free limits.

<details>
<summary><b>💸 Cheap monthly upgrade paths, if you outgrow the free tiers</b></summary>

They slot into the same server-side proxy layer:

| Provider | Free tier | Paid from | Adds |
|---|---|---|---|
| **Twelve Data** | 800 req/day | ~$29/mo | WebSocket streaming |
| **Polygon.io** | End-of-day | ~$29/mo | 15-min delayed, unlimited calls |
| **Financial Modeling Prep** | 250 req/day | ~$22/mo | Deep fundamentals, earnings |
| **Finnhub** | 60 req/min | ~$50/mo | Real-time, higher limits |
| **Alpha Vantage** | 25 req/day | ~$50/mo | Broad coverage |

</details>

---

## 🏗️ Architecture

```
browser (public/)                    server.js (Express + undici)         upstream
┌──────────────────────────┐        ┌───────────────────────────┐
│ index.html               │  /api  │ /api/quote · /api/quotes  │──► Yahoo Finance
│ style.css   (Bloomberg   │ ─────► │ /api/history              │──► Yahoo Finance
│ app.js       look)       │        │ /api/summary  (crumb auth)│──► Yahoo Finance
│  • command parser        │        │ /api/movers · /api/search │──► Yahoo Finance
│  • canvas chart engine   │        │ /api/news · /api/profile  │──► Finnhub / Yahoo
│  • 13 functions          │        │ /api/fx                   │──► Frankfurter (ECB)
│  • localStorage watchlist│        │ /api/crypto               │──► CoinGecko
└──────────────────────────┘        │ + TTL cache · key hiding  │
                                     └───────────────────────────┘
```

- **No frontend dependencies** — vanilla JS/CSS, charts drawn on raw `<canvas>`.
- **No build step** — edit a file, refresh.
- Server manages Yahoo's cookie+crumb session to unlock the fundamentals feed,
  honors `HTTPS_PROXY` / `NO_PROXY`, and normalizes every source behind one API.

**Configuration**

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `8432` | HTTP port |
| `FINNHUB_API_KEY` | *(unset)* | Optional — richer news/profiles |

---

## ⚠️ Disclaimers

- Educational project. **"Bloomberg" is a trademark of Bloomberg L.P.** — this
  project is not affiliated with, endorsed by, or connected to Bloomberg.
- Yahoo Finance's endpoints are unofficial and unauthenticated; they can change
  or rate-limit without notice. Don't build anything mission-critical on them.
- Free-tier data is delayed and provided **for information only — not
  investment advice.**

---

<div align="center">

**MIT Licensed** · Built with vanilla JS and a lot of amber.

</div>
