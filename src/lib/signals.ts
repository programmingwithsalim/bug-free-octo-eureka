/**
 * Live setup signals: score the market RIGHT NOW against your own edge profile (profile.ts).
 *
 * A signal never says "buy" or "sell" from indicators. It says "if you entered now, this is the kind of entry
 * your own history says works (or doesn't)", using the same features and buckets as the Journal's hindsight view.
 * The bot never opens trades; this only informs the trader.
 */
import { atrBefore, entryFeatures, toBars, type Analysis } from "./analysis";
import type { CandleRow } from "./chart";
import { placeFeatures, verdictFor, type BucketStat, type Profile, type Verdict } from "./profile";

/** Bars older than this mean the market is closed or the feed is stale. */
export const STALE_SEC = 5 * 60;
/** M1 candles needed: ATR(14) on M5 plus the last hour. */
export const SIGNAL_LOOKBACK_SEC = 3 * 3600;

export interface LiveFeatures {
  symbol: string;
  price: number;
  /** open time of the newest candle */
  time: number;
  atr: number | null;
  long: Analysis["features"];
  short: Analysis["features"];
}

/** Features for a hypothetical long and short entry at the last close. Pure; null when there isn't enough history. */
export function liveFeatures(symbol: string, rows: CandleRow[]): LiveFeatures | null {
  const all = toBars(rows).sort((a, b) => a.t - b.t);
  if (all.length < 30) return null;
  const last = all[all.length - 1];
  const openS = last.t + 60; // "now" = the minute after the newest candle
  const a = atrBefore(all, openS);
  return {
    symbol, price: last.c, time: last.t, atr: a,
    long: entryFeatures(all, openS, last.c, 1, a),
    short: entryFeatures(all, openS, last.c, -1, a),
  };
}

export type SignalState = "take" | "avoid" | "mixed" | "neutral";
export interface SideSignal { dir: "long" | "short"; state: SignalState; verdict: Verdict; matches: BucketStat[] }
export interface Signal {
  symbol: string; price: number; time: number; stale: boolean;
  long: SideSignal; short: SideSignal;
  /** the side to look at, when exactly one side has a positive reading */
  best: "long" | "short" | null;
}

const STATE: Record<Verdict["tone"], SignalState> = { good: "take", warn: "avoid", mixed: "mixed", neutral: "neutral" };

function side(dir: "long" | "short", f: Analysis["features"], profile: Profile): SideSignal {
  const matches = placeFeatures(f, profile);
  const verdict = verdictFor(matches);
  return { dir, state: STATE[verdict.tone], verdict, matches };
}

export function evaluateSignal(live: LiveFeatures, profile: Profile, nowSec = Date.now() / 1000): Signal {
  const long = side("long", live.long, profile), short = side("short", live.short, profile);
  const best = long.state === "take" && short.state !== "take" ? "long" : short.state === "take" && long.state !== "take" ? "short" : null;
  return { symbol: live.symbol, price: live.price, time: live.time, stale: nowSec - live.time > STALE_SEC, long, short, best };
}
