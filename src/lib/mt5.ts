import type { AccountSettings, Trade } from "./types";

export interface Mt5Account {
  login: number; server: string; company: string; currency: string; balance: number; leverage: number;
}
export interface Mt5Export { ok: true; account: Mt5Account; netDeposits?: number; firstDeposit?: number; trades: (Omit<Trade, "stopLoss" | "takeProfit"> & { stopLoss?: number | null; takeProfit?: number | null })[] }

/** Fields owned by the broker; everything else on a trade is the user's journal and is never overwritten. */
const BROKER_FIELDS = ["symbol", "side", "openTime", "closeTime", "entry", "exit", "size", "pnl", "fees"] as const;

/** Insert new MT5 trades and refresh broker fields on known ones, keeping notes/tags/ratings. */
export function mergeMt5(existing: Trade[], incoming: Mt5Export["trades"]) {
  const byId = new Map(existing.map((t) => [t.id, t]));
  let added = 0, updated = 0;
  for (const raw of incoming) {
    const inc: Trade = { ...raw, stopLoss: raw.stopLoss ?? undefined, takeProfit: raw.takeProfit ?? undefined } as Trade;
    const cur = byId.get(inc.id);
    if (!cur) { byId.set(inc.id, inc); added++; continue; }
    const changed = BROKER_FIELDS.some((f) => cur[f] !== inc[f]);
    byId.set(inc.id, {
      ...cur,
      ...Object.fromEntries(BROKER_FIELDS.map((f) => [f, inc[f]])),
      stopLoss: inc.stopLoss ?? cur.stopLoss,
      takeProfit: inc.takeProfit ?? cur.takeProfit,
    });
    if (changed) updated++;
  }
  return { trades: [...byId.values()], added, updated };
}

/** Fill broker/currency from the MT5 account; keep a name the user already chose. */
export function applyMt5Account(acc: AccountSettings, m: Mt5Account): AccountSettings {
  return {
    ...acc,
    broker: m.company || acc.broker,
    currency: m.currency || acc.currency,
    name: acc.name === "Main account" ? `${m.company || "MT5"} #${m.login}` : acc.name,
  };
}

/** Balance at the start of the exported window = balance now - trading P&L - net deposits. */
export function inferStartingBalance(balance: number, trades: { pnl: number }[], netDeposits = 0, firstDeposit = 0) {
  const start = balance - trades.reduce((s, t) => s + t.pnl, 0) - netDeposits;
  if (start > 0.01) return Math.round(start * 100) / 100;
  // the window covers the whole account life (it started at 0): use the first deposit as the base
  return firstDeposit > 0 ? firstDeposit : balance;
}
