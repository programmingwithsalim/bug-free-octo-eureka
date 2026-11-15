import type { Tab } from "./App";
export default function Empty({ go }: { go: (t: Tab) => void }) {
  return (
    <div className="card empty">
      <h2 style={{ color: "var(--text)" }}>No trades yet</h2>
      <p>Open MetaTrader 5, log in, and press <b>Sync MT5</b> in the sidebar. You can also add trades by hand or import a CSV from Settings.</p>
      <div className="chips" style={{ justifyContent: "center" }}>
        <button className="btn" onClick={() => go("Journal")}>Add a trade</button>
        <button className="btn ghost" onClick={() => go("Settings")}>Import CSV / demo data</button>
      </div>
    </div>
  );
}
