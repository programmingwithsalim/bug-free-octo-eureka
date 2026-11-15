import type { Trade } from "./types";

export const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
export const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);

export const byClose = (trades: Trade[]) =>
  [...trades].sort((a, b) => +new Date(a.closeTime) - +new Date(b.closeTime));
export const byOpen = (trades: Trade[]) =>
  [...trades].sort((a, b) => +new Date(a.openTime) - +new Date(b.openTime));

export const holdMinutes = (t: Trade) =>
  Math.max(0, (+new Date(t.closeTime) - +new Date(t.openTime)) / 60000);

export const dayKey = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Risk in account currency, derived from stop distance and realised $/price-unit. */
export function riskAmount(t: Trade): number | undefined {
  if (t.stopLoss == null) return undefined;
  const dir = t.side === "long" ? 1 : -1;
  const move = (t.exit - t.entry) * dir;
  if (move === 0) return undefined;
  const gross = t.pnl + t.fees;
  const valuePerUnit = Math.abs(gross / move);
  if (!isFinite(valuePerUnit) || valuePerUnit === 0) return undefined;
  const risk = Math.abs(t.entry - t.stopLoss) * valuePerUnit;
  return risk > 0 ? risk : undefined;
}

export const rMultiple = (t: Trade) => {
  const r = riskAmount(t);
  return r ? t.pnl / r : undefined;
};

export interface Stats {
  count: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number; // positive number
  payoff: number; // avgWin / avgLoss
  expectancy: number;
  largestWin: number;
  largestLoss: number; // negative
  maxDrawdown: number; // positive $
  maxDrawdownPct: number;
  maxConsecLosses: number;
  maxConsecWins: number;
  avgHoldWin: number;
  avgHoldLoss: number;
  avgR?: number;
  fees: number;
}

export function computeStats(trades: Trade[], startingBalance = 0): Stats {
  const ts = byClose(trades);
  const wins = ts.filter((t) => t.pnl > 0);
  const losses = ts.filter((t) => t.pnl < 0);
  const grossProfit = sum(wins.map((t) => t.pnl));
  const grossLoss = Math.abs(sum(losses.map((t) => t.pnl)));
  const avgWin = mean(wins.map((t) => t.pnl));
  const avgLoss = Math.abs(mean(losses.map((t) => t.pnl)));

  let eq = startingBalance, peak = startingBalance, maxDd = 0, maxDdPct = 0;
  let cl = 0, cw = 0, maxCl = 0, maxCw = 0;
  for (const t of ts) {
    eq += t.pnl;
    peak = Math.max(peak, eq);
    const dd = peak - eq;
    if (dd > maxDd) maxDd = dd;
    if (peak > 0) maxDdPct = Math.max(maxDdPct, dd / peak);
    if (t.pnl < 0) { cl++; cw = 0; } else if (t.pnl > 0) { cw++; cl = 0; } else { cl = 0; cw = 0; }
    maxCl = Math.max(maxCl, cl);
    maxCw = Math.max(maxCw, cw);
  }
  const rs = ts.map(rMultiple).filter((x): x is number => x != null);
  return {
    count: ts.length,
    wins: wins.length,
    losses: losses.length,
    winRate: ts.length ? wins.length / ts.length : 0,
    netPnl: sum(ts.map((t) => t.pnl)),
    grossProfit,
    grossLoss,
    profitFactor: grossLoss ? grossProfit / grossLoss : grossProfit ? Infinity : 0,
    avgWin,
    avgLoss,
    payoff: avgLoss ? avgWin / avgLoss : 0,
    expectancy: ts.length ? sum(ts.map((t) => t.pnl)) / ts.length : 0,
    largestWin: wins.length ? Math.max(...wins.map((t) => t.pnl)) : 0,
    largestLoss: losses.length ? Math.min(...losses.map((t) => t.pnl)) : 0,
    maxDrawdown: maxDd,
    maxDrawdownPct: maxDdPct,
    maxConsecLosses: maxCl,
    maxConsecWins: maxCw,
    avgHoldWin: mean(wins.map(holdMinutes)),
    avgHoldLoss: mean(losses.map(holdMinutes)),
    avgR: rs.length ? mean(rs) : undefined,
    fees: sum(ts.map((t) => t.fees)),
  };
}

export function equityCurve(trades: Trade[], startingBalance = 0) {
  let eq = startingBalance, peak = startingBalance;
  return byClose(trades).map((t, i) => {
    eq += t.pnl;
    peak = Math.max(peak, eq);
    return { n: i + 1, date: t.closeTime, equity: round(eq), drawdown: -round(peak - eq) };
  });
}

export interface Bucket { key: string; count: number; pnl: number; winRate: number; avg: number }

export function groupBy(trades: Trade[], keyFn: (t: Trade) => string | string[]): Bucket[] {
  const m = new Map<string, Trade[]>();
  for (const t of trades) {
    const k = keyFn(t);
    for (const key of Array.isArray(k) ? k : [k]) {
      if (!key) continue;
      (m.get(key) ?? m.set(key, []).get(key)!).push(t);
    }
  }
  return [...m].map(([key, ts]) => ({
    key,
    count: ts.length,
    pnl: round(sum(ts.map((t) => t.pnl))),
    winRate: ts.filter((t) => t.pnl > 0).length / ts.length,
    avg: round(mean(ts.map((t) => t.pnl))),
  }));
}

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const bySymbol = (ts: Trade[]) => groupBy(ts, (t) => t.symbol).sort((a, b) => b.pnl - a.pnl);
export const byWeekday = (ts: Trade[]) => groupBy(ts, (t) => WEEKDAYS[new Date(t.openTime).getDay()]);
export const byHour = (ts: Trade[]) => groupBy(ts, (t) => String(new Date(t.openTime).getHours()).padStart(2, "0"));
export const bySetup = (ts: Trade[]) => groupBy(ts, (t) => t.setup?.trim() ?? "");
export const byTag = (ts: Trade[]) => groupBy(ts, (t) => t.tags);
export const byDay = (ts: Trade[]) => groupBy(ts, (t) => dayKey(t.closeTime)).sort((a, b) => a.key.localeCompare(b.key));

export const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
