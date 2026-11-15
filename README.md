# Trade Journal

Journal every trade, see your stats, and get plain-English feedback on the mistakes costing you money.

- **Dashboard** – net P&L, win rate, profit factor, expectancy, drawdown, R-multiples, equity curve, P&L by day/weekday/hour/symbol.
- **Journal** – add/edit trades with setup, emotion, execution rating, mistake tags, notes and chart link.
- **Insights** – rule-based coach: revenge trading, sizing up after losses, overtrading, holding losers too long, small-wins/big-losses, missing stops, outlier losses, bad hours/days/symbols, fee drag, emotion costs, plus your strengths.
- **Import** – CSV from MT4/MT5 and most brokers (auto column mapping, duplicates ignored). Demo data included.
- **Privacy** – no logins, no broker credentials. Data stays in your browser's localStorage; back up/restore from Settings.

## Run locally
    npm install
    npm run dev        # http://localhost:3000
    npm test

## Deploy to Vercel
1. Push this folder to a GitHub repo.
2. vercel.com → Add New → Project → import the repo. Framework is auto-detected (Next.js); no env vars needed.
3. Deploy. Open the URL any time.

Or with the CLI: `npx vercel --prod`.

Because data is per-browser, use Settings → *Download backup* to move it between devices.
