"use client";
import { useMemo, useState } from "react";
import { CheckCircle2, MessageSquareText, Plus, RefreshCw, Search, TriangleAlert } from "lucide-react";
import type { JournalApi } from "./App";
import type { Trade } from "@/lib/types";
import type { AnalysisApi } from "@/lib/useAnalysis";
import { placeTrade, verdictFor } from "@/lib/profile";
import { dt, money, pct } from "@/lib/format";
import TradeDetail from "./TradeDetail";
import TradeEditor from "./TradeEditor";
import Seg from "./Seg";

type Result = "all" | "win" | "loss";
type Sort = "new" | "best" | "worst";
const PAGE = 60;
const dur = (min: number) => (min < 1 ? `${Math.round(min * 60)}s` : min < 90 ? `${Math.round(min)}m` : `${(min / 60).toFixed(1)}h`);

export default function Journal({ j, an }: { j: JournalApi; an: AnalysisApi }) {
  const [q, setQ] = useState("");
  const [result, setResult] = useState<Result>("all");
  const [sort, setSort] = useState<Sort>("new");
  const [symbol, setSymbol] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<Trade | null>(null);
  const [adding, setAdding] = useState(false);
  const cur = j.account.currency;
  const symbols = useMemo(() => [...new Set(j.trades.map((t) => t.symbol))].sort(), [j.trades]);

  const rows = useMemo(() => {
    const needle = q.toLowerCase();
    const list = j.trades
      .filter((t) => (result === "all" ? true : result === "win" ? t.pnl > 0 : t.pnl < 0))
      .filter((t) => !symbol || t.symbol === symbol)
      .filter((t) => !needle || [t.symbol, t.setup, t.notes, t.emotion, ...t.tags].join(" ").toLowerCase().includes(needle));
    return list.sort((a, b) => (sort === "best" ? b.pnl - a.pnl : sort === "worst" ? a.pnl - b.pnl : +new Date(b.closeTime) - +new Date(a.closeTime)));
  }, [j.trades, q, result, symbol, sort]);

  const sum = useMemo(() => {
    const net = rows.reduce((s, t) => s + t.pnl, 0), wins = rows.filter((t) => t.pnl > 0).length;
    return { net, wins, n: rows.length, avg: rows.length ? net / rows.length : 0 };
  }, [rows]);

  const verdicts = useMemo(() => {
    const m = new Map<string, ReturnType<typeof verdictFor>>();
    for (const t of rows.slice(0, limit)) { const a = an.analyses[t.id]; if (a?.ok) m.set(t.id, verdictFor(placeTrade(a, an.profile))); }
    return m;
  }, [rows, limit, an.analyses, an.profile]);

  const save = (t: Trade) => { j.setTrades((ts) => (ts.some((x) => x.id === t.id) ? ts.map((x) => (x.id === t.id ? t : x)) : [...ts, t])); setOpen(null); setAdding(false); };
  const del = (id: string) => { j.setTrades((ts) => ts.filter((x) => x.id !== id)); setOpen(null); };
  const missing = j.trades.filter((t) => !an.analyses[t.id] && t.entry > 0).length;

  return (
    <div className="grid">
      <div className="page-head">
        <div><h2>Journal</h2><div className="sub">Click a trade for its chart, what the market did, and how it compares with your own record.</div></div>
        <div className="bar" style={{ margin: 0 }}>
          <span className={`pill ${an.busy ? "warn" : an.error || missing ? "" : "ok"}`}>
            {an.busy ? <><RefreshCw size={13} className="spin" />Analysing trades…</>
              : an.error ? <>Analysis unavailable</>
              : missing ? <>{an.agg.analysed} of {j.trades.length} analysed</> : <><span className="dot ok" />All {an.agg.analysed} analysed</>}
          </span>
          {(an.error || missing > 0) && !an.busy && <button className="btn ghost" onClick={() => an.run()} title={an.error ?? "Analyse the rest (needs MetaTrader 5 open)"}><RefreshCw size={15} />Analyse</button>}
          <button className="btn" onClick={() => setAdding(true)}><Plus size={16} />Add trade</button>
        </div>
      </div>

      <div className="grid kpis k4 anim">
        <Stat i={0} l="Trades" v={String(sum.n)} s={`of ${j.trades.length} total`} />
        <Stat i={1} l="Net P&L" v={money(sum.net, cur)} cls={sum.net >= 0 ? "pos" : "neg"} s="for this selection" />
        <Stat i={2} l="Win rate" v={sum.n ? pct(sum.wins / sum.n, 0) : "–"} s={`${sum.wins} wins · ${sum.n - sum.wins} losses`} />
        <Stat i={3} l="Average trade" v={money(sum.avg, cur)} cls={sum.avg >= 0 ? "pos" : "neg"} s="expectancy per trade" />
      </div>

      <div className="toolbar">
        <div className="search"><Search size={16} /><input placeholder="Search symbol, setup, tag, note…" value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }} /></div>
        <Seg label="Result" value={result} onChange={(v) => { setResult(v); setLimit(PAGE); }} options={[{ id: "all", label: "All" }, { id: "win", label: "Wins" }, { id: "loss", label: "Losses" }]} />
        <Seg label="Sort" value={sort} onChange={setSort} options={[{ id: "new", label: "Newest" }, { id: "best", label: "Best" }, { id: "worst", label: "Worst" }]} />
        {symbols.length > 1 && <select className="sel" value={symbol} onChange={(e) => setSymbol(e.target.value)} aria-label="Symbol"><option value="">All symbols</option>{symbols.map((s) => <option key={s}>{s}</option>)}</select>}
      </div>

      {!rows.length ? (
        <div className="card empty">No trades match. Change the filters, add a trade, or press Sync MT5.</div>
      ) : (
        <div className="card list">
          <div className="lrow lhead"><span>Closed</span><span>Trade</span><span>Held</span><span>P&L</span><span>Captured</span><span title="Does this kind of entry work for you?">Entry type</span><span>Notes</span></div>
          {rows.slice(0, limit).map((t, k) => {
            const a = an.analyses[t.id], v = verdicts.get(t.id), eff = a?.ok && a.mfe > 0 && a.exitEfficiency != null ? Math.max(0, Math.min(1, a.exitEfficiency)) : null;
            return (
              <button key={t.id} className="lrow" style={{ "--k": Math.min(k, 14) } as React.CSSProperties} onClick={() => setOpen(t)}>
                <span className="muted">{dt(t.closeTime)}</span>
                <span><b>{t.symbol}</b> <span className={`side-pill ${t.side}`}>{t.side === "long" ? "Buy" : "Sell"} {t.size}</span></span>
                <span className="muted">{a?.ok ? dur(a.holdMinutes) : dur((+new Date(t.closeTime) - +new Date(t.openTime)) / 60000)}</span>
                <span className={`pnl-pill ${t.pnl >= 0 ? "up" : "down"}`}>{money(t.pnl, cur)}</span>
                <span>{eff != null ? <span className="meter sm" title={`${Math.round(eff * 100)}% of the best available move`}><span style={{ width: `${eff * 100}%` }} /></span> : <span className="muted">–</span>}</span>
                <span>{v ? (v.tone === "good" ? <CheckCircle2 size={16} className="pos" aria-label="Entry type that works for you" /> : v.tone === "warn" ? <TriangleAlert size={16} className="neg" aria-label="Entry type that has not worked for you" /> : <span className="muted">·</span>) : <span className="muted">–</span>}</span>
                <span className="tags">{t.tags.slice(0, 2).map((x) => <span className="tag" key={x}>{x}</span>)}{t.notes && <MessageSquareText size={14} className="muted" />}{t.rating ? <span className="muted">{"★".repeat(t.rating)}</span> : null}</span>
              </button>
            );
          })}
          {rows.length > limit && <div className="more"><button className="btn ghost" onClick={() => setLimit(limit + PAGE)}>Show {Math.min(PAGE, rows.length - limit)} more</button><span className="muted">{limit} of {rows.length}</span></div>}
        </div>
      )}

      {open && <TradeDetail trade={open} currency={cur} an={an} onSave={save} onDelete={del} onClose={() => setOpen(null)} />}
      {adding && <TradeEditor trade={null} currency={cur} onSave={save} onDelete={del} onClose={() => setAdding(false)} />}
    </div>
  );
}

function Stat({ i, l, v, s, cls = "" }: { i: number; l: string; v: string; s: string; cls?: string }) {
  return <div className="card kpi" style={{ "--d": i } as React.CSSProperties}><div className="l">{l}</div><div className={`v ${cls}`}>{v}</div><div className="s">{s}</div></div>;
}
