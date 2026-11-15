"use client";
import { useMemo, useState } from "react";
import type { JournalApi } from "./App";
import type { Trade } from "@/lib/types";
import { rMultiple } from "@/lib/analytics";
import { dt, money } from "@/lib/format";
import TradeEditor from "./TradeEditor";

export default function Journal({ j }: { j: JournalApi }) {
  const [q, setQ] = useState("");
  const [result, setResult] = useState<"all" | "win" | "loss">("all");
  const [editing, setEditing] = useState<Trade | "new" | null>(null);

  const rows = useMemo(() => {
    const needle = q.toLowerCase();
    return [...j.trades]
      .sort((a, b) => +new Date(b.closeTime) - +new Date(a.closeTime))
      .filter((t) => (result === "all" ? true : result === "win" ? t.pnl > 0 : t.pnl < 0))
      .filter((t) => !needle || [t.symbol, t.setup, t.notes, t.emotion, ...t.tags].join(" ").toLowerCase().includes(needle));
  }, [j.trades, q, result]);

  return (
    <div>
      <div className="page-head"><h2>Journal</h2></div>
      <div className="bar">
        <div><label>Search</label><input placeholder="symbol, setup, tag, note…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div><label>Result</label>
          <select value={result} onChange={(e) => setResult(e.target.value as any)}>
            <option value="all">All</option><option value="win">Winners</option><option value="loss">Losers</option>
          </select>
        </div>
        <button className="btn" onClick={() => setEditing("new")}>+ Add trade</button>
        <span className="muted">{rows.length} of {j.trades.length}</span>
      </div>
      {!rows.length ? (
        <div className="card empty">No trades match. Add one or press Sync MT5.</div>
      ) : (
        <div className="card scroll" style={{ padding: 0 }}>
          <table>
            <thead><tr><th>Closed</th><th>Symbol</th><th>Side</th><th>Size</th><th>P&L</th><th>R</th><th>Setup</th><th>Tags</th><th>★</th></tr></thead>
            <tbody>
              {rows.slice(0, 500).map((t) => {
                const r = rMultiple(t);
                return (
                  <tr key={t.id} className="row" onClick={() => setEditing(t)}>
                    <td>{dt(t.closeTime)}</td><td><b>{t.symbol}</b></td>
                    <td>{t.side}</td><td>{t.size}</td>
                    <td className={t.pnl >= 0 ? "pos" : "neg"}>{money(t.pnl, j.account.currency)}</td>
                    <td className="muted">{r != null ? `${r.toFixed(1)}R` : "–"}</td>
                    <td>{t.setup ?? ""}</td>
                    <td>{t.tags.map((x) => <span className="tag" key={x}>{x}</span>)}{t.notes && "📝"}</td>
                    <td>{t.rating ? "★".repeat(t.rating) : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length > 500 && <p className="muted" style={{ padding: 10 }}>Showing newest 500 — refine the search to see others.</p>}
        </div>
      )}
      {editing && (
        <TradeEditor
          trade={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSave={(t) => { j.setTrades((ts) => (ts.some((x) => x.id === t.id) ? ts.map((x) => (x.id === t.id ? t : x)) : [...ts, t])); setEditing(null); }}
          onDelete={(id) => { j.setTrades((ts) => ts.filter((x) => x.id !== id)); setEditing(null); }}
        />
      )}
    </div>
  );
}
