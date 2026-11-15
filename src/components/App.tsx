"use client";
import { useState } from "react";
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
      </header>
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
