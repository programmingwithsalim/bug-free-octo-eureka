"use client";
import { useState } from "react";
import { EMOTIONS, MISTAKE_TAGS, type Side, type Trade } from "@/lib/types";
import { toLocalInput } from "@/lib/format";
import { tradeId } from "@/lib/importer";
import TradeChart from "./TradeChart";

const num = (s: string) => (s.trim() === "" || isNaN(+s) ? undefined : +s);

export default function TradeEditor({ trade, currency = "USD", onSave, onDelete, onClose }: {
  trade: Trade | null; currency?: string; onSave: (t: Trade) => void; onDelete: (id: string) => void; onClose: () => void;
}) {
  const now = new Date().toISOString();
  const [f, setF] = useState({
    symbol: trade?.symbol ?? "", side: (trade?.side ?? "long") as Side,
    openTime: toLocalInput(trade?.openTime ?? now), closeTime: toLocalInput(trade?.closeTime ?? now),
    entry: String(trade?.entry ?? ""), exit: String(trade?.exit ?? ""), size: String(trade?.size ?? ""),
    pnl: String(trade?.pnl ?? ""), fees: String(trade?.fees ?? "0"),
    stopLoss: String(trade?.stopLoss ?? ""), takeProfit: String(trade?.takeProfit ?? ""),
    setup: trade?.setup ?? "", emotion: trade?.emotion ?? "", rating: trade?.rating ?? 0,
    notes: trade?.notes ?? "", screenshot: trade?.screenshot ?? "", tags: trade?.tags ?? [],
  });
  const [err, setErr] = useState("");
  const set = (k: keyof typeof f, v: any) => setF((s) => ({ ...s, [k]: v }));
  const toggle = (tg: string) => set("tags", f.tags.includes(tg) ? f.tags.filter((x) => x !== tg) : [...f.tags, tg]);

  const save = () => {
    if (!f.symbol.trim()) return setErr("Symbol is required");
    if (num(f.pnl) == null) return setErr("P&L is required (net of fees)");
    if (+new Date(f.closeTime) < +new Date(f.openTime)) return setErr("Close time is before open time");
    const base = {
      symbol: f.symbol.trim().toUpperCase(), side: f.side,
      openTime: new Date(f.openTime).toISOString(), closeTime: new Date(f.closeTime).toISOString(),
      entry: num(f.entry) ?? 0, exit: num(f.exit) ?? 0, size: num(f.size) ?? 1,
      pnl: num(f.pnl)!, fees: Math.abs(num(f.fees) ?? 0),
    };
    onSave({
      ...base, id: trade?.id ?? tradeId(base) + "-" + Date.now().toString(36),
      stopLoss: num(f.stopLoss), takeProfit: num(f.takeProfit),
      setup: f.setup.trim() || undefined, emotion: f.emotion || undefined, rating: f.rating || undefined,
      notes: f.notes.trim() || undefined, screenshot: f.screenshot.trim() || undefined, tags: f.tags,
    });
  };

  const In = ({ k, label, type = "text", ...rest }: { k: keyof typeof f; label: string; type?: string } & Record<string, any>) => (
    <div><label>{label}</label><input type={type} value={f[k] as any} onChange={(e) => set(k, e.target.value)} {...rest} /></div>
  );

  return (
    <div className="modal" onClick={onClose}>
      <div className="card" onClick={(e) => e.stopPropagation()}>
        <h3>{trade ? "Edit trade" : "New trade"}</h3>
        {trade && trade.entry > 0 && <TradeChart trade={trade} currency={currency} />}
        <div className="form">
          <In k="symbol" label="Symbol" placeholder="EURUSD" />
          <div><label>Side</label><select value={f.side} onChange={(e) => set("side", e.target.value)}><option value="long">Long / Buy</option><option value="short">Short / Sell</option></select></div>
          <In k="size" label="Size / lots" type="number" step="any" />
          <In k="openTime" label="Opened" type="datetime-local" />
          <In k="closeTime" label="Closed" type="datetime-local" />
          <In k="entry" label="Entry price" type="number" step="any" />
          <In k="exit" label="Exit price" type="number" step="any" />
          <In k="stopLoss" label="Stop loss" type="number" step="any" />
          <In k="takeProfit" label="Take profit" type="number" step="any" />
          <In k="pnl" label="Net P&L" type="number" step="any" />
          <In k="fees" label="Fees (already in P&L)" type="number" step="any" />
          <In k="setup" label="Setup / strategy" placeholder="Breakout, Pullback…" />
          <div><label>Emotion</label><select value={f.emotion} onChange={(e) => set("emotion", e.target.value)}><option value="">–</option>{EMOTIONS.map((x) => <option key={x}>{x}</option>)}</select></div>
          <div><label>Execution quality</label>
            <div className="chips">{[1, 2, 3, 4, 5].map((n) => <span key={n} className={`chip ${f.rating >= n ? "on good" : ""}`} onClick={() => set("rating", f.rating === n ? 0 : n)}>★</span>)}</div>
          </div>
          <div className="span"><label>Mistakes / tags — be honest, this drives your insights</label>
            <div className="chips">{MISTAKE_TAGS.map((tg) => <span key={tg} className={`chip ${tg === "Good execution" ? "good" : ""} ${f.tags.includes(tg) ? "on" : ""}`} onClick={() => toggle(tg)}>{tg}</span>)}</div>
          </div>
          <div className="span"><label>Notes — why you took it, what you saw, what you'd change</label><textarea value={f.notes} onChange={(e) => set("notes", e.target.value)} /></div>
          <div className="span"><In k="screenshot" label="Chart screenshot URL (optional)" placeholder="https://www.tradingview.com/x/…" /></div>
        </div>
        {f.screenshot && /^https?:\/\//.test(f.screenshot) && <p><a href={f.screenshot} target="_blank" rel="noreferrer noopener" style={{ color: "var(--blue)" }}>Open chart ↗</a></p>}
        {err && <p className="neg">{err}</p>}
        <div className="bar" style={{ marginTop: 14, marginBottom: 0 }}>
          <button className="btn" onClick={save}>Save</button>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          {trade && <button className="btn danger" style={{ marginLeft: "auto" }} onClick={() => confirm("Delete this trade?") && onDelete(trade.id)}>Delete</button>}
        </div>
      </div>
    </div>
  );
}
