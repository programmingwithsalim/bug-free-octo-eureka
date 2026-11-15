"use client";
import { useState } from "react";
import type { JournalApi } from "./App";
import { download, tradesToCsv } from "@/lib/store";
import ImportPanel from "./ImportPanel";

export default function SettingsPanel({ j }: { j: JournalApi }) {
  const [a, setA] = useState(j.account);
  const [saved, setSaved] = useState(false);
  const restore = async (f: File) => {
    try {
      const p = JSON.parse(await f.text());
      if (!Array.isArray(p.trades)) throw new Error();
      if (confirm(`Replace current data with ${p.trades.length} trades from backup?`)) j.replaceAll(p);
    } catch { alert("That doesn't look like a Trade Journal backup file."); }
  };
  return (
    <div className="grid">
    <div className="page-head"><h2>Settings</h2></div>
    <div className="grid two">
      <div className="card">
        <h3>Account details</h3>
        <div className="form">
          <div><label>Account name</label><input value={a.name} onChange={(e) => setA({ ...a, name: e.target.value })} /></div>
          <div><label>Broker / platform</label><input value={a.broker} onChange={(e) => setA({ ...a, broker: e.target.value })} placeholder="e.g. IC Markets MT5" /></div>
          <div><label>Currency</label><input value={a.currency} maxLength={3} onChange={(e) => setA({ ...a, currency: e.target.value.toUpperCase() })} /></div>
          <div><label>Starting balance</label><input type="number" value={a.startingBalance} onChange={(e) => setA({ ...a, startingBalance: +e.target.value })} /></div>
        </div>
        <p><button className="btn" onClick={() => { j.setAccount(a); setSaved(true); setTimeout(() => setSaved(false), 1500); }}>{saved ? "Saved ✓" : "Save"}</button></p>
        <p className="note">Don't enter passwords or API secrets anywhere in this app. It doesn't need them.</p>
      </div>
      <div className="card">
        <h3>Your data ({j.trades.length} trades)</h3>
        <p className="muted">Stored in <code>data/journal.json</code> on this PC. Download a backup now and then.</p>
        <div className="bar">
          <button className="btn" onClick={() => download(`trade-journal-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ trades: j.trades, account: j.account }, null, 2))}>Download backup (JSON)</button>
          <button className="btn ghost" onClick={() => download("trades.csv", tradesToCsv(j.trades), "text/csv")}>Export CSV</button>
        </div>
        <div><label>Restore from backup</label><input type="file" accept=".json" onChange={(e) => e.target.files?.[0] && restore(e.target.files[0])} /></div>
        <p><button className="btn danger" onClick={() => confirm("Delete ALL trades from the journal? The next MT5 sync will bring broker trades back, but your notes and tags will be lost.") && j.setTrades(() => [])}>Delete all trades</button></p>
      </div>
    </div>
    <div className="card">
      <details className="fold">
        <summary>Import a CSV (other brokers, old history, demo data)</summary>
        <ImportPanel j={j} done={() => {}} />
      </details>
    </div>
    </div>
  );
}
