import type { Side, Trade } from "./types";

export type Field =
  | "symbol" | "side" | "openTime" | "closeTime" | "entry" | "exit" | "size"
  | "pnl" | "commission" | "swap" | "stopLoss" | "takeProfit" | "notes" | "setup";

export const FIELD_LABELS: Record<Field, string> = {
  symbol: "Symbol", side: "Side / Type", openTime: "Open time", closeTime: "Close time",
  entry: "Entry price", exit: "Exit price", size: "Size / Lots", pnl: "Profit (P&L)",
  commission: "Commission", swap: "Swap / other fees", stopLoss: "Stop loss", takeProfit: "Take profit",
  notes: "Notes / comment", setup: "Setup / strategy",
};
export const REQUIRED: Field[] = ["symbol", "side", "closeTime", "pnl"];

const ALIASES: Record<Field, string[]> = {
  symbol: ["symbol", "instrument", "pair", "ticker", "item", "market", "asset", "contract"],
  side: ["side", "type", "direction", "action", "buy/sell", "position", "order type"],
  openTime: ["open time", "opentime", "entry time", "entry date", "open date", "opened", "time open", "opened at", "open"],
  closeTime: ["close time", "closetime", "exit time", "exit date", "close date", "closed", "time close", "closed at", "close", "time", "date"],
  entry: ["open price", "openprice", "entry price", "entry", "avg entry", "buy price", "price open", "price"],
  exit: ["close price", "closeprice", "exit price", "exit", "avg exit", "sell price", "price close"],
  size: ["size", "volume", "lots", "lot", "qty", "quantity", "amount", "contracts", "units"],
  pnl: ["profit", "pnl", "p&l", "p/l", "net profit", "net p&l", "net pnl", "realized pnl", "realized p&l", "realised pnl", "result", "gain/loss", "net"],
  commission: ["commission", "commissions", "fee", "fees", "comm"],
  swap: ["swap", "rollover", "financing", "taxes"],
  stopLoss: ["s/l", "sl", "stop loss", "stoploss", "stop", "stop price"],
  takeProfit: ["t/p", "tp", "take profit", "takeprofit", "target"],
  notes: ["comment", "comments", "notes", "note", "remarks"],
  setup: ["setup", "strategy", "pattern", "system"],
};

export type Mapping = Partial<Record<Field, string>>;

/** Parse CSV text (auto delimiter, quoted fields). */
export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  text = text.replace(/^﻿/, "");
  const firstLine = text.split(/\r?\n/).find((l) => l.trim()) ?? "";
  const delim = [",", ";", "\t", "|"].map((d) => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); cur = "";
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x.trim())) rows.push(row);
  if (!rows.length) return { headers: [], rows: [] };
  const headers = rows[0].map((h, i) => h.trim() || `Column ${i + 1}`);
  const seen = new Map<string, number>();
  const uniq = headers.map((h) => { const n = seen.get(h) ?? 0; seen.set(h, n + 1); return n ? `${h} (${n + 1})` : h; });
  return {
    headers: uniq,
    rows: rows.slice(1).map((r) => Object.fromEntries(uniq.map((h, i) => [h, (r[i] ?? "").trim()]))),
  };
}

const norm = (s: string) => s.toLowerCase().replace(/\s*\/\s*/g, "/").replace(/[_\-]/g, " ").replace(/\s+/g, " ").trim();

export function autoMap(headers: string[]): Mapping {
  const m: Mapping = {};
  const used = new Set<string>();
  const nh = headers.map((h) => [h, norm(h)] as const);
  // exact alias matches first, in priority order of alias list
  for (const field of Object.keys(ALIASES) as Field[]) {
    for (const alias of ALIASES[field]) {
      const hit = nh.find(([h, n]) => !used.has(h) && n === alias);
      if (hit) { m[field] = hit[0]; used.add(hit[0]); break; }
    }
  }
  // MT4/MT5 exports have two "Time" and two "Price" columns: first=open, second=close
  const timeCols = nh.filter(([, n]) => n === "time" || n.startsWith("time ("));
  const priceCols = nh.filter(([, n]) => n === "price" || n.startsWith("price ("));
  if (timeCols.length >= 2) { m.openTime = timeCols[0][0]; m.closeTime = timeCols[1][0]; }
  if (priceCols.length >= 2) { m.entry = priceCols[0][0]; m.exit = priceCols[1][0]; }
  return m;
}

export function parseNumber(v: string | undefined): number | undefined {
  if (v == null) return undefined;
  let s = v.trim();
  if (!s || s === "-") return undefined;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[^\d.,\-+eE]/g, "");
  // 1.234,56 (EU) vs 1,234.56 (US)
  if (s.includes(",") && s.includes(".")) {
    s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (s.includes(",")) {
    s = /,\d{1,2}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
  }
  const n = parseFloat(s);
  if (!isFinite(n)) return undefined;
  return neg ? -Math.abs(n) : n;
}

export function parseDate(v: string | undefined): Date | undefined {
  if (!v) return undefined;
  let s = v.trim();
  if (!s) return undefined;
  // 2024.01.02 10:15:30 -> 2024-01-02T10:15:30
  let m = s.match(/^(\d{4})[.\/-](\d{1,2})[.\/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (m) {
    const [, y, mo, d, h = "0", mi = "0", se = "0", tz] = m;
    if (tz) return new Date(s.replace(/\./g, "-").replace(" ", "T"));
    return new Date(+y, +mo - 1, +d, +h, +mi, +se);
  }
  // dd/mm/yyyy or mm/dd/yyyy [hh:mm[:ss] [AM|PM]]
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/);
  if (m) {
    let [, a, b, y, h = "0", mi = "0", se = "0", ap] = m;
    let day = +a, mon = +b;
    if (mon > 12) [day, mon] = [mon, day]; // clearly mm/dd
    else if (day <= 12 && /\//.test(s)) [day, mon] = [mon, day]; // slash => US mm/dd
    let hh = +h;
    if (ap) { if (/p/i.test(ap) && hh < 12) hh += 12; if (/a/i.test(ap) && hh === 12) hh = 0; }
    const yr = +y < 100 ? 2000 + +y : +y;
    return new Date(yr, mon - 1, day, hh, +mi, +se);
  }
  const d = new Date(s);
  return isNaN(+d) ? undefined : d;
}

export function parseSide(v: string | undefined): Side | undefined {
  const s = (v ?? "").toLowerCase().trim();
  if (/^(buy|long|b|bull)/.test(s)) return "long";
  if (/^(sell|short|s|bear)/.test(s)) return "short";
  return undefined;
}

export function tradeId(t: Pick<Trade, "symbol" | "openTime" | "closeTime" | "entry" | "size" | "pnl">) {
  const str = [t.symbol, t.openTime, t.closeTime, t.entry, t.size, t.pnl].join("|");
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return "t" + (h >>> 0).toString(36);
}

export interface ImportResult { trades: Trade[]; skipped: { row: number; reason: string }[] }

export function rowsToTrades(rows: Record<string, string>[], map: Mapping): ImportResult {
  const trades: Trade[] = [];
  const skipped: ImportResult["skipped"] = [];
  const seen = new Map<string, number>();
  const get = (r: Record<string, string>, f: Field) => (map[f] ? r[map[f]!] : undefined);
  rows.forEach((r, i) => {
    const side = parseSide(get(r, "side"));
    const symbol = get(r, "symbol")?.trim();
    const close = parseDate(get(r, "closeTime"));
    const open = parseDate(get(r, "openTime")) ?? close;
    const pnlRaw = parseNumber(get(r, "pnl"));
    if (!side) return skipped.push({ row: i + 2, reason: "Side is not buy/sell (balance or non-trade row?)" }), void 0;
    if (!symbol) return skipped.push({ row: i + 2, reason: "Missing symbol" }), void 0;
    if (!close || !open) return skipped.push({ row: i + 2, reason: "Unreadable date" }), void 0;
    if (pnlRaw == null) return skipped.push({ row: i + 2, reason: "Missing profit" }), void 0;
    const commission = Math.abs(parseNumber(get(r, "commission")) ?? 0);
    const swapRaw = parseNumber(get(r, "swap")) ?? 0;
    // Many exports list profit gross and commission/swap separately (MT4/MT5). If a separate
    // commission/swap column is mapped we treat profit as gross and deduct them.
    const hasExtra = !!(map.commission || map.swap);
    const pnl = hasExtra ? pnlRaw - commission + swapRaw : pnlRaw;
    const fees = hasExtra ? commission + (swapRaw < 0 ? -swapRaw : 0) : 0;
    const base = {
      symbol: symbol.toUpperCase(), side,
      openTime: open.toISOString(), closeTime: close.toISOString(),
      entry: parseNumber(get(r, "entry")) ?? 0, exit: parseNumber(get(r, "exit")) ?? 0,
      size: Math.abs(parseNumber(get(r, "size")) ?? 1),
      pnl: Math.round(pnl * 100) / 100, fees: Math.round(fees * 100) / 100,
    };
    let id = tradeId(base);
    const n = seen.get(id) ?? 0; seen.set(id, n + 1);
    if (n) id += `-${n}`; // identical fills in the same file stay distinct
    trades.push({
      id, ...base,
      stopLoss: nz(parseNumber(get(r, "stopLoss"))), takeProfit: nz(parseNumber(get(r, "takeProfit"))),
      setup: get(r, "setup")?.trim() || undefined,
      notes: get(r, "notes")?.trim() || undefined,
      tags: [],
    });
  });
  return { trades, skipped };
}

const nz = (n: number | undefined) => (n ? n : undefined); // 0 stop = "not set" in MT4

/** Merge imported trades into existing, ignoring ids that already exist. */
export function mergeTrades(existing: Trade[], incoming: Trade[]) {
  const ids = new Set(existing.map((t) => t.id));
  const fresh = incoming.filter((t) => !ids.has(t.id));
  return { merged: [...existing, ...fresh], added: fresh.length, duplicates: incoming.length - fresh.length };
}
