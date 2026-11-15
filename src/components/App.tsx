"use client";
import { useCallback, useEffect, useState } from "react";
import { useJournal } from "@/lib/store";
import Dashboard from "./Dashboard";
import Journal from "./Journal";
import Insights from "./Insights";
import ImportPanel from "./ImportPanel";
import SettingsPanel from "./SettingsPanel";

const TABS = ["Dashboard", "Journal", "Insights", "Import", "Settings"] as const;
type Tab = (typeof TABS)[number];

export default function App() {
  const j = useJournal();
  const [tab, setTab] = useState<Tab>("Dashboard");
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const { ready, fileOk, syncMt5 } = j;

  const sync = useCallback(async () => setStatus(await syncMt5()), [syncMt5]);
  // pull from MT5 when the app opens, then every 5 minutes while it stays open
  useEffect(() => {
    if (!ready || !fileOk) return;
    sync();
    const id = setInterval(sync, 5 * 60_000);
    return () => clearInterval(id);
  }, [ready, fileOk, sync]);

  if (!j.ready) return <div className="wrap muted">Loading…</div>;
  return (
    <div className="wrap">
      <header className="top">
        <h1>📈 Trade Journal <span className="muted">· {j.account.name}</span></h1>
        <nav>
          {TABS.map((t) => (
            <button key={t} className={t === tab ? "on" : ""} onClick={() => setTab(t)}>{t}</button>
          ))}
        </nav>
        <div className="muted">
          <button className="btn" disabled={j.syncing} onClick={sync}>{j.syncing ? "Syncing…" : "Sync MT5"}</button>{" "}
          {status && <span className={status.ok ? "pos" : "neg"}>{status.message}</span>}
        </div>
      </header>
      {!j.fileOk && <div className="note neg">Can't reach the local journal file. Run the app with <code>npm run dev</code> on this PC; changes are only saved in this browser until then.</div>}
      {tab === "Dashboard" && <Dashboard j={j} go={setTab} />}
      {tab === "Journal" && <Journal j={j} />}
      {tab === "Insights" && <Insights j={j} go={setTab} />}
      {tab === "Import" && <ImportPanel j={j} done={() => setTab("Dashboard")} />}
      {tab === "Settings" && <SettingsPanel j={j} />}
    </div>
  );
}

export type JournalApi = ReturnType<typeof useJournal>;
export type { Tab };
