"use client";
import { useCallback, useEffect, useState } from "react";
import { CalendarDays, Check, LayoutDashboard, LineChart, Moon, NotebookPen, RefreshCw, Settings, Sparkles, Sun, TriangleAlert } from "lucide-react";
import { useJournal } from "@/lib/store";
import { useTheme } from "@/lib/theme";
import Dashboard from "./Dashboard";
import CalendarView from "./CalendarView";
import Journal from "./Journal";
import Insights from "./Insights";
import SettingsPanel from "./SettingsPanel";
import Seg from "./Seg";

const TABS = [
  { id: "Dashboard", icon: LayoutDashboard },
  { id: "Calendar", icon: CalendarDays },
  { id: "Journal", icon: NotebookPen },
  { id: "Insights", icon: Sparkles },
  { id: "Settings", icon: Settings },
] as const;
type Tab = (typeof TABS)[number]["id"];

interface Toast { id: number; ok: boolean; message: string }

export default function App() {
  const j = useJournal();
  const { theme, setTheme } = useTheme();
  const [tab, setTab] = useState<Tab>("Dashboard");
  const [toast, setToast] = useState<Toast | null>(null);
  const [last, setLast] = useState<{ ok: boolean; at: Date } | null>(null);
  const { ready, fileOk, syncMt5 } = j;

  const sync = useCallback(async (quiet = false) => {
    const r = await syncMt5();
    setLast({ ok: r.ok, at: new Date() });
    // background refreshes only speak up when something changed or failed
    if (!quiet || !r.ok || !/0 new, 0 updated/.test(r.message)) setToast({ id: Date.now(), ...r });
  }, [syncMt5]);

  // pull from MT5 when the app opens, then every 5 minutes while it stays open
  useEffect(() => {
    if (!ready || !fileOk) return;
    sync();
    const id = setInterval(() => sync(true), 5 * 60_000);
    return () => clearInterval(id);
  }, [ready, fileOk, sync]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), toast.ok ? 3500 : 7000);
    return () => clearTimeout(id);
  }, [toast]);

  if (!ready) {
    return (
      <div className="shell">
        <aside className="side" />
        <main className="main"><div className="grid"><div className="skel" style={{ height: 40, width: 220 }} /><div className="skel" style={{ height: 340 }} /><div className="skel" style={{ height: 160 }} /></div></main>
      </div>
    );
  }
  const idx = TABS.findIndex((t) => t.id === tab);
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand"><span className="logo"><LineChart size={17} /></span>Trade Journal</div>
        <div className="acct muted">{j.account.name}</div>
        <nav style={{ "--idx": idx } as React.CSSProperties}>
          <span className="nav-ind" />
          {TABS.map((t) => (
            <button key={t.id} className={t.id === tab ? "on" : ""} onClick={() => setTab(t.id)}>
              <t.icon size={18} />{t.id}
            </button>
          ))}
        </nav>
        <div className="foot">
          <div className="sync-info">
            <span className={`dot ${last ? (last.ok ? "ok" : "bad") : ""}`} />
            {last ? `${last.ok ? "Synced" : "Sync failed"} ${last.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Not synced yet"}
          </div>
          <button className="btn" disabled={j.syncing} onClick={() => sync()}>
            <RefreshCw size={16} className={j.syncing ? "spin" : ""} />{j.syncing ? "Syncing…" : "Sync MT5"}
          </button>
          <Seg label="Theme" value={theme} onChange={setTheme}
            options={[{ id: "light", label: <Sun size={15} /> }, { id: "dark", label: <Moon size={15} /> }]} />
        </div>
      </aside>
      <main className="main">
        {!j.fileOk && <div className="note neg" style={{ marginBottom: 14 }}>Can't reach the local journal file. Run the app with <code>npm run dev</code> on this PC; changes are only saved in this browser until then.</div>}
        <div className="page" key={tab}>
          {tab === "Dashboard" && <Dashboard j={j} go={setTab} theme={theme} />}
          {tab === "Calendar" && <CalendarView j={j} go={setTab} />}
          {tab === "Journal" && <Journal j={j} />}
          {tab === "Insights" && <Insights j={j} go={setTab} />}
          {tab === "Settings" && <SettingsPanel j={j} />}
        </div>
      </main>
      {toast && (
        <div className={`toast ${toast.ok ? "ok" : "bad"}`} key={toast.id} role="status" onClick={() => setToast(null)}>
          <span className="ico">{toast.ok ? <Check size={16} /> : <TriangleAlert size={16} />}</span>{toast.message}
        </div>
      )}
    </div>
  );
}

export type JournalApi = ReturnType<typeof useJournal>;
export type { Tab };
