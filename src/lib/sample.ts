import type { Trade } from "./types";
import { tradeId } from "./importer";

// Small deterministic PRNG so sample data is stable.
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** ~120 realistic demo trades with deliberate bad habits baked in, so Insights has something to find. */
export function sampleTrades(): Trade[] {
  const r = rng(42);
  const symbols = [
    { s: "EURUSD", px: 1.085, tick: 0.0001, val: 10, edge: 0.0 },
    { s: "GBPUSD", px: 1.27, tick: 0.0001, val: 10, edge: -0.1 },
    { s: "XAUUSD", px: 2350, tick: 0.1, val: 1, edge: 0.12 },
    { s: "NAS100", px: 18200, tick: 1, val: 1, edge: -0.05 },
  ];
  const trades: Trade[] = [];
  const start = new Date();
  start.setDate(start.getDate() - 60);
  start.setHours(8, 0, 0, 0);
  let lastLossClose = 0;
  for (let d = 0; d < 60; d++) {
    const day = new Date(start.getTime() + d * 86400000);
    if (day.getDay() === 0 || day.getDay() === 6) continue;
    let n = 1 + Math.floor(r() * 3);
    if (r() < 0.15) n += 5 + Math.floor(r() * 4); // overtrading days
    let t = day.getTime() + Math.floor(r() * 4) * 3600000;
    let streakLoss = 0;
    for (let i = 0; i < n; i++) {
      const sym = symbols[Math.floor(r() * symbols.length)];
      const revenge = streakLoss > 0 && r() < 0.6;
      if (revenge) t = lastLossClose + (2 + Math.floor(r() * 8)) * 60000;
      else t += (20 + Math.floor(r() * 120)) * 60000;
      const hour = new Date(t).getHours();
      const size = revenge ? 1.5 + Math.round(r() * 20) / 10 : 0.5 + Math.round(r() * 5) / 10;
      const side = r() < 0.5 ? "long" : "short";
      const dir = side === "long" ? 1 : -1;
      const stopTicks = 15 + Math.floor(r() * 25);
      const hasStop = r() > 0.35;
      // win probability: baseline, hurt by revenge / late-hours, helped by symbol edge
      let pWin = 0.58 + sym.edge - (revenge ? 0.2 : 0) - (hour >= 15 ? 0.08 : 0);
      const win = r() < pWin;
      const ticks = win ? stopTicks * (0.6 + r() * 0.9) : stopTicks * (revenge || !hasStop ? 1.1 + r() * 0.8 : 0.9 + r() * 0.2);
      const entry = sym.px * (1 + (r() - 0.5) * 0.02);
      const exit = entry + dir * (win ? 1 : -1) * ticks * sym.tick;
      const hold = win ? 8 + r() * 25 : 15 + r() * 70;
      const open = new Date(t), close = new Date(t + hold * 60000);
      const fees = Math.round(size * 7 * 100) / 100;
      const gross = (win ? 1 : -1) * ticks * sym.val * size * 0.35; // scaled to keep demo equity realistic
      const base = {
        symbol: sym.s, openTime: open.toISOString(), closeTime: close.toISOString(),
        entry: +entry.toFixed(5), size, pnl: Math.round((gross - fees) * 100) / 100,
      };
      trades.push({
        id: tradeId(base), ...base, side, exit: +exit.toFixed(5), fees,
        stopLoss: hasStop ? +(entry - dir * stopTicks * sym.tick).toFixed(5) : undefined,
        setup: ["Breakout", "Pullback", "Range fade", "News"][Math.floor(r() * (revenge ? 4 : 3))],
        tags: revenge ? ["Revenge trade"] : !hasStop && !win ? ["No stop loss"] : [],
        emotion: revenge ? "Angry" : undefined,
      });
      t = close.getTime();
      if (!win) { streakLoss++; lastLossClose = close.getTime(); } else streakLoss = 0;
    }
  }
  return trades;
}
