"use client";
import { useCallback, useEffect, useState } from "react";
import { useJournal } from "@/lib/store";
import { useTheme } from "@/lib/theme";
import Dashboard from "./Dashboard";
import CalendarView from "./CalendarView";
import Journal from "./Journal";
import Insights from "./Insights";
import SettingsPanel from "./SettingsPanel";

const TABS = [
  { id: "Dashboard", icon: "▦" },
  { id: "Calendar", icon: "▤" },
  { id: "Journal", icon: "✎" },
  { id: "Insights", icon: "✦" },
  { id: "Settings", icon: "⚙" },
] as const;
type Tab = (typeof TABS)[number]["id"];

export default function App() {
  const j = useJournal();
  const { theme, setTheme } = useTheme();
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

  if (!ready) return <div className="main muted">Loading…</div>;
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">📈 Trade Journal</div>
        <div className="acct muted">{j.account.name}</div>
        <nav>
          {TABS.map((t) => (
            <button key={t.id} className={t.id === tab ? "on" : ""} onClick={() => setTab(t.id)}>
              <span aria-hidden>{t.icon}</span>{t.id}
            </button>
          ))}
        </nav>
        <div className="foot">
          <button className="btn" disabled={j.syncing} onClick={sync}>{j.syncing ? "Syncing…" : "Sync MT5"}</button>
          {status && <div className={`sync-msg ${status.ok ? "pos" : "neg"}`}>{status.message}</div>}
          <div className="theme-toggle" role="group" aria-label="Theme">
            <button className={theme === "light" ? "on" : ""} onClick={() => setTheme("light")} title="Light theme">☀ Light</button>
            <button className={theme === "dark" ? "on" : ""} onClick={() => setTheme("dark")} title="Dark theme">🌙 Dark</button>
          </div>
        </div>
      </aside>
      <main className="main">
        {!j.fileOk && <div className="note neg" style={{ marginBottom: 14 }}>Can't reach the local journal file. Run the app with <code>npm run dev</code> on this PC; changes are only saved in this browser until then.</div>}
        {tab === "Dashboard" && <Dashboard j={j} go={setTab} theme={theme} />}
        {tab === "Calendar" && <CalendarView j={j} go={setTab} />}
        {tab === "Journal" && <Journal j={j} />}
        {tab === "Insights" && <Insights j={j} go={setTab} />}
        {tab === "Settings" && <SettingsPanel j={j} />}
      </main>
    </div>
  );
}

export type JournalApi = ReturnType<typeof useJournal>;
export type { Tab };
