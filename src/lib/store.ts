"use client";
import { useCallback, useEffect, useState } from "react";
import { DEFAULT_ACCOUNT, type AccountSettings, type Trade } from "./types";

const KEY = "trade-journal:v1";
interface Persisted { trades: Trade[]; account: AccountSettings }

function load(): Persisted {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return { trades: p.trades ?? [], account: { ...DEFAULT_ACCOUNT, ...p.account } };
    }
  } catch {}
  return { trades: [], account: DEFAULT_ACCOUNT };
}

export interface SyncResult { ok: boolean; message: string }

/**
 * The journal lives on this PC (via /api/journal): Postgres when DATABASE_URL is set, else data/journal.json.
 * localStorage is only a mirror; a journal found there is adopted on first run when nothing is stored yet.
 */
export function useJournal() {
  const [state, setState] = useState<Persisted>({ trades: [], account: DEFAULT_ACCOUNT });
  const [ready, setReady] = useState(false);
  const [fileOk, setFileOk] = useState(true);
  const [storage, setStorage] = useState<"postgres" | "file">("file");
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    (async () => {
      const local = load();
      try {
        const r = await fetch("/api/journal");
        // A failed read must NEVER fall through to saving: an empty local copy would overwrite the stored journal.
        if (!r.ok) throw new Error("journal storage unavailable");
        const { journal, storage: kind } = await r.json();
        setStorage(kind ?? "file");
        // stored journal wins; if there is none yet, adopt whatever this browser had
        setState(journal ? { trades: journal.trades, account: { ...DEFAULT_ACCOUNT, ...journal.account } } : local);
      } catch {
        setFileOk(false);
        setState(local);
      }
      setReady(true);
    })();
  }, []);

  useEffect(() => {
    if (!ready) return;
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {}
    if (!fileOk) return;
    const t = setTimeout(() => {
      fetch("/api/journal", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(state) })
        .then((r) => setFileOk(r.ok), () => setFileOk(false));
    }, 400);
    return () => clearTimeout(t);
  }, [state, ready, fileOk]);

  const syncMt5 = useCallback(async (days = 90): Promise<SyncResult> => {
    setSyncing(true);
    try {
      const r = await fetch(`/api/mt5/sync?days=${days}`, { method: "POST" });
      const d = await r.json();
      if (!r.ok) return { ok: false, message: d.error ?? "Sync failed" };
      setState({ trades: d.journal.trades, account: { ...DEFAULT_ACCOUNT, ...d.journal.account } });
      return { ok: true, message: `MT5 synced: ${d.added} new, ${d.updated} updated.` };
    } catch (e) {
      return { ok: false, message: `Sync failed: ${(e as Error).message}` };
    } finally {
      setSyncing(false);
    }
  }, []);

  const setTrades = useCallback((fn: (t: Trade[]) => Trade[]) => setState((s) => ({ ...s, trades: fn(s.trades) })), []);
  const setAccount = useCallback((a: AccountSettings) => setState((s) => ({ ...s, account: a })), []);
  const replaceAll = useCallback((p: Persisted) => setState({ trades: p.trades ?? [], account: { ...DEFAULT_ACCOUNT, ...p.account } }), []);
  return { ...state, ready, fileOk, storage, syncing, syncMt5, setTrades, setAccount, replaceAll };
}

export function download(name: string, text: string, type = "application/json") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function tradesToCsv(trades: Trade[]) {
  const cols = ["symbol", "side", "openTime", "closeTime", "entry", "exit", "size", "pnl", "fees", "stopLoss", "takeProfit", "setup", "emotion", "rating", "tags", "notes"] as const;
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [cols.join(","), ...trades.map((t) => cols.map((c) => esc(c === "tags" ? t.tags.join(";") : (t as any)[c])).join(","))].join("\n");
}
