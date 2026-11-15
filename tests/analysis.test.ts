import { describe, expect, it } from "vitest";
import { aggregate, analyzeTrade, atr, toM5, walk } from "../src/lib/analysis";
import type { CandleRow } from "../src/lib/chart";
import type { Trade } from "../src/lib/types";

const T0 = 1_800_000_000 - (1_800_000_000 % 300); // aligned to M5
const iso = (s: number) => new Date(s * 1000).toISOString();

/** M1 candles: `n` flat-ish bars of range 1.0 around `price` (ATR on M5 ~ 1.0-ish), starting at t. */
function flat(t: number, n: number, price = 100, range = 1): CandleRow[] {
  return Array.from({ length: n }, (_, i) => [t + i * 60, price, price + range / 2, price - range / 2, price] as CandleRow);
}
const bar = (t: number, o: number, h: number, l: number, c: number): CandleRow => [t, o, h, l, c];

const trade = (o: Partial<Trade>): Trade => ({
  id: "t", symbol: "X", side: "long", openTime: iso(T0 + 3600), closeTime: iso(T0 + 3600 + 600), entry: 100, exit: 100,
  size: 1, pnl: 0, fees: 0, tags: [], ...o,
});

describe("helpers", () => {
  it("aggregates M1 into M5 and computes ATR", () => {
    const m5 = toM5(flat(T0, 30).map(([t, o, h, l, c]) => ({ t, o, h, l, c })));
    expect(m5).toHaveLength(6);
    expect(m5[0]).toMatchObject({ t: T0, h: 100.5, l: 99.5 });
    expect(atr(m5, 14)).toBeNull(); // not enough bars
    const many = toM5(flat(T0, 5 * 20).map(([t, o, h, l, c]) => ({ t, o, h, l, c })));
    expect(atr(many, 14)).toBeCloseTo(1, 5);
  });

  it("walk: stop wins a tie, target hit, break-even, gap fills", () => {
    const b = (t: number, o: number, h: number, l: number, c: number) => ({ t, o, h, l, c });
    // same bar touches both stop (98) and target (104): stop first
    expect(walk([b(1, 100, 105, 97, 101)], 1, 100, 100, { sl: 98, tp: 104 })).toMatchObject({ move: -2, reason: "stop hit" });
    // target hit
    expect(walk([b(1, 100, 105, 99.5, 104)], 1, 100, 100, { sl: 98, tp: 104 })).toMatchObject({ move: 4, reason: "target hit" });
    // break-even: +1R then back to entry
    const be = walk([b(1, 100, 103, 99.5, 102), b(2, 102, 102.5, 99.9, 100)], 1, 100, 99, { sl: 98, beAt: 2 });
    expect(be).toMatchObject({ move: 0, reason: "stopped at break-even" });
    // gap through the stop fills at the open, not the stop
    expect(walk([b(1, 95, 96, 94, 95)], 1, 100, 100, { sl: 98 }).move).toBe(-5);
    // short side mirrors
    expect(walk([b(1, 100, 101, 95, 96)], -1, 100, 100, { sl: 102, tp: 96 })).toMatchObject({ move: 4, reason: "target hit" });
    // nothing hit: held to horizon price
    expect(walk([b(1, 100, 100.5, 99.5, 100)], 1, 100, 101, { sl: 98, tp: 110 })).toMatchObject({ move: 1, reason: "held to your exit" });
  });

  it("walk: trailing follows price and exits on the pullback; partial banks half", () => {
    const b = (t: number, o: number, h: number, l: number, c: number) => ({ t, o, h, l, c });
    const bars = [b(1, 100, 102, 100, 102), b(2, 102, 106, 102, 106), b(3, 106, 106.5, 103.9, 104)];
    // trail starts at +2, distance 2: after bar2 sl = 104; bar3 low 103.9 -> exit at 104 (+4)
    expect(walk(bars, 1, 100, 104, { sl: 98, trailAt: 2, trailDist: 2 })).toMatchObject({ move: 4, reason: "trailing stop hit" });
    // partial: half at +2 (=+1), remainder stopped at entry (0) -> avg +1
    const p = walk([b(1, 100, 102.5, 100, 102), b(2, 102, 102, 99.8, 100)], 1, 100, 100, { sl: 98, partialAt: 2, partialPct: 0.5 });
    expect(p.move).toBeCloseTo(1, 9);
  });
});

describe("analyzeTrade", () => {
  // 2h of calm context before entry (range 1.0 => ATR ~1); the trade opens at T0+3600 at 100.
  const context = flat(T0 - 3600, 120);
  it("measures MAE/MFE, efficiency, and money per unit", () => {
    // long 100 -> exit 102 over 10 minutes; price peaked at 106, dipped to 98.5
    const tradeBars = [
      bar(T0 + 3600, 100, 100.4, 99.8, 100.2),
      bar(T0 + 3660, 100.2, 101, 98.5, 99),
      bar(T0 + 3720, 99, 103, 99, 103),
      bar(T0 + 3780, 103, 106, 102.5, 105),
      bar(T0 + 3840, 105, 105, 101.5, 102),
      ...flat(T0 + 3900, 6, 102),
    ];
    const t = trade({ exit: 102, pnl: 200, fees: 0, size: 100, closeTime: iso(T0 + 3840) });
    const a = analyzeTrade(t, [...context, ...tradeBars]);
    expect(a.ok).toBe(true);
    expect(a.valuePerUnit).toBeCloseTo(100, 6);              // 200 pnl / 2.0 move
    expect(a.mfe).toBeCloseTo(6, 6);
    expect(a.mae).toBeCloseTo(1.5, 6);
    expect(a.maePoint?.price).toBe(98.5);
    expect(a.mfePoint).toMatchObject({ price: 106, time: T0 + 3780 });
    expect(a.exitEfficiency).toBeCloseTo(2 / 6, 6);
    expect(a.mfeMoney).toBeCloseTo(600, 4);
    expect(a.atr).toBeCloseTo(1, 1);
    expect(a.findings.some((f) => /little of the move|Price kept going|Worst point/.test(f.title))).toBe(true);
    // only objective findings: never generic advice like "no stop" or "you chased"
    expect(a.findings.every((f) => !/chas|No stop|too long/i.test(f.title))).toBe(true);
    expect(a.features).toEqual({ run15Atr: expect.any(Number), posDir: expect.any(Number), trend60Atr: expect.any(Number) });
  });

  it("suggests a stop from pre-entry information only and replays alternatives", () => {
    const tradeBars = [
      bar(T0 + 3600, 100, 100.4, 99.8, 100.2),
      bar(T0 + 3660, 100.2, 101, 99.9, 100.8),
      bar(T0 + 3720, 100.8, 103.5, 100.5, 103),   // +1R and beyond (R ~ 1.25)
      bar(T0 + 3780, 103, 104, 100.2, 100.4),     // pulls back
      bar(T0 + 3840, 100.4, 100.6, 99.9, 100.1),
    ];
    const t = trade({ exit: 100.1, pnl: 10, fees: 0, size: 100, closeTime: iso(T0 + 3840) });
    const a = analyzeTrade(t, [...context, ...tradeBars]);
    expect(a.suggestion).not.toBeNull();
    const s = a.suggestion!;
    expect(s.stop).toBeLessThan(100);                          // below entry for a long
    expect(s.target).toBeCloseTo(100 + 2 * s.stopDistance, 6);
    expect(s.stopDistance).toBeGreaterThanOrEqual(a.atr! - 1e-9);
    expect(s.stopDistance).toBeLessThanOrEqual(3 * a.atr! + 1e-9);
    expect(a.sims.map((x) => x.id)).toEqual(["actual", "stop_rr2", "breakeven", "atr_trail", "partial"]);
    const partial = a.sims.find((x) => x.id === "partial")!;
    expect(partial.pnl!).toBeGreaterThan(a.sims[0].pnl!);      // banking half at +1R beats the 0.1 you made
    expect(a.bestSim).not.toBeNull();
    // look-ahead guard: changing candles AFTER entry must not change the suggested stop
    const changed = analyzeTrade(t, [...context, ...tradeBars.map((b) => bar(b[0], b[1] + 5, b[2] + 5, b[3] - 5, b[4] + 5))]);
    expect(changed.suggestion!.stop).toBe(s.stop);
  });

  it("works for shorts", () => {
    const tradeBars = [bar(T0 + 3600, 100, 100.3, 99.7, 99.8), bar(T0 + 3660, 99.8, 100, 96, 96.5), bar(T0 + 3720, 96.5, 97.5, 96.2, 97)];
    const t = trade({ side: "short", exit: 97, pnl: 300, size: 100, closeTime: iso(T0 + 3720) });
    const a = analyzeTrade(t, [...context, ...tradeBars]);
    expect(a.dir).toBe(-1);
    expect(a.mfe).toBeCloseTo(4, 6);                           // 100 -> 96
    expect(a.mfePoint?.price).toBe(96);
    expect(a.suggestion!.stop).toBeGreaterThan(100);            // above entry for a short
    expect(a.suggestion!.target).toBeLessThan(100);
  });

  it("degrades gracefully", () => {
    expect(analyzeTrade(trade({ entry: 0 }), flat(T0, 10)).ok).toBe(false);
    expect(analyzeTrade(trade({ exit: 102 }), []).ok).toBe(false);
    // not enough history for ATR: still reports excursions, no suggestion
    const a = analyzeTrade(trade({ exit: 101, pnl: 50 }), [...flat(T0 + 3000, 12), ...flat(T0 + 3600, 12)]);
    expect(a.ok).toBe(true);
    expect(a.suggestion).toBeNull();
  });

  it("aggregates rules across trades", () => {
    const mkItem = (pnlSim: number, pnl: number) => ({
      trade: trade({ pnl }),
      a: { ...analyzeTrade(trade({ exit: 102, pnl: 200, size: 100, closeTime: iso(T0 + 3840) }), [...context, bar(T0 + 3660, 100, 103, 99.5, 102), bar(T0 + 3840, 102, 102, 101, 102)]),
           sims: [{ id: "actual" as const, label: "a", move: 0, exitTime: 0, reason: "", pnl, r: 0 }, { id: "partial" as const, label: "p", move: 0, exitTime: 0, reason: "", pnl: pnlSim, r: 0 }] },
    });
    const g = aggregate([mkItem(50, 10), mkItem(-20, -30)]);
    expect(g.analysed).toBe(2);
    expect(g.actualPnl).toBe(-20);
    expect(g.rules[0]).toMatchObject({ id: "partial", pnl: 30, vsActual: 50, betterTrades: 2 });
  });
});
