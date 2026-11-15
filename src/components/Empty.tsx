import type { Tab } from "./App";
export default function Empty({ go }: { go: (t: Tab) => void }) {
  return (
    <div className="card empty">
      <h2 style={{ color: "var(--text)" }}>No trades yet</h2>
      <p>Import your broker history (CSV), add trades by hand, or load demo data to explore.</p>
      <div className="chips" style={{ justifyContent: "center" }}>
        <button className="btn" onClick={() => go("Import")}>Import trades</button>
        <button className="btn ghost" onClick={() => go("Journal")}>Add a trade</button>
      </div>
    </div>
  );
}
