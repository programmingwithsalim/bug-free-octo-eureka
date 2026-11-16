# Trade Journal (local, MT5 / Exness)

Journal every trade, see your stats, and get plain-English feedback on the mistakes costing you money.
Runs entirely on this PC and pulls your closed trades straight from MetaTrader 5.

- **Dashboard** – net P&L, win rate, profit factor, expectancy, drawdown, R-multiples, equity curve, P&L by day/weekday/hour/symbol.
- **Journal** – add/edit trades with setup, emotion, execution rating, mistake tags, notes and chart link.
- **Insights** – rule-based coach: revenge trading, sizing up after losses, overtrading, holding losers too long, missing stops, bad hours/days/symbols, fee drag and more.
- **MT5 sync** – the *Sync MT5* button (and an automatic sync on open and every 5 min) reads closed deals from your running terminal. Re-syncing never overwrites your notes, tags or ratings.
- **CSV import** – still available for other brokers / old history.

## Storage (Postgres)
Run once: `npm run db:setup -- --password <your postgres password>` (creates the `trade_journal` database and tables, writes the connection string to the git-ignored `.env.local`), then restart `npm run dev`. The first start imports an existing `data/journal.json` (left in place as a backup). Without `.env.local` the app keeps using `data/*.json`.
Stored in Postgres: trades + journal notes, account, cached MT5 candles, and per-trade analyses. The Bot's files (`bot-*.json`) stay in `data/`. The password is never committed.

## Hindsight: "how could this trade have been taken?"
Click a trade (Journal/Calendar) for a slide-over with the chart (best/worst point markers), measured stats (worst/best point, % of the move captured, what happened after exit) and:
- **Your record on trades like this**: entries are grouped by what was knowable at entry (momentum into the entry, position in the last hour's range, trend alignment) and compared with *your own* results, with an evidence label (strong/moderate/weak/too few). Advice is derived from your data, not generic rules.
- **Management what-ifs**: stop + 2R target, break-even, ATR trail, partial exit replayed on the real candles, always shown next to their effect across all your trades.
The **Insights** page shows the same edge profile for all trades. Analyses run automatically (MT5 must be open the first time) and are stored.

## Signals
The **Signals** tab scores the live market (the symbols you trade most) against your own edge profile: for a hypothetical long and short *right now* it shows whether that kind of entry (momentum, range position, trend over the last hour) has worked, not worked, or has no clear record in your history, with the evidence label. It refreshes every 30 s while open, flags stale data when the market is closed, and needs MT5 open plus enough analysed trades. It only alerts; it never opens trades.

## Trade charts
Click any trade (Journal or Calendar) to see its candlestick chart straight from MT5 history: entry/exit markers, entry/exit/SL/TP lines, switchable timeframe (M1-H1). The window and timeframe are chosen automatically from how long the trade lasted. Candles for finished windows are cached in `data/candles/`, so charts keep working later even with MT5 closed. Needs the terminal open the first time a chart is viewed. Broker time is assumed UTC (Exness).

## Trade Manager (the **Bot** tab)
Manages trades **you** open - it **never opens a trade**. Configure it in the Bot tab:
- **Break-even**, **trailing stop** (fixed distance or ATR), **partial take-profits** (multi-level), **auto stops** for trades that have none, and a **daily loss limit** (log only, or close everything).
- Distances in `price`, `pips`, `points` or `R` (multiples of the trade's initial stop).
- **Modes:** *Off* (nothing touched) → *Dry run* (every action is validated with MT5's `order_check` and logged, nothing sent) → *Live*. It starts Off; use Dry run first.
- Safety: stops only ever tighten, a partial can never close the whole position, every order is tied to an existing position, broker minimum stop distance is respected, failed orders back off for 30 s, and by default only manual trades (magic 0) are touched.
- Start/stop the background service from the tab. It keeps running if the web page is closed; stop it there (or end `trade_manager.py`) when you're done. MT5 must stay open and logged in.
- Files in `data/`: `bot-config.json`, `bot-status.json`, `bot-log.jsonl`, `bot-state.json`.

## How it works
- Your journal is stored in `data/journal.json` on this PC (git-ignored). Browser localStorage is only a fallback/mirror; an existing browser journal is migrated to the file on first run.
- `mt5-bridge/mt5_export.py` uses the official `MetaTrader5` Python package to attach to the **already logged-in** terminal. **No password or API key is ever read or stored.**
- The server only answers to `localhost`/`127.0.0.1` (the `dev`/`start` scripts bind to 127.0.0.1) because the API can read/write the journal and run Python.

## Setup
1. Install Python 3 and the bridge dependency: `pip install MetaTrader5` (Windows only).
2. Open **MetaTrader 5**, log in to your Exness account (tick *Save password* so it reconnects), and leave it running.
3. `npm install`, then `npm run dev` → http://localhost:3000 and press **Sync MT5**.

Notes
- First sync reads the last 90 days (`/api/mt5/sync?days=3650` for more). The starting balance is inferred from deposits/withdrawals; fix it in Settings if it looks off.
- Amounts are in your account currency (e.g. GHS, or USC on cent accounts).
- Broker time is assumed UTC (Exness). For another broker, pass `--tz-offset <hours>` in `src/lib/server.ts`.
- Env: `PYTHON` (interpreter, default `python`), `JOURNAL_DATA_DIR` (default `./data`).
- Only fully closed positions are imported; partial closes are merged into one trade once the position is flat.

## Tests
    npm test        # TypeScript
    npm run test:py # MT5 deal pairing
