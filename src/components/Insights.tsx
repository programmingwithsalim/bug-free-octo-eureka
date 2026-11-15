"use client";
import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis, ReferenceLine } from "recharts";
import { AlertTriangle, CheckCircle2, Gauge, Info, Sparkles, TrendingDown, TrendingUp, Wrench } from "lucide-react";
import type { JournalApi, Tab } from "./App";
import type { AnalysisApi } from "@/lib/useAnalysis";
import { FEATURES, rankedEdges, type BucketStat } from "@/lib/profile";
import { generateInsights } from "@/lib/insights";
import { computeStats } from "@/lib/analytics";
import { money } from "@/lib/format";
import { CHART, type Theme } from "@/lib/theme";
import Empty from "./Empty";
import Seg from "./Seg";

type Filter = "all" | "high" | "medium" | "good";
const SEV = {
  high: { label: "Fix first", icon: AlertTriangle, cls: "r" },
  medium: { label: "Work on", icon: Wrench, cls: "a" },
  low: { label: "Info", icon: Info, cls: "" },
  good: { label: "Strength", icon: CheckCircle2, cls: "g" },
} as const;
const HOLD = [["Under 2 min", 0, 2], ["2–10 min", 2, 10], ["10–30 min", 10, 30], ["30–120 min", 30, 120], ["Over 2 hours", 120, Infinity]] as const;

export default function Insights({ j, an, go, theme }: { j: JournalApi; an: AnalysisApi; go: (t: Tab) => void; theme: Theme }) {
  const [filter, setFilter] = useState<Filter>("all");
  const cur = j.account.currency, c = CHART[theme];
  const m = (n: number) => money(n, cur);
  const items = useMemo(() => generateInsights(j.trades), [j.trades]);
  const st = useMemo(() => computeStats(j.trades), [j.trades]);
  const edges = useMemo(() => rankedEdges(an.profile), [an.profile]);
  const best = edges.find((e) => e.edge === "positive"), worst = edges.find((e) => e.edge === "negative");
  const hold = useMemo(() => HOLD.map(([label, lo, hi]) => {
    const g = j.trades.filter((t) => { const min = (+new Date(t.closeTime) - +new Date(t.openTime)) / 60000; return min >= lo && min < hi; });
    return { label, n: g.length, pnl: g.reduce((s, t) => s + t.pnl, 0), win: g.length ? g.filter((t) => t.pnl > 0).length / g.length : 0 };
  }), [j.trades]);
  if (!j.trades.length) return <Empty go={go} />;

  const leak = items.filter((i) => i.cost && i.cost < 0 && i.severity !== "good").sort((a, b) => a.cost! - b.cost!)[0];
  const shown = items.filter((i) => filter === "all" || (filter === "medium" ? i.severity === "medium" || i.severity === "low" : i.severity === filter));
  const eff = an.agg.avgExitEfficiency;
  const allWorse = an.agg.rules.length > 0 && an.agg.rules.every((r) => r.vsActual <= 0);
  const axis = { stroke: c.axis, fontSize: 11, axisLine: false, tickLine: false } as const;

  return (
    <div className="grid">
      <div className="page-head"><div><h2>Insights</h2><div className="sub">Measured on your own {j.trades.length} trades. Net result {m(st.netPnl)}.</div></div></div>

      <div className="grid hero3 anim">
        <Hero i={0} icon={<TrendingUp size={16} />} tone="g" title="Where your edge is" main={best ? best.label : "Nothing statistically solid yet"}
          sub={best ? `${best.featureTitle}: ${best.n} trades, ${m(best.pnl)} (${Math.round(best.winRate * 100)}% win) · ${best.evidence} evidence` : "More trades are needed before any entry type stands out from noise."} />
        <Hero i={1} icon={<TrendingDown size={16} />} tone="r" title="Biggest leak" main={worst ? worst.label : leak ? leak.title : "No clear leak"}
          sub={worst ? `${worst.featureTitle}: ${worst.n} trades, ${m(worst.pnl)} (${Math.round(worst.winRate * 100)}% win) · ${worst.evidence} evidence` : leak ? `Cost about ${m(leak.cost!)}` : "Nothing stands out as costing you money."} />
        <Hero i={2} icon={<Gauge size={16} />} title="Exit efficiency" main={eff != null ? `${Math.round(eff * 100)}%` : "–"}
          sub={eff != null ? `of the best available move captured on average. Peak moves were worth ${m(an.agg.leftOnTable)} more than you booked (perfect hindsight, not a target)` : an.busy ? "Analysing trades…" : "Needs MT5 candles (open MetaTrader 5)"} meter={eff != null ? Math.max(0, Math.min(1, eff)) : undefined} />
      </div>

      <div className="card">
        <h3><Sparkles size={14} style={{ verticalAlign: -2 }} /> Your edge profile</h3>
        <p className="hint" style={{ marginTop: -4, marginBottom: 14 }}>Average result of your trades, grouped by what was true when you entered. Faded bars have weak evidence, so don't act on them. Advice here comes from your own record, not generic rules.</p>
        {an.agg.analysed < 20 ? <div className="note">{an.busy ? "Analysing your trades from MT5 candles…" : "Needs at least 20 analysed trades (open MetaTrader 5 so the Journal can analyse them)."}</div> : (
          <div className="grid edge-grid">
            {FEATURES.map((f) => {
              const data = an.profile[f.id] ?? [];
              return (
                <div key={f.id}>
                  <h4 className="edge-title">{f.title}</h4>
                  <ResponsiveContainer width="100%" height={Math.max(150, data.length * 38 + 30)}>
                    <BarChart data={data} layout="vertical" margin={{ left: 4, right: 12 }} barCategoryGap="28%">
                      <CartesianGrid stroke={c.grid} strokeDasharray="3 5" horizontal={false} />
                      <XAxis type="number" {...axis} />
                      <YAxis type="category" dataKey="label" width={170} {...axis} tickFormatter={(l: string) => (l.length > 28 ? l.slice(0, 27) + "…" : l)} />
                      <ReferenceLine x={0} stroke={c.grid} />
                      <Tooltip cursor={{ fill: c.cursor }} content={({ active, payload }) => {
                        const b = active && (payload?.[0]?.payload as BucketStat | undefined);
                        return b ? (
                          <div className="tip"><b>{b.label}</b><div>{b.n} trades · {Math.round(b.winRate * 100)}% win</div><div>Total {m(b.pnl)} · avg {m(b.avg)}</div><div className="muted">{b.evidence} evidence</div></div>
                        ) : null;
                      }} />
                      <Bar dataKey="avg" radius={[0, 6, 6, 0]} animationDuration={800}>
                        {data.map((b, i) => <Cell key={i} fill={b.avg >= 0 ? c.green : c.red} fillOpacity={b.evidence === "strong" ? 1 : b.evidence === "moderate" ? 0.7 : 0.3} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="grid two">
        <div className="card">
          <h3>Would stops, targets or trailing have helped?</h3>
          {!an.agg.rules.length ? <div className="muted">Waiting for analysis…</div> : (
            <>
              <div className="scroll"><table className="tight">
                <thead><tr><th>Rule replayed on your real candles</th><th>Total</th><th>vs what you did</th></tr></thead>
                <tbody>
                  <tr className="row-actual"><td>What you actually did</td><td>{m(an.agg.actualPnl)}</td><td className="muted">–</td></tr>
                  {an.agg.rules.map((r) => <tr key={r.id}><td>{r.label}</td><td>{m(r.pnl)}</td><td className={r.vsActual >= 0 ? "pos" : "neg"}>{r.vsActual >= 0 ? "+" : ""}{m(r.vsActual)}</td></tr>)}
                </tbody>
              </table></div>
              <p className="hint">{allWorse ? "None of these would have beaten how you manage your trades. A tight stop or a fixed target would have cut your winners more than it saved you from losers, so exits aren't where your money leaks." : "Rules with a positive right-hand column would have improved your total. Test one in Dry run on the Bot tab before trusting it."}</p>
            </>
          )}
        </div>

        <div className="card">
          <h3>How long you hold</h3>
          <div className="scroll"><table className="tight">
            <thead><tr><th>Held</th><th>Trades</th><th>Win</th><th>Total</th></tr></thead>
            <tbody>{hold.map((h) => <tr key={h.label}><td>{h.label}</td><td>{h.n}</td><td>{h.n ? Math.round(h.win * 100) + "%" : "–"}</td><td className={h.pnl >= 0 ? "pos" : "neg"}>{h.n ? m(h.pnl) : "–"}</td></tr>)}</tbody>
          </table></div>
          <p className="hint">Hold time mostly reflects how a trade went (winners get held longer), so this describes your results rather than a rule to copy.</p>
        </div>
      </div>

      <div className="page-head" style={{ marginTop: 8, marginBottom: 0 }}>
        <h3 style={{ margin: 0 }}>Rule-based coach</h3>
        <Seg label="Filter" value={filter} onChange={setFilter} options={[{ id: "all", label: "All" }, { id: "high", label: "Fix first" }, { id: "medium", label: "Work on" }, { id: "good", label: "Strengths" }]} />
      </div>
      <div className="grid icards">
        {shown.map((i, k) => {
          const S = SEV[i.severity], Ic = S.icon;
          return (
            <div key={i.id} className={`card icard ${i.severity}`} style={{ "--k": Math.min(k, 12) } as React.CSSProperties}>
              <div className="icard-head"><span className={`ico ${S.cls}`}><Ic size={15} /></span><b>{i.title}</b><span className="badge">{S.label}</span>{i.cost != null && i.cost < 0 && <span className="badge neg">{m(i.cost)}</span>}</div>
              <p className="ev">{i.evidence}</p>
              <p className="fix"><b>Do this:</b> {i.advice}</p>
              {i.id === "no-stop" && allWorse && <p className="hint">Your own replay above shows tight stops would have cost you money, so if you add stops, treat them as wide disaster protection and test them in Dry run on the Bot tab first.</p>}
            </div>
          );
        })}
        {!shown.length && <div className="muted">Nothing in this category.</div>}
      </div>
      <div className="note">Insights are statistics on your own data: they point to patterns, not certainties. Groups under {12} trades are never called findings, and small samples can mislead.</div>
    </div>
  );
}

function Hero({ i, icon, tone = "", title, main, sub, meter }: { i: number; icon: React.ReactNode; tone?: string; title: string; main: string; sub: string; meter?: number }) {
  return (
    <div className="card hero-card" style={{ "--d": i } as React.CSSProperties}>
      <div className="l muted"><span className={`ico ${tone}`}>{icon}</span>{title}</div>
      <div className="hero-main">{main}</div>
      {meter != null && <div className="meter"><span style={{ width: `${meter * 100}%` }} /></div>}
      <div className="s muted">{sub}</div>
    </div>
  );
}
