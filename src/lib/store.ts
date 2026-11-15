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
 * The journal lives in data/journal.json on this PC (via /api/journal). localStorage is kept as a
 * mirror/fallback, and any journal found there is migrated to the file on first run.
 */
export function useJournal() {
  const [state, setState] = useState<Persisted>({ trades: [], account: DEFAULT_ACCOUNT });
  const [ready, setReady] = useState(false);
  const [fileOk, setFileOk] = useState(true);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    (async () => {
      const local = load();
      try {
        const r = await fetch("/api/journal");
        const { journal } = await r.json();
        // server file wins; if there is none yet, adopt whatever this browser had
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
  return { ...state, ready, fileOk, syncing, syncMt5, setTrades, setAccount, replaceAll };
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
