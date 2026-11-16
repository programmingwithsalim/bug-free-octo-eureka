"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Radio, RefreshCw } from "lucide-react";
import type { JournalApi, Tab } from "./App";
import type { AnalysisApi } from "@/lib/useAnalysis";
import { evaluateSignal, type LiveFeatures, type SideSignal, type SignalState } from "@/lib/signals";
import { MIN_TRADES } from "@/lib/profile";
import Empty from "./Empty";

const POLL_MS = 30_000;
const LABEL: Record<SignalState, string> = { take: "Matches your edge", avoid: "Has not worked for you", mixed: "Mixed", neutral: "No clear record" };
const CLS: Record<SignalState, string> = { take: "ok", avoid: "warn", mixed: "", neutral: "" };

function Side({ s }: { s: SideSignal }) {
  return (
    <div className="card" style={{ flex: 1, minWidth: 240 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <strong style={{ textTransform: "capitalize" }}>If you went {s.dir}</strong>
        <span className={`pill ${CLS[s.state]}`}>{LABEL[s.state]}</span>
      </div>
      <div style={{ fontWeight: 500 }}>{s.verdict.headline}</div>
      <p className="hint" style={{ margin: "6px 0 10px" }}>{s.verdict.detail}</p>
      {s.matches.map((m) => (
        <div key={m.feature} className="hint">
          {m.featureTitle}: <strong>{m.label}</strong> · {m.n} trades, {Math.round(m.winRate * 100)}% win, {m.evidence} evidence
        </div>
      ))}
    </div>
  );
}

export default function Signals({ j, an, go }: { j: JournalApi; an: AnalysisApi; go: (t: Tab) => void }) {
  const [live, setLive] = useState<LiveFeatures[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [at, setAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await (await fetch("/api/signals/edge", { cache: "no-store" })).json();
      setLive(d.live ?? []); setErrors(d.error ? [d.error] : d.errors ?? []); setAt(new Date());
    } catch (e) {
      setErrors([(e as Error).message]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const signals = useMemo(() => live.map((l) => evaluateSignal(l, an.profile)), [live, an.profile]);
  if (!j.trades.length) return <Empty go={go} />;
  const enough = an.agg.analysed >= MIN_TRADES * 2;

  return (
    <div className="grid">
      <div className="page-head">
        <div><h2>Signals</h2><div className="sub">The live market scored against your own record. It only alerts; it never opens a trade.</div></div>
        <button className="btn" disabled={loading} onClick={load}><RefreshCw size={16} className={loading ? "spin" : ""} />{loading ? "Checking…" : "Refresh"}</button>
      </div>
      {!enough && <div className="note">{an.busy ? "Analysing your trades from MT5 candles…" : `Signals need at least ${MIN_TRADES * 2} analysed trades to compare against (${an.agg.analysed} so far). Open MetaTrader 5 so the Journal can analyse them.`}</div>}
      {errors.map((e) => <div key={e} className="note neg">{e}</div>)}
      {signals.map((s) => (
        <div key={s.symbol} className="grid">
          <div className="card" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <Radio size={16} />
            <strong>{s.symbol}</strong>
            <span>{s.price}</span>
            <span className="hint">{s.stale ? "Stale: market looks closed" : s.best ? `Lean ${s.best}` : "No clear lean"} · candle {new Date(s.time * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          </div>
          {enough && !s.stale && <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}><Side s={s.long} /><Side s={s.short} /></div>}
        </div>
      ))}
      {at && <div className="hint">Updated {at.toLocaleTimeString()} · refreshes every {POLL_MS / 1000}s while this tab is open. Based on momentum, range position and trend over the last hour, the same features as your edge profile.</div>}
    </div>
  );
}
