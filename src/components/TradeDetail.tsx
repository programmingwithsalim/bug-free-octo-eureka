"use client";
import { useEffect, useMemo, useState } from "react";
import { ArrowDownRight, ArrowUpRight, CheckCircle2, CircleHelp, Clock, Lightbulb, Target, TriangleAlert, X } from "lucide-react";
import type { Trade } from "@/lib/types";
import type { AnalysisApi } from "@/lib/useAnalysis";
import { placeTrade, verdictFor, type BucketStat } from "@/lib/profile";
import { dt, money } from "@/lib/format";
import TradeChart from "./TradeChart";
import TradeEditor from "./TradeEditor";

const fmtDur = (min: number) => (min < 1 ? `${Math.round(min * 60)}s` : min < 90 ? `${min.toFixed(min < 10 ? 1 : 0)} min` : `${(min / 60).toFixed(1)} h`);
const EV: Record<string, string> = { strong: "Strong evidence", moderate: "Moderate evidence", weak: "Weak evidence", "too few": "Too few trades" };
const TONE_ICON = { good: CheckCircle2, warn: TriangleAlert, mixed: CircleHelp, neutral: CircleHelp } as const;

export default function TradeDetail({ trade, currency, an, onSave, onDelete, onClose }: {
  trade: Trade; currency: string; an: AnalysisApi;
  onSave: (t: Trade) => void; onDelete: (id: string) => void; onClose: () => void;
}) {
  const a = an.analyses[trade.id];
  const [plan, setPlan] = useState(false);
  const m = (n: number) => money(n, currency);

  useEffect(() => { if (!a && !an.busy) an.run([trade.id]); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [trade.id]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", h); document.body.style.overflow = ""; };
  }, [onClose]);

  const matches = useMemo<BucketStat[]>(() => (a?.ok ? placeTrade(a, an.profile) : []), [a, an.profile]);
  const verdict = useMemo(() => verdictFor(matches), [matches]);
  const Icon = TONE_ICON[verdict.tone];
  const win = trade.pnl >= 0;
  const eff = a?.exitEfficiency;
  const rule = (id: string) => an.agg.rules.find((r) => r.id === id);
  const allWorse = an.agg.rules.length > 0 && an.agg.rules.every((r) => r.vsActual <= 0);

  return (
    <div className="drawer-back" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Trade detail">
        <header className="drawer-head">
          <div>
            <div className="dh-title">
              <b>{trade.symbol}</b>
              <span className={`side-pill ${trade.side}`}>{trade.side === "long" ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}{trade.side === "long" ? "Buy" : "Sell"} {trade.size}</span>
            </div>
            <div className="sub">{dt(trade.openTime)} → {dt(trade.closeTime)}{a?.ok ? ` · held ${fmtDur(a.holdMinutes)}` : ""}</div>
          </div>
          <div className="dh-right">
            <div className={`big sm ${win ? "pos" : "neg"}`}>{m(trade.pnl)}</div>
            <button className="btn ghost icon" onClick={onClose} aria-label="Close"><X size={18} /></button>
          </div>
        </header>

        <section className="card">
          <div className="tc-top">
            <h3 style={{ margin: 0 }}>Chart</h3>
            {a?.suggestion && <label className="inline-switch"><button type="button" role="switch" aria-checked={plan} className={`switch ${plan ? "on" : ""}`} onClick={() => setPlan(!plan)}><span /></button>Show ATR risk plan</label>}
          </div>
          {trade.entry > 0 ? <TradeChart trade={trade} currency={currency} analysis={a} showPlan={plan} /> : <div className="muted">No entry/exit price on this trade.</div>}
        </section>

        <section className="grid kpis k4 anim">
          <Tile i={0} l="Worst point" v={a?.ok ? (a.maeAtr != null ? `${a.maeAtr.toFixed(1)}× ATR` : String(a.mae.toFixed(2))) : "–"} s={a?.ok && a.maeMoney != null ? `${m(a.maeMoney)} at its lowest` : "against your entry"} tone="r" />
          <Tile i={1} l="Best point" v={a?.ok ? (a.mfeAtr != null ? `${a.mfeAtr.toFixed(1)}× ATR` : String(a.mfe.toFixed(2))) : "–"} s={a?.ok && a.mfeMoney != null ? `${m(a.mfeMoney)} at its peak` : "in your favour"} tone="g" />
          <Tile i={2} l="Captured" v={eff != null && a?.ok && a.mfe > 0 ? `${Math.max(-999, Math.round(eff * 100))}%` : "–"} s="of the best available move" bar={eff != null ? Math.max(0, Math.min(1, eff)) : undefined} />
          <Tile i={3} l="Next hour" v={a?.ok ? `${a.after.favorable.toFixed(2)} / ${a.after.adverse.toFixed(2)}` : "–"} s="further with / against you after exit" />
        </section>

        <section className="card hindsight">
          <h3><Lightbulb size={14} style={{ verticalAlign: -2 }} /> How it could have been taken</h3>
          {!a ? <div className="skel" style={{ height: 120 }} />
            : !a.ok ? <div className="note">{a.reason ?? "No analysis available."}{an.error ? ` (${an.error})` : ""} Open MetaTrader 5 and try again.</div>
            : (
              <>
                <div className={`verdict ${verdict.tone}`}>
                  <Icon size={20} /><div><b>{verdict.headline}</b><div>{
                    // the verdict is about the kind of entry, not this outcome: say so when they disagree
                    verdict.tone === "warn" && win ? `This trade made money, but ${verdict.detail.charAt(0).toLowerCase()}${verdict.detail.slice(1)}`
                      : verdict.tone === "good" && !win ? `This trade lost, but ${verdict.detail.charAt(0).toLowerCase()}${verdict.detail.slice(1)}`
                      : verdict.detail}</div></div>
                </div>

                {matches.length > 0 && (
                  <div className="scroll"><table className="tight">
                    <thead><tr><th>What was true at entry</th><th>Your trades like this</th><th>Total</th><th>Avg</th><th>Win</th><th>Evidence</th></tr></thead>
                    <tbody>{matches.map((b) => (
                      <tr key={b.feature}>
                        <td><span className="muted">{b.featureTitle}</span><br /><b>{b.label}</b></td>
                        <td>{b.n}</td>
                        <td className={b.pnl >= 0 ? "pos" : "neg"}>{m(b.pnl)}</td>
                        <td className={b.avg >= 0 ? "pos" : "neg"}>{m(b.avg)}</td>
                        <td>{Math.round(b.winRate * 100)}%</td>
                        <td><span className={`evid ${b.evidence.replace(" ", "-")}`}>{EV[b.evidence]}</span></td>
                      </tr>))}</tbody>
                  </table></div>
                )}

                {a.findings.length > 0 && (
                  <ul className="findings">{a.findings.map((f, i) => <li key={i} className={f.level}><b>{f.title}</b><span>{f.detail}</span></li>)}</ul>
                )}

                {a.sims.length > 0 && (
                  <>
                    <h4>If you had managed this trade differently</h4>
                    <div className="scroll"><table className="tight">
                      <thead><tr><th>Rule (replayed on the real candles)</th><th>This trade</th><th>Across all {an.agg.analysed} trades</th></tr></thead>
                      <tbody>{a.sims.map((s) => {
                        const r = rule(s.id);
                        return (
                          <tr key={s.id} className={s.id === "actual" ? "row-actual" : ""}>
                            <td>{s.label}<br /><span className="muted">{s.id === "actual" ? "your exit" : s.reason}</span></td>
                            <td className={(s.pnl ?? 0) >= 0 ? "pos" : "neg"}>{s.pnl == null ? "–" : m(s.pnl)}</td>
                            <td>{s.id === "actual" ? <span className="muted">{m(an.agg.actualPnl)} total</span> : r ? <span className={r.vsActual >= 0 ? "pos" : "neg"}>{r.vsActual >= 0 ? "+" : ""}{m(r.vsActual)} vs yours</span> : "–"}</td>
                          </tr>);
                      })}</tbody>
                    </table></div>
                    <p className="hint">{allWorse
                      ? "A rule that looks good on one trade can still cost you overall. Across your trades every one of these would have done worse than how you actually manage them, so your exits are not where the money is leaking."
                      : "One trade proves nothing: only adopt a rule if the right-hand column is positive across your trades."}</p>
                  </>
                )}
              </>
            )}
        </section>

        <section className="card">
          <h3>Your notes</h3>
          <TradeEditor panel trade={trade} currency={currency} onSave={onSave} onDelete={onDelete} onClose={onClose} />
        </section>
      </aside>
    </div>
  );
}

const ICONS: Record<string, React.ReactNode> = {
  "Worst point": <ArrowDownRight size={15} />, "Best point": <ArrowUpRight size={15} />, Captured: <Target size={15} />, "Next hour": <Clock size={15} />,
};

function Tile({ i, l, v, s, tone = "", bar }: { i: number; l: string; v: string; s: string; tone?: string; bar?: number }) {
  return (
    <div className="card kpi" style={{ "--d": i } as React.CSSProperties}>
      <div className="l"><span className={`ico ${tone}`}>{ICONS[l]}</span>{l}</div>
      <div className="v">{v}</div>
      {bar != null && <div className="meter"><span style={{ width: `${bar * 100}%` }} /></div>}
      <div className="s">{s}</div>
    </div>
  );
}
