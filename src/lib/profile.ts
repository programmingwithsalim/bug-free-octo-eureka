/**
 * Personal edge profile: how have YOUR trades performed, grouped by what was knowable at entry?
 *
 * Generic trading rules can be wrong for a given style (a momentum trader is hurt by "wait for a pullback"),
 * so every judgement here is measured against the trader's own history, with an honest evidence label.
 */
import type { Trade } from "./types";
import type { Analysis } from "./analysis";

export type FeatureId = "run15" | "posDir" | "trend60";
interface Def { id: FeatureId; title: string; edges: number[]; labels: string[]; get: (a: Analysis) => number | null }

export const FEATURES: Def[] = [
  {
    id: "run15", title: "Momentum into your entry (last 15 min)", edges: [-1, 0, 0.75, 1.5],
    labels: ["Against a strong move", "Against a small move", "Quiet market", "With a moderate move", "With strong momentum"],
    get: (a) => a.features.run15Atr,
  },
  {
    id: "posDir", title: "Where in the last hour's range you entered", edges: [0.2, 0.4, 0.6, 0.8],
    labels: ["Far end (fading)", "Lower-middle", "Middle of the range", "Upper-middle", "At the extreme"],
    get: (a) => a.features.posDir,
  },
  {
    id: "trend60", title: "Last hour's trend vs your direction", edges: [-3, -1, 0, 1, 3],
    labels: ["Strongly against the trend", "Against the trend", "Slightly against", "Slightly with", "With the trend", "Strongly with the trend"],
    get: (a) => a.features.trend60Atr,
  },
];

export type Evidence = "strong" | "moderate" | "weak" | "too few";
export interface BucketStat {
  feature: FeatureId; featureTitle: string; index: number; label: string;
  n: number; pnl: number; avg: number; winRate: number;
  t: number; evidence: Evidence;
  /** positive / negative only when the evidence is at least moderate and there are enough trades. */
  edge: "positive" | "negative" | "none";
}
export type Profile = Record<FeatureId, BucketStat[]>;

export const MIN_TRADES = 12;
const bucketIndex = (v: number, edges: number[]) => { let i = 0; while (i < edges.length && v >= edges[i]) i++; return i; };

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
const variance = (xs: number[]) => { if (xs.length < 2) return 0; const m = mean(xs); return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1); };

/** Welch's t statistic for mean(a) - mean(b). */
export function welchT(a: number[], b: number[]): number {
  if (a.length < 2 || b.length < 2) return 0;
  const se = Math.sqrt(variance(a) / a.length + variance(b) / b.length);
  return se === 0 ? 0 : (mean(a) - mean(b)) / se;
}

export function buildProfile(items: { trade: Trade; a: Analysis }[]): Profile {
  const usable = items.filter((x) => x.a.ok);
  const out = {} as Profile;
  for (const f of FEATURES) {
    const groups: Trade[][] = f.labels.map(() => []);
    for (const { trade, a } of usable) {
      const v = f.get(a);
      if (v == null) continue;
      const k = bucketIndex(v, f.edges);
      groups[k].push(trade);
    }
    out[f.id] = groups.flatMap((g, k) => {
      if (!g.length) return [];
      const pnls = g.map((t) => t.pnl);
      const others = groups.flatMap((h, j) => (j === k ? [] : h.map((t) => t.pnl)));
      const t = welchT(pnls, others);
      const evidence: Evidence = g.length < MIN_TRADES ? "too few" : Math.abs(t) >= 2 ? "strong" : Math.abs(t) >= 1.3 ? "moderate" : "weak";
      const avg = mean(pnls);
      const edge = evidence === "strong" || evidence === "moderate" ? (avg > mean(others) ? "positive" : "negative") : "none";
      return [{
        feature: f.id, featureTitle: f.title, index: k, label: f.labels[k], n: g.length,
        pnl: Math.round(pnls.reduce((s, x) => s + x, 0) * 100) / 100, avg: Math.round(avg * 100) / 100,
        winRate: g.filter((x) => x.pnl > 0).length / g.length, t: Math.round(t * 100) / 100, evidence, edge,
      }] as BucketStat[];
    });
  }
  return out;
}

/** The bucket each feature places this trade in. */
export function placeTrade(a: Analysis, profile: Profile): BucketStat[] {
  if (!a.ok) return [];
  const res: BucketStat[] = [];
  for (const f of FEATURES) {
    const v = f.get(a);
    if (v == null) continue;
    const k = bucketIndex(v, f.edges);
    const hit = profile[f.id]?.find((b) => b.index === k);
    if (hit) res.push(hit);
  }
  return res;
}

export interface Verdict { tone: "good" | "warn" | "neutral" | "mixed"; headline: string; detail: string }

export function verdictFor(matches: BucketStat[]): Verdict {
  const neg = matches.filter((m) => m.edge === "negative"), pos = matches.filter((m) => m.edge === "positive");
  const n = (xs: BucketStat[]) => xs.map((m) => `"${m.label.toLowerCase()}" (${m.n} trades, ${m.pnl >= 0 ? "+" : ""}${m.pnl.toFixed(0)})`).join(" and ");
  if (neg.length && !pos.length) return { tone: "warn", headline: "Entries like this have not worked for you", detail: `Your record on ${n(neg)} is worse than the rest of your trades. Skipping or halving the size on this kind of setup is the data-backed change.` };
  if (pos.length && !neg.length) return { tone: "good", headline: "This is the kind of entry that works for you", detail: `Your record on ${n(pos)} is better than the rest of your trades. Take more of these, with your normal size.` };
  if (pos.length && neg.length) return { tone: "mixed", headline: "Mixed signals", detail: `Good: ${n(pos)}. Weak: ${n(neg)}.` };
  return { tone: "neutral", headline: "No clear pattern yet", detail: "Your record on entries like this isn't different enough from your other trades to draw a conclusion. More trades will sharpen this." };
}

/** Buckets with a real signal, strongest first (for the Insights page). */
export function rankedEdges(profile: Profile): BucketStat[] {
  return Object.values(profile).flat().filter((b) => b.edge !== "none").sort((x, y) => Math.abs(y.t) - Math.abs(x.t));
}
