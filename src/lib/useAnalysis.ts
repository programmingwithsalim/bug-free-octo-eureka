"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { aggregate, type Aggregate, type Analysis } from "./analysis";
import { buildProfile, type Profile } from "./profile";
import type { Trade } from "./types";

export interface AnalysisApi {
  analyses: Record<string, Analysis>;
  profile: Profile;
  agg: Aggregate;
  busy: boolean;
  error: string | null;
  /** Analyse specific trades (or all missing ones) from MT5 candles. */
  run: (ids?: string[], force?: boolean) => Promise<void>;
}

/**
 * Loads stored analyses, then quietly analyses any trades that don't have one yet (once per trade per session),
 * and derives your edge profile + aggregate numbers.
 */
export function useAnalysis(trades: Trade[], ready: boolean): AnalysisApi {
  const [analyses, setAnalyses] = useState<Record<string, Analysis>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tried = useRef(new Set<string>());
  const loaded = useRef(false);

  const run = useCallback(async (ids?: string[], force = false) => {
    setBusy(true); setError(null);
    try {
      const r = await fetch("/api/analysis", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids, force }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Analysis failed");
      setAnalyses((prev) => ({ ...prev, ...d.analyses }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!ready || loaded.current) return;
    loaded.current = true;
    fetch("/api/analysis").then((r) => r.json()).then((d) => d.analyses && setAnalyses(d.analyses)).catch(() => {});
  }, [ready]);

  // analyse whatever is still missing (needs MT5 open the first time; results are then stored)
  useEffect(() => {
    if (!ready || !loaded.current || busy) return;
    const missing = trades.filter((t) => !analyses[t.id] && !tried.current.has(t.id) && t.entry > 0);
    if (!missing.length) return;
    missing.forEach((t) => tried.current.add(t.id));
    run(missing.map((t) => t.id));
  }, [ready, trades, analyses, busy, run]);

  const items = useMemo(() => trades.flatMap((t) => (analyses[t.id] ? [{ trade: t, a: analyses[t.id] }] : [])), [trades, analyses]);
  const profile = useMemo(() => buildProfile(items), [items]);
  const agg = useMemo(() => aggregate(items), [items]);
  return { analyses, profile, agg, busy, error, run };
}
