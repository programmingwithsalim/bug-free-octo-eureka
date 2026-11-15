/** Pure helpers for the per-trade chart (window, timeframe, marker snapping). */
export const TFS = ["M1", "M5", "M15", "M30", "H1", "H4"] as const;
export type TF = (typeof TFS)[number];
export const TF_SEC: Record<TF, number> = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400 };

/** Show the trade plus context on both sides: as much as the trade lasted, but at least an hour. */
export function chartWindow(openMs: number, closeMs: number) {
  const dur = Math.max(closeMs - openMs, 60_000);
  const pad = Math.max(dur, 60 * 60_000);
  return { from: Math.floor((openMs - pad) / 1000), to: Math.ceil((closeMs + pad) / 1000) };
}

/** Smallest timeframe that keeps the window readable (<= maxBars candles). */
export function chooseTf(fromSec: number, toSec: number, maxBars = 300): TF {
  return TFS.find((tf) => (toSec - fromSec) / TF_SEC[tf] <= maxBars) ?? "H4";
}

/** Start time of the candle containing tSec. */
export const snapToCandle = (tSec: number, tf: TF) => Math.floor(tSec / TF_SEC[tf]) * TF_SEC[tf];

/** Candles are in broker (UTC) time; shift so the axis reads in the user's local time like the rest of the app. */
export const localOffsetSec = (atMs: number) => -new Date(atMs).getTimezoneOffset() * 60;

export type CandleRow = [number, number, number, number, number];

/** Validate a candles request (used by the API route). Returns an error string or null. */
export function validateCandleRequest(symbol: string, tf: string, from: number, to: number): string | null {
  if (!/^[A-Za-z0-9._#-]{1,24}$/.test(symbol)) return "bad symbol";
  if (!(TFS as readonly string[]).includes(tf)) return "bad timeframe";
  if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) return "bad time window";
  if (to - from > 14 * 86400) return "window too large";
  if ((to - from) / TF_SEC[tf as TF] > 2000) return "too many candles; pick a larger timeframe";
  return null;
}
