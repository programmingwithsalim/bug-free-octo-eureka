# Trade Journal (local, MT5 / Exness)

Journal every trade, see your stats, and get plain-English feedback on the mistakes costing you money.
Runs entirely on this PC and pulls your closed trades straight from MetaTrader 5.

- **Dashboard** – net P&L, win rate, profit factor, expectancy, drawdown, R-multiples, equity curve, P&L by day/weekday/hour/symbol.
- **Journal** – add/edit trades with setup, emotion, execution rating, mistake tags, notes and chart link.
- **Insights** – rule-based coach: revenge trading, sizing up after losses, overtrading, holding losers too long, missing stops, bad hours/days/symbols, fee drag and more.
- **MT5 sync** – the *Sync MT5* button (and an automatic sync on open and every 5 min) reads closed deals from your running terminal. Re-syncing never overwrites your notes, tags or ratings.
- **CSV import** – still available for other brokers / old history.

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
