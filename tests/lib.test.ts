import { describe, expect, it } from "vitest";
import { computeStats, riskAmount, rMultiple } from "../src/lib/analytics";
import { generateInsights } from "../src/lib/insights";
import { autoMap, mergeTrades, parseCsv, parseDate, parseNumber, rowsToTrades } from "../src/lib/importer";
import { sampleTrades } from "../src/lib/sample";
import type { Trade } from "../src/lib/types";

const mk = (o: Partial<Trade>): Trade => ({
  id: Math.random().toString(36), symbol: "EURUSD", side: "long",
  openTime: "2024-01-02T10:00:00Z", closeTime: "2024-01-02T10:30:00Z",
  entry: 1, exit: 1.01, size: 1, pnl: 100, fees: 0, tags: [], ...o,
});

describe("stats", () => {
  it("computes win rate, PF, drawdown", () => {
    const ts = [
      mk({ pnl: 100, closeTime: "2024-01-02T10:00:00Z" }),
      mk({ pnl: -50, closeTime: "2024-01-02T11:00:00Z" }),
      mk({ pnl: -50, closeTime: "2024-01-02T12:00:00Z" }),
      mk({ pnl: 200, closeTime: "2024-01-02T13:00:00Z" }),
    ];
    const s = computeStats(ts, 1000);
    expect(s.winRate).toBe(0.5);
    expect(s.profitFactor).toBe(3);
    expect(s.netPnl).toBe(200);
    expect(s.maxDrawdown).toBe(100);
    expect(s.maxConsecLosses).toBe(2);
  });
  it("derives R multiple from stop distance", () => {
    // long 1.0000 -> 1.0100 made $100 gross => $10,000 per 1.0; stop 0.005 away => $50 risk
    const t = mk({ entry: 1, exit: 1.01, pnl: 100, stopLoss: 0.995 });
    expect(riskAmount(t)).toBeCloseTo(50);
    expect(rMultiple(t)).toBeCloseTo(2);
  });
});

describe("import", () => {
  it("parses numbers and dates", () => {
    expect(parseNumber("$1,234.50")).toBe(1234.5);
    expect(parseNumber("(45.2)")).toBe(-45.2);
    expect(parseNumber("1.234,56")).toBe(1234.56);
    expect(parseDate("2024.03.05 14:30:10")?.getUTCHours()).toBe(14);
    expect(parseDate("13/02/2024 09:00")?.getUTCMonth()).toBe(1);
  });
  it("maps MT4-style export with duplicate Time/Price columns", () => {
    const csv = `Ticket,Open Time,Type,Size,Item,Price,S / L,T / P,Close Time,Price,Commission,Swap,Profit
1,2024.01.02 10:00:00,buy,0.10,eurusd,1.1000,1.0950,1.1100,2024.01.02 11:00:00,1.1050,-0.70,0,50.00
2,2024.01.02 12:00:00,balance,,,,,,2024.01.02 12:00:00,,0,0,1000`;
    const { headers, rows } = parseCsv(csv);
    const map = autoMap(headers);
    expect(map.openTime).toBe("Open Time");
    expect(map.closeTime).toBe("Close Time");
    expect(map.entry).toBe("Price");
    expect(map.exit).toBe("Price (2)");
    const res = rowsToTrades(rows, map);
    expect(res.trades).toHaveLength(1);
    expect(res.skipped).toHaveLength(1);
    expect(res.trades[0].pnl).toBeCloseTo(49.3);
    expect(res.trades[0].stopLoss).toBe(1.095);
    const again = mergeTrades(res.trades, res.trades);
    expect(again.added).toBe(0);
  });
});

describe("insights", () => {
  it("asks for more data on tiny samples", () => {
    expect(generateInsights([mk({})])[0].id).toBe("need-data");
  });
  it("detects bad habits in the demo data", () => {
    const ids = generateInsights(sampleTrades()).map((i) => i.id);
    console.log(ids.join(", "));
    expect(ids.length).toBeGreaterThan(2);
    expect(ids).toContain("revenge");
  });
  it("flags losers held longer than winners", () => {
    const ts: Trade[] = [];
    for (let i = 0; i < 8; i++) {
      const o = Date.UTC(2024, 0, 2 + i, 10);
      ts.push(mk({ pnl: 50, openTime: new Date(o).toISOString(), closeTime: new Date(o + 10 * 60000).toISOString() }));
      ts.push(mk({ pnl: -50, openTime: new Date(o + 3600000).toISOString(), closeTime: new Date(o + 3600000 + 90 * 60000).toISOString() }));
    }
    expect(generateInsights(ts).map((i) => i.id)).toContain("hold-losers");
  });
});

import { applyMt5Account, inferStartingBalance, mergeMt5 } from "../src/lib/mt5";
import { monthGrid, summarize } from "../src/lib/calendar";
import { DEFAULT_BOT_CONFIG, sanitizeBotConfig } from "../src/lib/bot";
import { chartWindow, chooseTf, snapToCandle, validateCandleRequest } from "../src/lib/chart";

describe("trade chart helpers", () => {
  const T = (s: string) => +new Date(s);
  it("pads by the trade length (min 1h) and picks a readable timeframe", () => {
    const short = chartWindow(T("2026-09-14T10:00:00Z"), T("2026-09-14T10:05:00Z"));
    expect(short.to - short.from).toBe(5 * 60 + 2 * 3600); // 5 min + 1h each side
    expect(chooseTf(short.from, short.to)).toBe("M1"); // 125 min -> 125 one-minute bars
    const long = chartWindow(T("2026-09-14T10:00:00Z"), T("2026-09-14T22:00:00Z"));
    expect(chooseTf(long.from, long.to)).toBe("M15"); // 36h -> 144 M15 bars
    expect(chooseTf(0, 400 * 86400)).toBe("H4"); // never returns undefined
  });
  it("snaps marker times to the candle that contains them", () => {
    expect(snapToCandle(1789376400 + 123, "M5")).toBe(1789376400);
    expect(snapToCandle(1789376400 + 299, "M5")).toBe(1789376400);
    expect(snapToCandle(1789376400 + 300, "M5")).toBe(1789376700);
  });
  it("validates candle requests", () => {
    expect(validateCandleRequest("XAUUSDm", "M5", 1000, 5000)).toBeNull();
    expect(validateCandleRequest("X; rm -rf /", "M5", 1000, 5000)).toBe("bad symbol");
    expect(validateCandleRequest("XAUUSDm", "M7", 1000, 5000)).toBe("bad timeframe");
    expect(validateCandleRequest("XAUUSDm", "M5", 5000, 1000)).toBe("bad time window");
    expect(validateCandleRequest("XAUUSDm", "M1", 0, 30 * 86400)).toBe("window too large");
    expect(validateCandleRequest("XAUUSDm", "M1", 0, 13 * 86400)).toBe("too many candles; pick a larger timeframe");
  });
});

describe("bot config", () => {
  it("defaults to OFF + dry run, and garbage falls back safely", () => {
    expect(DEFAULT_BOT_CONFIG).toMatchObject({ enabled: false, dryRun: true });
    expect(sanitizeBotConfig(null)).toEqual(DEFAULT_BOT_CONFIG);
    expect(sanitizeBotConfig("x")).toEqual(DEFAULT_BOT_CONFIG);
    const c = sanitizeBotConfig({ enabled: "yes", dryRun: 0, trailing: { enabled: true, mode: "wild", start: { value: "abc", unit: "lightyears" } } });
    expect(c.enabled).toBe(false);
    expect(c.dryRun).toBe(true); // a non-boolean never turns dry run off
    expect(c.trailing).toMatchObject({ enabled: true, mode: "fixed", start: { value: 1, unit: "r" } });
  });
  it("coerces numbers, clamps ranges, and never allows a 100% partial", () => {
    const c = sanitizeBotConfig({
      pollSeconds: 0, dailyLoss: { enabled: true, limit: "25.5", action: "nuke" },
      partials: { enabled: true, levels: [{ at: { value: "2", unit: "pips" }, closePct: 100 }, { at: { value: -5, unit: "price" }, closePct: 0 }] },
      scope: { symbols: [" xauusdm ", "", 5] },
    });
    expect(c.pollSeconds).toBe(0.5);
    expect(c.dailyLoss).toEqual({ enabled: true, limit: 25.5, action: "alert" });
    expect(c.partials.levels.map((l) => l.closePct)).toEqual([99, 1]);
    expect(c.partials.levels[0].at).toEqual({ value: 2, unit: "pips" });
    expect(c.partials.levels[1].at.value).toBe(0); // negatives clamp to 0
    expect(c.scope.symbols).toEqual(["xauusdm"]);
  });
  it("round-trips a valid config unchanged", () => {
    const c = sanitizeBotConfig({ ...DEFAULT_BOT_CONFIG, enabled: true, dryRun: false, breakEven: { ...DEFAULT_BOT_CONFIG.breakEven, enabled: true } });
    expect(sanitizeBotConfig(JSON.parse(JSON.stringify(c)))).toEqual(c);
  });
});

describe("calendar", () => {
  it("lays out Mon-Sun weeks with daily P&L and week totals", () => {
    // Nov 2026: 1st is a Sunday -> 6 leading days from October
    const ts = [mk({ pnl: 100, closeTime: "2026-11-02T10:00:00" }), mk({ pnl: -30, closeTime: "2026-11-02T12:00:00" }), mk({ pnl: 50, closeTime: "2026-11-13T09:00:00" }), mk({ pnl: 999, closeTime: "2026-10-30T09:00:00" })];
    const weeks = monthGrid(ts, 2026, 10);
    expect(weeks.every((w) => w.days.length === 7)).toBe(true);
    expect(weeks[0].days[6]).toMatchObject({ key: "2026-11-01", inMonth: true });
    const mon = weeks[1].days[0];
    expect(mon).toMatchObject({ key: "2026-11-02", pnl: 70, count: 2, wins: 1 });
    expect(weeks[1].pnl).toBe(70);
    expect(weeks[0].pnl).toBe(0); // out-of-month Oct 30 trade not counted
    const s = summarize(weeks);
    expect(s).toMatchObject({ pnl: 120, count: 3, tradingDays: 2, greenDays: 2 });
    expect(s.bestDay?.key).toBe("2026-11-02");
  });
});

describe("starting balance", () => {
  it("backs out P&L and deposits, falls back if it would go negative", () => {
    expect(inferStartingBalance(1000, [{ pnl: 300 }, { pnl: -100 }], 500)).toBe(300);
    expect(inferStartingBalance(71.32, [{ pnl: 811 }], 0)).toBe(71.32);
    // whole account history in window: balance - pnl - deposits = 0 -> first deposit
    expect(inferStartingBalance(71.32, [{ pnl: 811.25 }], -739.93, 300)).toBe(300);
  });
});

describe("mt5 merge", () => {
  const inc = (o: any = {}) => ({ id: "mt5-1", symbol: "XAUUSDm", side: "long" as const, openTime: "2024-01-02T10:00:00Z", closeTime: "2024-01-02T11:00:00Z", entry: 2000, exit: 2010, size: 0.1, pnl: 99, fees: 1, stopLoss: null, takeProfit: null, tags: [], ...o });
  it("adds new trades and keeps journal fields on re-sync", () => {
    const first = mergeMt5([], [inc()]);
    expect(first).toMatchObject({ added: 1, updated: 0 });
    const journaled = { ...first.trades[0], notes: "A+ setup", tags: ["Good execution"], rating: 5 };
    const again = mergeMt5([journaled], [inc({ pnl: 95, stopLoss: 1990 })]);
    expect(again).toMatchObject({ added: 0, updated: 1 });
    expect(again.trades[0]).toMatchObject({ pnl: 95, stopLoss: 1990, notes: "A+ setup", rating: 5, tags: ["Good execution"] });
    expect(mergeMt5(again.trades, [inc({ pnl: 95, stopLoss: 1990 })]).updated).toBe(0);
  });
  it("fills broker/currency but keeps a custom account name", () => {
    const m = { login: 123, server: "Exness-MT5Real", company: "Exness Technologies Ltd", currency: "USD", balance: 1, leverage: 500 };
    expect(applyMt5Account({ name: "Main account", broker: "", currency: "EUR", startingBalance: 1 }, m).name).toBe("Exness Technologies Ltd #123");
    expect(applyMt5Account({ name: "Scalp", broker: "", currency: "EUR", startingBalance: 1 }, m)).toMatchObject({ name: "Scalp", currency: "USD" });
  });
});
