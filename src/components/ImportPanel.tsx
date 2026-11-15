"use client";
import { useMemo, useState } from "react";
import type { JournalApi } from "./App";
import { FIELD_LABELS, REQUIRED, autoMap, mergeTrades, parseCsv, rowsToTrades, type Field, type Mapping } from "@/lib/importer";
import { sampleTrades } from "@/lib/sample";

export default function ImportPanel({ j, done }: { j: JournalApi; done: () => void }) {
  const [text, setText] = useState("");
  const [map, setMap] = useState<Mapping>({});
  const [msg, setMsg] = useState("");

  const parsed = useMemo(() => (text ? parseCsv(text) : null), [text]);
  const result = useMemo(() => (parsed ? rowsToTrades(parsed.rows, map) : null), [parsed, map]);
  const missing = REQUIRED.filter((f) => !map[f]);

  const load = async (file: File) => {
    const t = await file.text();
    setText(t);
    setMap(autoMap(parseCsv(t).headers));
    setMsg("");
  };

  const commit = () => {
    if (!result) return;
    const { merged, added, duplicates } = mergeTrades(j.trades, result.trades);
    j.setTrades(() => merged);
    setMsg(`Imported ${added} new trades (${duplicates} duplicates ignored).`);
    setTimeout(done, 900);
  };

  return (
    <div className="grid">
      <div className="note">
        <b>Safe by design:</b> this app never asks for your broker password or API keys. Export your trade history from your platform
        (MT4/MT5 → Account History → right-click → Save as report / CSV; Binance, Bybit, IBKR, TradingView, Tradovate etc. → export trades as CSV) and drop it here.
        Parsing happens in your browser; data is stored only on this device.
      </div>
      <div className="card">
        <h3>1. Choose a CSV file</h3>
        <input type="file" accept=".csv,.tsv,.txt" onChange={(e) => e.target.files?.[0] && load(e.target.files[0])} />
        <p className="muted">Or <button className="btn ghost" onClick={() => { j.setTrades((ts) => mergeTrades(ts, sampleTrades()).merged); done(); }}>load demo data</button> to try the app first.</p>
      </div>

      {parsed && (
        <div className="card">
          <h3>2. Check column mapping</h3>
          <div className="form">
            {(Object.keys(FIELD_LABELS) as Field[]).map((f) => (
              <div key={f}>
                <label>{FIELD_LABELS[f]}{REQUIRED.includes(f) && " *"}</label>
                <select value={map[f] ?? ""} onChange={(e) => setMap((m) => ({ ...m, [f]: e.target.value || undefined }))}>
                  <option value="">— none —</option>
                  {parsed.headers.map((h) => <option key={h}>{h}</option>)}
                </select>
              </div>
            ))}
          </div>
          {missing.length > 0 && <p className="neg">Map required fields: {missing.map((f) => FIELD_LABELS[f]).join(", ")}</p>}
          <p className="muted">If your file lists Profit, Commission and Swap separately (MT4/MT5), map all three — fees are deducted from profit. If Profit is already net, leave Commission/Swap empty.</p>
        </div>
      )}

      {result && !missing.length && (
        <div className="card">
          <h3>3. Preview</h3>
          <p><b>{result.trades.length}</b> trades ready{result.skipped.length > 0 && <>, <span className="muted">{result.skipped.length} rows skipped (e.g. deposits/balance rows)</span></>}.</p>
          {result.skipped.slice(0, 3).map((s) => <div key={s.row} className="muted">Row {s.row}: {s.reason}</div>)}
          <div className="scroll"><table>
            <thead><tr><th>Symbol</th><th>Side</th><th>Opened</th><th>Closed</th><th>Size</th><th>P&L</th></tr></thead>
            <tbody>{result.trades.slice(0, 5).map((t) => <tr key={t.id}><td>{t.symbol}</td><td>{t.side}</td><td>{new Date(t.openTime).toLocaleString()}</td><td>{new Date(t.closeTime).toLocaleString()}</td><td>{t.size}</td><td>{t.pnl}</td></tr>)}</tbody>
          </table></div>
          <p><button className="btn" disabled={!result.trades.length} onClick={commit}>Import {result.trades.length} trades</button></p>
        </div>
      )}
      {msg && <div className="card pos">{msg}</div>}
    </div>
  );
}
