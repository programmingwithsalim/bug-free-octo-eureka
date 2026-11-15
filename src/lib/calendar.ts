import { dayKey } from "./analytics";
import type { Trade } from "./types";

export interface DayCell { key: string; day: number; inMonth: boolean; pnl: number; count: number; wins: number; trades: Trade[] }
export interface Week { days: DayCell[]; pnl: number; count: number }
export interface MonthSummary { pnl: number; count: number; wins: number; tradingDays: number; greenDays: number; bestDay?: DayCell; worstDay?: DayCell }

const localKey = (y: number, m: number, d: number) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** Weeks (Mon-Sun) covering the month, each day carrying that day's closed-trade P&L. */
export function monthGrid(trades: Trade[], year: number, month: number) {
  const byDay = new Map<string, Trade[]>();
  for (const t of trades) {
    const k = dayKey(t.closeTime);
    (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(t);
  }
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7; // Monday = 0
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const total = Math.ceil((lead + daysInMonth) / 7) * 7;
  const weeks: Week[] = [];
  for (let i = 0; i < total; i += 7) {
    const days: DayCell[] = [];
    for (let j = i; j < i + 7; j++) {
      const d = new Date(year, month, 1 - lead + j);
      const k = localKey(d.getFullYear(), d.getMonth(), d.getDate());
      const inMonth = d.getMonth() === month;
      const ts = inMonth ? byDay.get(k) ?? [] : []; // neighbouring-month days stay blank so totals match what is shown
      days.push({
        key: k, day: d.getDate(), inMonth, trades: ts, count: ts.length,
        pnl: Math.round(ts.reduce((s, t) => s + t.pnl, 0) * 100) / 100, wins: ts.filter((t) => t.pnl > 0).length,
      });
    }
    const inM = days.filter((d) => d.inMonth);
    weeks.push({ days, pnl: Math.round(inM.reduce((s, d) => s + d.pnl, 0) * 100) / 100, count: inM.reduce((s, d) => s + d.count, 0) });
  }
  return weeks;
}

export function summarize(weeks: Week[]): MonthSummary {
  const traded = weeks.flatMap((w) => w.days).filter((d) => d.inMonth && d.count);
  const sorted = [...traded].sort((a, b) => a.pnl - b.pnl);
  return {
    pnl: Math.round(traded.reduce((s, d) => s + d.pnl, 0) * 100) / 100,
    count: traded.reduce((s, d) => s + d.count, 0),
    wins: traded.reduce((s, d) => s + d.wins, 0),
    tradingDays: traded.length,
    greenDays: traded.filter((d) => d.pnl > 0).length,
    bestDay: sorted.length ? sorted[sorted.length - 1] : undefined,
    worstDay: sorted[0],
  };
}
