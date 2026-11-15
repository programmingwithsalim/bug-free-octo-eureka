/**
 * Hindsight analysis of one trade from its MT5 candles. Pure functions - no I/O.
 *
 * Honesty rules: the *suggested* stop/target use only information available at entry (ATR + recent swing),
 * never the future. "Best possible" numbers (MFE) are shown as a reference, never as a recommendation.
 * Simulations are conservative: if a bar touches both stop and target, the stop is assumed to hit first.
 */
import type { Trade } from "./types";
import type { CandleRow } from "./chart";

export const ANALYSIS_VERSION = 2; // bump when the engine's output changes: stored analyses are recomputed
/** How many M1 candles around a trade the analysis needs: 4h of context before entry, 1h after exit. */
export const LOOKBACK_SEC = 4 * 3600;
export const LOOKAHEAD_SEC = 3600;

export type SimId = "actual" | "stop_rr2" | "breakeven" | "atr_trail" | "partial";
export interface Sim {
  id: SimId; label: string;
  /** Average price move per unit actually captured (direction-adjusted). */
  move: number;
  exitTime: number | null; reason: string;
  /** Estimated P&L in account currency (null when the value per price unit can't be derived). */
  pnl: number | null;
  /** Result in multiples of the suggested stop distance. */
  r: number | null;
}
export interface Finding { level: "good" | "warn" | "bad" | "info"; title: string; detail: string }

export interface Analysis {
  version: number;
  ok: boolean;
  reason?: string;                 // why the analysis could not be made
  dir: 1 | -1;
  valuePerUnit: number | null;     // currency per 1.0 of price move for the whole position
  holdMinutes: number;
  atr: number | null;              // ATR(14) on M5 at entry
  mae: number; mfe: number;        // price distance against / in favour (>= 0) while the trade was open
  maeAtr: number | null; mfeAtr: number | null;
  maePoint: { price: number; time: number } | null;
  mfePoint: { price: number; time: number } | null;
  maeMoney: number | null; mfeMoney: number | null;
  /** captured move / MFE (can be negative). null when price never went your way. */
  exitEfficiency: number | null;
  after: { favorable: number; adverse: number; returnedToEntry: boolean };  // 60 min after you closed
  /** What was knowable at entry. Used by profile.ts to compare this trade with your own history. */
  features: {
    run15Atr: number | null;       // move in the trade's direction over the 15 min before entry, in ATRs
    posDir: number | null;         // 0..1 position in the last hour's range, in the trade's direction (1 = entering at the extreme)
    trend60Atr: number | null;     // last hour's drift in the trade's direction, in ATRs (>0 = with the trend)
  };
  hadStop: boolean;
  suggestion: {
    stop: number; stopDistance: number; stopReason: string;
    target: number; targetReason: string;
    rr: number;
    targetReached: boolean; stopHit: boolean;   // would the suggested levels have been touched while the trade was open
  } | null;
  sims: Sim[];
  bestSim: SimId | null;           // best realistic alternative (never "actual")
  findings: Finding[];
}

const M5 = 300;

interface Bar { t: number; o: number; h: number; l: number; c: number }
const toBars = (rows: CandleRow[]): Bar[] => rows.map(([t, o, h, l, c]) => ({ t, o, h, l, c }));

/** Aggregate M1 bars into M5 bars. */
export function toM5(bars: Bar[]): Bar[] {
  const out: Bar[] = [];
  for (const b of bars) {
    const k = Math.floor(b.t / M5) * M5;
    const last = out[out.length - 1];
    if (last && last.t === k) { last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; }
    else out.push({ t: k, o: b.o, h: b.h, l: b.l, c: b.c });
  }
  return out;
}

/** Mean true range over the last `period` bars (needs period+1 bars). */
export function atr(bars: Bar[], period = 14): number | null {
  if (bars.length < period + 1) return null;
  let sum = 0;
  for (let i = bars.length - period; i < bars.length; i++) {
    const p = bars[i - 1].c;
    sum += Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - p), Math.abs(bars[i].l - p));
  }
  return sum / period;
}

const round = (n: number, d = 5) => Math.round(n * 10 ** d) / 10 ** d;

interface WalkOpts { sl: number; tp?: number; beAt?: number; trailAt?: number; trailDist?: number; partialAt?: number; partialPct?: number }

/** Replay management rules over the bars the trade was open. Stop is checked before updates (no look-ahead), stop wins ties. */
export function walk(bars: Bar[], dir: 1 | -1, entry: number, horizonPrice: number, o: WalkOpts) {
  let sl = o.sl, trailing = false, partialDone = false;
  let realized = 0, remaining = 1;
  const better = (a: number, b: number) => (dir > 0 ? Math.max(a, b) : Math.min(a, b));
  for (const b of bars) {
    const adverse = dir > 0 ? b.l : b.h, fav = dir > 0 ? b.h : b.l;
    if ((adverse - sl) * dir <= 0) { // stop (initial, break-even or trailing); gap-through fills at the open
      const fill = dir > 0 ? Math.min(b.o, sl) : Math.max(b.o, sl);
      const why = sl === o.sl ? "stop hit" : Math.abs(sl - entry) < 1e-9 ? "stopped at break-even" : "trailing stop hit";
      return { move: realized + remaining * (fill - entry) * dir, exitTime: b.t, reason: why };
    }
    if (o.tp != null && (fav - o.tp) * dir >= 0) {
      return { move: realized + remaining * (o.tp - entry) * dir, exitTime: b.t, reason: "target hit" };
    }
    if (o.partialAt && !partialDone && (fav - (entry + dir * o.partialAt)) * dir >= 0) {
      const pct = o.partialPct ?? 0.5;
      realized += pct * o.partialAt; remaining -= pct; partialDone = true;
      sl = better(sl, entry); // after taking partial profit, protect the rest at break-even
    }
    if (o.beAt && (fav - (entry + dir * o.beAt)) * dir >= 0) sl = better(sl, entry);
    if (o.trailAt && (fav - (entry + dir * o.trailAt)) * dir >= 0) trailing = true;
    if (trailing && o.trailDist) sl = better(sl, fav - dir * o.trailDist);
  }
  return { move: realized + remaining * (horizonPrice - entry) * dir, exitTime: null as number | null, reason: "held to your exit" };
}

export function analyzeTrade(trade: Trade, rows: CandleRow[]): Analysis {
  const dir: 1 | -1 = trade.side === "long" ? 1 : -1;
  const openS = Math.floor(+new Date(trade.openTime) / 1000), closeS = Math.floor(+new Date(trade.closeTime) / 1000);
  const base: Analysis = {
    version: ANALYSIS_VERSION, ok: false, dir, valuePerUnit: null, holdMinutes: Math.max(0, (closeS - openS) / 60), atr: null,
    mae: 0, mfe: 0, maeAtr: null, mfeAtr: null, maePoint: null, mfePoint: null, maeMoney: null, mfeMoney: null, exitEfficiency: null,
    after: { favorable: 0, adverse: 0, returnedToEntry: false }, features: { run15Atr: null, posDir: null, trend60Atr: null }, hadStop: !!trade.stopLoss,
    suggestion: null, sims: [], bestSim: null, findings: [],
  };
  const entry = trade.entry, exit = trade.exit;
  if (!(entry > 0) || !(exit > 0)) return { ...base, reason: "Trade has no entry/exit price." };
  const all = toBars(rows).sort((a, b) => a.t - b.t);
  const during = all.filter((b) => b.t > openS - 60 && b.t <= closeS); // bars while the trade was open (incl. the entry minute)
  const sim = all.filter((b) => b.t >= Math.floor(openS / 60) * 60 + 60 && b.t <= closeS);
  if (!during.length) return { ...base, reason: "No MT5 candles for this trade's time window." };

  // value of 1.0 price move for the whole position, derived from the trade itself
  const gross = trade.pnl + (trade.fees ?? 0), actualMove = (exit - entry) * dir;
  const vpu = Math.abs(exit - entry) >= entry * 1e-4 ? gross / actualMove : null;
  const money = (move: number) => (vpu == null ? null : round(move * vpu - (trade.fees ?? 0), 2));

  // excursions
  let mae = 0, mfe = 0, maePoint = null as Analysis["maePoint"], mfePoint = null as Analysis["mfePoint"];
  for (const b of during) {
    const adv = (entry - (dir > 0 ? b.l : b.h)) * dir, fav = ((dir > 0 ? b.h : b.l) - entry) * dir;
    if (adv > mae) { mae = adv; maePoint = { price: dir > 0 ? b.l : b.h, time: b.t }; }
    if (fav > mfe) { mfe = fav; mfePoint = { price: dir > 0 ? b.h : b.l, time: b.t }; }
  }

  // ATR on M5 from the 4h before entry
  const m5Before = toM5(all.filter((b) => b.t < openS));
  const a = atr(m5Before.filter((b) => b.t < Math.floor(openS / M5) * M5), 14);

  // 60 minutes after exit
  const post = all.filter((b) => b.t > closeS && b.t <= closeS + LOOKAHEAD_SEC);
  let pFav = 0, pAdv = 0, returned = false;
  for (const b of post) {
    pFav = Math.max(pFav, ((dir > 0 ? b.h : b.l) - exit) * dir);
    pAdv = Math.max(pAdv, (exit - (dir > 0 ? b.l : b.h)) * dir);
    if (((dir > 0 ? b.h : b.l) - entry) * dir >= 0) returned = true;
  }

  // entry features (information available at entry only)
  const pre = all.filter((b) => b.t >= openS - 15 * 60 && b.t < openS);
  const hour = all.filter((b) => b.t >= openS - 3600 && b.t < openS);
  const run15 = pre.length >= 5 && a ? ((pre[pre.length - 1].c - pre[0].o) * dir) / a : null;
  let posDir: number | null = null, trend60: number | null = null;
  if (a && hour.length >= 30) {
    const hi = Math.max(...hour.map((b) => b.h)), lo = Math.min(...hour.map((b) => b.l));
    if (hi > lo) posDir = dir > 0 ? (entry - lo) / (hi - lo) : 1 - (entry - lo) / (hi - lo);
    trend60 = ((hour[hour.length - 1].c - hour[0].o) * dir) / a;
  }

  const out: Analysis = {
    ...base, ok: true, valuePerUnit: vpu, atr: a, mae, mfe,
    maeAtr: a ? mae / a : null, mfeAtr: a ? mfe / a : null, maePoint, mfePoint,
    maeMoney: vpu == null ? null : round(-mae * vpu, 2), mfeMoney: vpu == null ? null : round(mfe * vpu, 2),
    exitEfficiency: mfe > 0 ? actualMove / mfe : null,
    after: { favorable: pFav, adverse: pAdv, returnedToEntry: returned },
    features: { run15Atr: run15, posDir, trend60Atr: trend60 },
  };

  // ---- suggestion: pre-trade information only ----
  if (a) {
    const m5 = m5Before.slice(-12); // last hour of M5 bars before entry
    const swing = m5.length ? (dir > 0 ? Math.min(...m5.map((b) => b.l)) : Math.max(...m5.map((b) => b.h))) : null;
    const structural = swing == null ? null : Math.abs(entry - swing) + 0.25 * a;
    const dist = Math.min(3 * a, Math.max(a, structural ?? 1.5 * a));
    const stop = round(entry - dir * dist, 5), target = round(entry + dir * 2 * dist, 5);
    out.suggestion = {
      stop, stopDistance: dist,
      stopReason: structural != null && structural >= a && structural <= 3 * a
        ? `just beyond the last hour's ${dir > 0 ? "low" : "high"} (${round(swing as number, 2)}) plus a quarter ATR of room`
        : structural != null && structural > 3 * a ? "capped at 3× ATR: the last swing was too far away to risk" : "at least 1× ATR (a normal 5-minute swing) so ordinary noise doesn't stop you out",
      target, targetReason: "2× the stop distance (2R)",
      rr: 2,
      stopHit: false, targetReached: false,
    };
    const sg = out.suggestion;
    sg.stopHit = during.some((b) => ((dir > 0 ? b.l : b.h) - stop) * dir <= 0);
    sg.targetReached = during.some((b) => ((dir > 0 ? b.h : b.l) - target) * dir >= 0);

    const mk = (id: SimId, label: string, o: WalkOpts): Sim => {
      const r = walk(sim, dir, entry, exit, o);
      return { id, label, move: r.move, exitTime: r.exitTime, reason: r.reason, pnl: money(r.move), r: round(r.move / dist, 2) };
    };
    out.sims = [
      { id: "actual", label: "What you did", move: actualMove, exitTime: closeS, reason: "your exit", pnl: round(trade.pnl, 2), r: round(actualMove / dist, 2) },
      mk("stop_rr2", "Stop + 2R target", { sl: stop, tp: target }),
      mk("breakeven", "Stop, then break-even at +1R", { sl: stop, beAt: dist }),
      mk("atr_trail", "Stop, then 2×ATR trail after +1R", { sl: stop, trailAt: dist, trailDist: 2 * a }),
      mk("partial", "Half off at +1R, rest at break-even", { sl: stop, partialAt: dist, partialPct: 0.5 }),
    ];
    const alts = out.sims.filter((s) => s.id !== "actual");
    const key = (s: Sim) => (s.pnl ?? s.r ?? 0);
    const best = alts.reduce((x, y) => (key(y) > key(x) ? y : x));
    out.bestSim = key(best) > key(out.sims[0]) + 1e-9 ? best.id : null;
  }

  // ---- findings ----
  const f: Finding[] = [];
  const m = (n: number | null) => (n == null ? "" : ` (≈ ${n >= 0 ? "" : "-"}${Math.abs(n).toFixed(2)})`);
  const won = trade.pnl > 0;
  // Only objective, measured facts here. Judgements ("you should have...") come from profile.ts, which compares
  // this trade with the trader's OWN history, because generic rules (e.g. "don't chase") can be wrong for a given style.
  if (a && mae > 0.5 * a) f.push({ level: "info", title: `Worst point: ${(mae / a).toFixed(1)}× ATR against you`, detail: `At its worst the trade was ${round(mae, 2)} against your entry${m(out.maeMoney)}${trade.stopLoss ? "" : " and had no stop-loss"}.` });
  if (out.exitEfficiency != null && a && mfe > 0.5 * a) {
    const eff = out.exitEfficiency;
    if (eff < 0.4) f.push({ level: won ? "warn" : "bad", title: eff < 0 ? "A winner turned into a loser" : "You captured little of the move", detail: `At best the trade was up ${round(mfe, 2)} (${(mfe / a).toFixed(1)}× ATR)${m(out.mfeMoney)}, you exited at ${round(actualMove, 2)}. You captured ${Math.round(eff * 100)}% of what was on the table.` });
    else if (eff >= 0.7) f.push({ level: "good", title: "Excellent exit", detail: `You captured ${Math.round(eff * 100)}% of the best available move. Hard to improve on.` });
  }
  if (won && a && pFav > 1 * a) f.push({ level: "info", title: "Price kept going after your exit", detail: `In the next hour it moved another ${round(pFav, 2)} (${(pFav / a).toFixed(1)}× ATR) in your favour.` });
  if (!won && returned) f.push({ level: "info", title: "It came back to your entry", detail: "Within an hour of you closing, price returned to your entry level." });
  out.findings = f;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Aggregate over many analysed trades
// ---------------------------------------------------------------------------------------------
export interface Aggregate {
  analysed: number;
  actualPnl: number;
  /** Total estimated P&L per management rule over all analysed trades (needs value-per-unit). */
  rules: { id: SimId; label: string; pnl: number; vsActual: number; betterTrades: number }[];
  avgExitEfficiency: number | null;
  leftOnTable: number;            // sum of (MFE - captured) in currency, for trades that had a favourable excursion
  noStopPct: number;
  avgMaeAtr: number | null;
  gaveBackPct: number;            // share of trades that were up >0.5 ATR at best but ended below 40% capture
}

export function aggregate(items: { trade: Trade; a: Analysis }[]): Aggregate {
  const ok = items.filter((x) => x.a.ok);
  const sims = new Map<SimId, { label: string; pnl: number; better: number }>();
  let actual = 0, eff: number[] = [], left = 0, noStop = 0, mae: number[] = [], gaveBack = 0, withAtr = 0;
  for (const { trade, a } of ok) {
    actual += trade.pnl;
    if (!trade.stopLoss) noStop++;
    if (a.exitEfficiency != null && a.mfeAtr != null && a.mfeAtr > 0.5) { eff.push(Math.max(-1, Math.min(1, a.exitEfficiency))); if (a.exitEfficiency < 0.4) gaveBack++; withAtr++; }
    if (a.mfeMoney != null) left += Math.max(0, a.mfeMoney - Math.max(0, trade.pnl));
    if (a.maeAtr != null) mae.push(a.maeAtr);
    for (const s of a.sims) {
      if (s.id === "actual" || s.pnl == null) continue;
      const cur = sims.get(s.id) ?? { label: s.label, pnl: 0, better: 0 };
      cur.pnl += s.pnl; if (s.pnl > trade.pnl) cur.better++;
      sims.set(s.id, cur);
    }
  }
  const sum = (xs: number[]) => xs.reduce((p, c) => p + c, 0);
  return {
    analysed: ok.length, actualPnl: round(actual, 2),
    rules: [...sims.entries()].map(([id, s]) => ({ id, label: s.label, pnl: round(s.pnl, 2), vsActual: round(s.pnl - actual, 2), betterTrades: s.better })).sort((x, y) => y.pnl - x.pnl),
    avgExitEfficiency: eff.length ? sum(eff) / eff.length : null,
    leftOnTable: round(left, 2),
    noStopPct: ok.length ? noStop / ok.length : 0,
    avgMaeAtr: mae.length ? sum(mae) / mae.length : null,
    gaveBackPct: withAtr ? gaveBack / withAtr : 0,
  };
}
