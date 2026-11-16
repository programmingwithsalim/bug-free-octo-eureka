# Trade Journal (local, MT5 / Exness)

Journal every trade, see your stats, and get plain-English feedback on the mistakes costing you money.
Runs entirely on this PC and pulls your closed trades straight from MetaTrader 5.

- **Dashboard** – net P&L, win rate, profit factor, expectancy, drawdown, R-multiples, equity curve, P&L by day/weekday/hour/symbol.
- **Journal** – add/edit trades with setup, emotion, execution rating, mistake tags, notes and chart link.
- **Insights** – rule-based coach: revenge trading, sizing up after losses, overtrading, holding losers too long, missing stops, bad hours/days/symbols, fee drag and more.
- **MT5 sync** – the *Sync MT5* button (and an automatic sync on open and every 5 min) reads closed deals from your running terminal. Re-syncing never overwrites your notes, tags or ratings.
- **CSV import** – still available for other brokers / old history.

## Signals and alerts (the **Signals** tab)
A background service watches gold on MT5 and **alerts you with the page closed**: Windows desktop notification, sound, and optional Telegram (phone). Start it once from the tab (**Start alerts**); it keeps running until you stop it. MT5 must stay open and logged in, and the PC on.

Method (top-down): **H4 + H1 decide bias and regime first; entries are M15 only.**
- *Trending* (H4/H1 agree): only setups with the bias, targeted at the nearest key level (previous day/week high/low, Asia range, H1 swing). H4/H1 in conflict: stand aside.
- *Ranging/consolidating*: scalps only, from the range edge back toward the middle; no breakout trades.
- Setups: liquidity sweeps (+ structure shift), double top/bottom, head & shoulders (and inverse), trendline bounce/break, range-edge scalp, news sweep-and-reclaim; candlestick confirmation (engulfing, pin bar, stars). Signals only fire on **closed** candles (no repainting) and always list their reasons.
- Daily plans at 07:00 / 12:00 UTC head for the nearer of the previous day's high/low. Also: morning read, bias-change alerts, and warnings before high-impact USD news.

**Be honest about the evidence.** Every setup is backtested on ~13 months of your M15 gold history (entry at the next candle's open, spread paid, stop wins ties, last 30% held out). A setup only alerts automatically if it passes a quality gate; the rest are "UNPROVEN" and you can switch them on yourself. In the current results only the 12:00 UTC daily plan passes (narrowly, and several variants were tried); the pattern/sweep/trendline setups averaged about 0R after costs. Every alert is also followed to its outcome so you build a real forward-test record. Decision aid, not advice.
- Run/refresh the lab from the tab (**Re-run backtest**, ~1 min) or `python mt5-bridge/run_backtest.py --data-dir data`.
- Telegram: create a bot with @BotFather, send it "hi", get your chat id from @userinfobot, paste both in the tab, Save, **Send test alert**. The token is stored only in `data/alerts-config.json` (git-ignored) and never sent back to the browser.
- News calendar: public weekly feed, cached hourly; if unreachable the service says so and runs without news awareness.

## Storage (Postgres)
Run once: `npm run db:setup -- --password <your postgres password>` (creates the `trade_journal` database and tables, writes the connection string to the git-ignored `.env.local`), then restart `npm run dev`. The first start imports an existing `data/journal.json` (left in place as a backup). Without `.env.local` the app keeps using `data/*.json`.
Stored in Postgres: trades + journal notes, account, cached MT5 candles, and per-trade analyses. The Bot's files (`bot-*.json`) stay in `data/`. The password is never committed.

## Hindsight: "how could this trade have been taken?"
Click a trade (Journal/Calendar) for a slide-over with the chart (best/worst point markers), measured stats (worst/best point, % of the move captured, what happened after exit) and:
- **Your record on trades like this**: entries are grouped by what was knowable at entry (momentum into the entry, position in the last hour's range, trend alignment) and compared with *your own* results, with an evidence label (strong/moderate/weak/too few). Advice is derived from your data, not generic rules.
- **Management what-ifs**: stop + 2R target, break-even, ATR trail, partial exit replayed on the real candles, always shown next to their effect across all your trades.
The **Insights** page shows the same edge profile for all trades. Analyses run automatically (MT5 must be open the first time) and are stored.

## Signals

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
