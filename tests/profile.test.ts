import { describe, expect, it } from "vitest";
import { buildProfile, placeTrade, rankedEdges, verdictFor, welchT } from "../src/lib/profile";
import type { Analysis } from "../src/lib/analysis";
import type { Trade } from "../src/lib/types";

const an = (run15: number | null, posDir: number | null = 0.5, trend: number | null = 0.5): Analysis => ({
  ok: true, features: { run15Atr: run15, posDir, trend60Atr: trend },
} as Analysis);
const tr = (pnl: number): Trade => ({ id: String(Math.random()), symbol: "X", side: "long", openTime: "", closeTime: "", entry: 1, exit: 1, size: 1, pnl, fees: 0, tags: [] });

/** deterministic pseudo-noise so tests don't depend on Math.random */
const noise = (i: number) => ((i * 7919) % 100) / 100 - 0.5;

describe("edge profile", () => {
  it("welch t separates clearly different groups and is ~0 for identical ones", () => {
    expect(welchT([10, 11, 9, 10, 12], [0, 1, -1, 0, 1])).toBeGreaterThan(5);
    expect(welchT([1, 2, 3, 4], [1, 2, 3, 4])).toBeCloseTo(0, 9);
    expect(welchT([1], [1, 2])).toBe(0);
  });

  it("finds a real edge, labels evidence, and ignores noise", () => {
    const items: { trade: Trade; a: Analysis }[] = [];
    // momentum entries (run15 > 1.5) win ~ +50, counter-move entries (< -1) lose ~ -50, 30 each
    for (let i = 0; i < 30; i++) items.push({ trade: tr(50 + 10 * noise(i)), a: an(2) });
    for (let i = 0; i < 30; i++) items.push({ trade: tr(-50 + 10 * noise(i)), a: an(-2) });
    for (let i = 0; i < 30; i++) items.push({ trade: tr(10 * noise(i + 99)), a: an(0.3) });
    const p = buildProfile(items);
    const momentum = p.run15.find((b) => b.label === "With strong momentum")!;
    const counter = p.run15.find((b) => b.label === "Against a strong move")!;
    expect(momentum).toMatchObject({ n: 30, edge: "positive", evidence: "strong" });
    expect(counter).toMatchObject({ n: 30, edge: "negative", evidence: "strong" });
    expect(p.run15.find((b) => b.label === "Quiet market")!.edge).toBe("none");
    expect(rankedEdges(p)[0].edge).not.toBe("none");
    // verdicts follow the trader's own history, not a generic rule
    expect(verdictFor(placeTrade(an(2), p)).tone).toBe("good");
    expect(verdictFor(placeTrade(an(-2), p)).tone).toBe("warn");
    expect(verdictFor(placeTrade(an(0.3), p)).tone).toBe("neutral");
  });

  it("never calls a small sample a finding", () => {
    const items = [
      ...Array.from({ length: 5 }, () => ({ trade: tr(500), a: an(2) })),
      ...Array.from({ length: 40 }, (_, i) => ({ trade: tr(noise(i) * 10), a: an(0.3) })),
    ];
    const b = buildProfile(items).run15.find((x) => x.label === "With strong momentum")!;
    expect(b.evidence).toBe("too few");
    expect(b.edge).toBe("none");
  });

  it("skips trades with missing features or failed analysis", () => {
    const p = buildProfile([{ trade: tr(1), a: an(null, null, null) }, { trade: tr(1), a: { ok: false } as Analysis }]);
    expect(p.run15).toEqual([]);
    expect(placeTrade({ ok: false } as Analysis, p)).toEqual([]);
  });
});
