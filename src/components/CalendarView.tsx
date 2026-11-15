"use client";
import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { JournalApi, Tab } from "./App";
import type { Trade } from "@/lib/types";
import { monthGrid, summarize } from "@/lib/calendar";
import { dayKey } from "@/lib/analytics";
import { dt, money, pct } from "@/lib/format";
import Empty from "./Empty";
import TradeEditor from "./TradeEditor";

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Compact money for small cells, e.g. 1.2k. */
const short = (n: number) => (Math.abs(n) >= 10000 ? `${(n / 1000).toFixed(0)}k` : Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toFixed(Math.abs(n) < 100 ? 2 : 0));

export default function CalendarView({ j, go }: { j: JournalApi; go: (t: Tab) => void }) {
  const latest = useMemo(() => {
    const last = j.trades.reduce((m, t) => Math.max(m, +new Date(t.closeTime)), 0);
    return last ? new Date(last) : new Date();
  }, [j.trades]);
  const [cursor, setCursor] = useState<{ y: number; m: number } | null>(null);
  const { y, m } = cursor ?? { y: latest.getFullYear(), m: latest.getMonth() };
  const [selected, setSelected] = useState<string | null>(null);
  const [dir, setDir] = useState<"l" | "r">("r");
  const [editing, setEditing] = useState<Trade | null>(null);

  const weeks = useMemo(() => monthGrid(j.trades, y, m), [j.trades, y, m]);
  const sum = useMemo(() => summarize(weeks), [weeks]);
  const maxAbs = useMemo(() => Math.max(1, ...weeks.flatMap((w) => w.days.filter((d) => d.inMonth).map((d) => Math.abs(d.pnl)))), [weeks]);
  const today = dayKey(new Date().toISOString());
  const cur = j.account.currency;

  if (!j.trades.length) return <Empty go={go} />;

  const move = (delta: number) => { const d = new Date(y, m + delta, 1); setDir(delta > 0 ? "r" : "l"); setCursor({ y: d.getFullYear(), m: d.getMonth() }); setSelected(null); };
  const dayCell = weeks.flatMap((w) => w.days).find((d) => d.key === selected);
  const title = new Date(y, m, 1).toLocaleString(undefined, { month: "long", year: "numeric" });

  return (
    <div className="grid">
      <div className="page-head"><h2>Calendar</h2></div>
      <div className="grid kpis k5">
        <div className="card kpi"><div className="l">Month P&L</div><div className={`v ${sum.pnl >= 0 ? "pos" : "neg"}`}>{money(sum.pnl, cur)}</div><div className="s">{sum.count} trades</div></div>
        <div className="card kpi"><div className="l">Win rate</div><div className="v">{sum.count ? pct(sum.wins / sum.count, 0) : "–"}</div><div className="s">{sum.wins}W / {sum.count - sum.wins}L</div></div>
        <div className="card kpi"><div className="l">Green days</div><div className="v">{sum.greenDays}/{sum.tradingDays}</div><div className="s">trading days</div></div>
        <div className="card kpi"><div className="l">Best day</div><div className="v pos">{sum.bestDay ? money(sum.bestDay.pnl, cur) : "–"}</div><div className="s">{sum.bestDay?.key ?? ""}</div></div>
        <div className="card kpi"><div className="l">Worst day</div><div className="v neg">{sum.worstDay && sum.worstDay.pnl < 0 ? money(sum.worstDay.pnl, cur) : "–"}</div><div className="s">{sum.worstDay && sum.worstDay.pnl < 0 ? sum.worstDay.key : ""}</div></div>
      </div>

      <div className="cal-wrap">
        <div className="card">
          <div className="cal-head">
            <button className="btn ghost" onClick={() => move(-1)} aria-label="Previous month"><ChevronLeft size={18} /></button>
            <h3>{title}</h3>
            <button className="btn ghost" onClick={() => move(1)} aria-label="Next month"><ChevronRight size={18} /></button>
            <button className="btn ghost" onClick={() => { setCursor(null); setSelected(null); }}>Latest</button>
          </div>
          <div className={`cal-grid ${dir}`} key={`${y}-${m}`}>
            {DOW.map((d) => <div key={d} className="cal-dow">{d}</div>)}
            <div className="cal-dow">Week</div>
            {weeks.map((w, wi) => (
              <Row key={wi}>
                {w.days.map((d, di) => {
                  const cls = ["cal-day", !d.inMonth && "out", d.count && "has", d.count && (d.pnl >= 0 ? "win" : "loss"), d.key === selected && "sel", d.key === today && "today"].filter(Boolean).join(" ");
                  return (
                    <button key={d.key} className={cls} style={{ "--k": wi * 7 + di, ...(d.count ? { "--i": Math.min(1, Math.abs(d.pnl) / maxAbs) * 3 + 0.4 } : {}) } as React.CSSProperties}
                      onClick={() => d.count && setSelected(d.key === selected ? null : d.key)} disabled={!d.count}>
                      <span className="d">{d.day}</span>
                      {d.count > 0 && <><span className={`p ${d.pnl >= 0 ? "pos" : "neg"}`}>{d.pnl >= 0 ? "+" : "−"}{short(Math.abs(d.pnl))}</span><span className="c">{d.count} trade{d.count > 1 ? "s" : ""}</span></>}
                    </button>
                  );
                })}
                <div className="cal-week"><span className="w">Week {wi + 1}</span>{w.count > 0 ? <><span className={`p ${w.pnl >= 0 ? "pos" : "neg"}`}>{w.pnl >= 0 ? "+" : "−"}{short(Math.abs(w.pnl))}</span><span className="c muted">{w.count} trades</span></> : <span className="muted">–</span>}</div>
              </Row>
            ))}
          </div>
        </div>

        <div className="card fade-in" key={selected ?? "none"}>
          <h3>{dayCell ? dayCell.key : "Select a day"}</h3>
          {!dayCell ? <p className="muted">Click a coloured day to see its trades. Click a trade to add notes, tags and a rating.</p> : (
            <>
              <p className={dayCell.pnl >= 0 ? "pos" : "neg"} style={{ fontSize: 22, fontWeight: 650, margin: "0 0 10px" }}>{money(dayCell.pnl, cur)}</p>
              <div className="day-list">
                {[...dayCell.trades].sort((a, b) => +new Date(a.closeTime) - +new Date(b.closeTime)).map((t, k) => (
                  <div key={t.id} className="t" style={{ "--k": k } as React.CSSProperties} onClick={() => setEditing(t)}>
                    <span><b>{t.symbol}</b> <span className="muted">{t.side} · {t.size}</span><br /><span className="muted">{dt(t.closeTime)}</span></span>
                    <span className={t.pnl >= 0 ? "pos" : "neg"}>{money(t.pnl, cur)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      {editing && (
        <TradeEditor trade={editing} onClose={() => setEditing(null)}
          onSave={(t) => { j.setTrades((ts) => ts.map((x) => (x.id === t.id ? t : x))); setEditing(null); }}
          onDelete={(id) => { j.setTrades((ts) => ts.filter((x) => x.id !== id)); setEditing(null); }} />
      )}
    </div>
  );
}

/** Rows are flat in the CSS grid; a fragment keeps the 8 cells per week in order. */
function Row({ children }: { children: React.ReactNode }) { return <>{children}</>; }
