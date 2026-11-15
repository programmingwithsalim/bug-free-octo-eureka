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

/** All data lives in this browser (localStorage). Nothing is sent to a server. */
export function useJournal() {
  const [state, setState] = useState<Persisted>({ trades: [], account: DEFAULT_ACCOUNT });
  const [ready, setReady] = useState(false);

  useEffect(() => { setState(load()); setReady(true); }, []);
  useEffect(() => {
    if (!ready) return;
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {}
  }, [state, ready]);

  const setTrades = useCallback((fn: (t: Trade[]) => Trade[]) => setState((s) => ({ ...s, trades: fn(s.trades) })), []);
  const setAccount = useCallback((a: AccountSettings) => setState((s) => ({ ...s, account: a })), []);
  const replaceAll = useCallback((p: Persisted) => setState({ trades: p.trades ?? [], account: { ...DEFAULT_ACCOUNT, ...p.account } }), []);
  return { ...state, ready, setTrades, setAccount, replaceAll };
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
