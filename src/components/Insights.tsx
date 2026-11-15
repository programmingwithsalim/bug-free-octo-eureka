"use client";
import { useMemo } from "react";
import type { JournalApi, Tab } from "./App";
import { generateInsights } from "@/lib/insights";
import { computeStats } from "@/lib/analytics";
import { money } from "@/lib/format";
import Empty from "./Empty";

const LABEL = { high: "Fix first", medium: "Work on", low: "Info", good: "Strength" } as const;

export default function Insights({ j, go }: { j: JournalApi; go: (t: Tab) => void }) {
  const items = useMemo(() => generateInsights(j.trades), [j.trades]);
  const st = useMemo(() => computeStats(j.trades), [j.trades]);
  if (!j.trades.length) return <Empty go={go} />;
  const leak = items.filter((i) => i.cost && i.cost < 0 && i.severity !== "good").sort((a, b) => a.cost! - b.cost!).slice(0, 3);
  return (
    <div className="grid">
      <div className="page-head"><h2>Insights</h2></div>
      {leak.length > 0 && (
        <div className="card">
          <h3>Biggest leaks (net result {money(st.netPnl, j.account.currency)})</h3>
          <ol style={{ margin: 0, paddingLeft: 20 }}>
            {leak.map((i) => <li key={i.id}>{i.title} — <b className="neg">{money(i.cost!, j.account.currency)}</b></li>)}
          </ol>
          <p className="muted" style={{ marginBottom: 0 }}>Figures overlap (one trade can be revenge, oversized and on a bad symbol), so don't add them up.</p>
        </div>
      )}
      {items.map((i) => (
        <div key={i.id} className={`card insight ${i.severity}`}>
          <h4>{i.title}<span className="badge">{LABEL[i.severity]}</span>{i.cost != null && i.cost < 0 && <span className="badge neg">{money(i.cost, j.account.currency)}</span>}</h4>
          <p className="ev">{i.evidence}</p>
          <p className="fix"><b>How to improve:</b> {i.advice}</p>
        </div>
      ))}
      <div className="note">Insights are rule-based statistics on your own data — they point to patterns, not certainties. Small samples (&lt;30 trades per pattern) can mislead.</div>
    </div>
  );
}
