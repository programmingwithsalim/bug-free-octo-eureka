import { promises as fs } from "fs";
import path from "path";
import { execFile, spawn } from "child_process";
import type { CandleRow } from "./chart";
import { DEFAULT_BOT_CONFIG, sanitizeBotConfig, type BotConfig, type BotLogEntry, type BotStatus } from "./bot";
import { DEFAULT_ACCOUNT, type AccountSettings, type Trade } from "./types";
import type { Mt5Export } from "./mt5";

import { dbConfigured, dbGetAnalyses, dbGetCandles, dbPutAnalysis, dbPutCandles, dbReadJournal, dbWriteJournal } from "./db";
import { ANALYSIS_VERSION, LOOKAHEAD_SEC, LOOKBACK_SEC, analyzeTrade, type Analysis } from "./analysis";
export type { Persisted } from "./db";
import type { Persisted } from "./db";

const DATA_DIR = process.env.JOURNAL_DATA_DIR ?? path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "journal.json");

export const storageKind = () => (dbConfigured() ? "postgres" : "file");

async function readJournalFile(): Promise<Persisted | null> {
  try {
    const p = JSON.parse(await fs.readFile(FILE, "utf8"));
    return { trades: p.trades ?? [], account: { ...DEFAULT_ACCOUNT, ...p.account } };
  } catch {
    return null; // no file yet
  }
}

/** Atomic write (temp file + rename) so a crash never leaves a half-written journal. */
async function writeJournalFile(p: Persisted) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(p, null, 2));
  await fs.rename(tmp, FILE);
}

/** Postgres when DATABASE_URL is set, otherwise data/journal.json. The first Postgres read imports an existing journal.json. */
export async function readJournal(): Promise<Persisted | null> {
  if (!dbConfigured()) return readJournalFile();
  const j = await dbReadJournal();
  if (j) return j;
  const legacy = await readJournalFile();
  if (legacy) await dbWriteJournal(legacy); // one-time migration; journal.json is left in place as a backup
  return legacy;
}

export async function writeJournal(p: Persisted) {
  return dbConfigured() ? dbWriteJournal(p) : writeJournalFile(p);
}

/** The API controls the local filesystem and spawns Python, so only answer to this machine. */
export function isLocalRequest(req: Request) {
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "");
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

export function runMt5Export(days: number): Promise<Mt5Export> {
  const script = path.join(process.cwd(), "mt5-bridge", "mt5_export.py");
  const python = process.env.PYTHON ?? "python";
  return new Promise((resolve, reject) => {
    execFile(python, [script, "--days", String(days)], { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      let out: any;
      try { out = JSON.parse(stdout); } catch {}
      if (out?.ok) return resolve(out);
      reject(new Error(out?.error ?? (err ? `Could not run Python (${err.message}). Is "${python}" on your PATH?` : "Empty response from MT5 script")));
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Trade manager (mt5-bridge/trade_manager.py) - its files live next to the journal in DATA_DIR
// ---------------------------------------------------------------------------------------------
const botFile = (n: string) => path.join(DATA_DIR, n);
const HEARTBEAT_MS = 6000;

export async function readBotConfig(): Promise<BotConfig> {
  try { return sanitizeBotConfig(JSON.parse(await fs.readFile(botFile("bot-config.json"), "utf8"))); } catch { return DEFAULT_BOT_CONFIG; }
}
export async function writeBotConfig(c: BotConfig) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = botFile("bot-config.json.tmp");
  await fs.writeFile(tmp, JSON.stringify(c, null, 2));
  await fs.rename(tmp, botFile("bot-config.json"));
}
export async function readBotStatus(): Promise<{ running: boolean; status: BotStatus | null }> {
  try {
    const s: BotStatus = JSON.parse(await fs.readFile(botFile("bot-status.json"), "utf8"));
    return { running: Date.now() - s.ts * 1000 < HEARTBEAT_MS, status: s };
  } catch { return { running: false, status: null }; }
}
export async function readBotLog(n = 100): Promise<BotLogEntry[]> {
  try {
    const text = await fs.readFile(botFile("bot-log.jsonl"), "utf8");
    return text.split("\n").filter(Boolean).slice(-n).map((l) => JSON.parse(l)).reverse();
  } catch { return []; }
}
export async function startBot(): Promise<void> {
  if ((await readBotStatus()).running) return;
  await fs.mkdir(DATA_DIR, { recursive: true });
  const script = path.join(process.cwd(), "mt5-bridge", "trade_manager.py");
  // detached: the manager keeps running if the web server restarts
  spawn(process.env.PYTHON ?? "python", [script, "--data-dir", DATA_DIR], { detached: true, stdio: "ignore", windowsHide: true, cwd: path.dirname(script) }).unref();
}
/** Candles for a closed window never change, so they are cached on disk (works later even with MT5 closed). */
export async function getCandles(symbol: string, tf: string, from: number, to: number): Promise<CandleRow[]> {
  const key = `${symbol.replace(/[^A-Za-z0-9._-]/g, "_")}_${tf}_${from}_${to}`;
  const cacheDir = path.join(DATA_DIR, "candles");
  const cache = path.join(cacheDir, `${key}.json`);
  if (dbConfigured()) {
    const hit = await dbGetCandles(key).catch(() => null);
    if (hit) return hit;
  }
  try { return JSON.parse(await fs.readFile(cache, "utf8")); } catch {}
  const script = path.join(process.cwd(), "mt5-bridge", "mt5_candles.py");
  const python = process.env.PYTHON ?? "python";
  const out: any = await new Promise((resolve, reject) => {
    execFile(python, [script, "--symbol", symbol, "--from", String(from), "--to", String(to), "--tf", tf], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      let o: any;
      try { o = JSON.parse(stdout); } catch {}
      if (o?.ok) return resolve(o);
      reject(new Error(o?.error ?? (err ? `Could not run Python (${err.message}). Is "${python}" on your PATH?` : "Empty response from MT5 script")));
    });
  });
  if (to < Date.now() / 1000 - 120) { // only cache once the window is fully in the past
    if (dbConfigured()) await dbPutCandles(key, out.candles).catch(() => {});
    else {
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(cache, JSON.stringify(out.candles));
    }
  }
  return out.candles;
}

// ---------------------------------------------------------------------------------------------
// Hindsight analysis: batch candles + engine + storage
// ---------------------------------------------------------------------------------------------
interface Window { symbol: string; from: number; to: number }
const m1Key = (w: Window) => `${w.symbol.replace(/[^A-Za-z0-9._-]/g, "_")}_M1_${w.from}_${w.to}`;

/** M1 candles for many windows with ONE MT5 connection. Cached windows are served locally. */
export async function getCandlesBatch(windows: Window[]): Promise<(CandleRow[] | null)[]> {
  const out: (CandleRow[] | null)[] = windows.map(() => null);
  const missing: number[] = [];
  for (let i = 0; i < windows.length; i++) {
    const key = m1Key(windows[i]);
    let hit: CandleRow[] | null = null;
    if (dbConfigured()) hit = await dbGetCandles(key).catch(() => null);
    if (!hit) { try { hit = JSON.parse(await fs.readFile(path.join(DATA_DIR, "candles", `${key}.json`), "utf8")); } catch {} }
    if (hit) out[i] = hit; else missing.push(i);
  }
  if (!missing.length) return out;

  const script = path.join(process.cwd(), "mt5-bridge", "mt5_candles.py");
  const fetched: { ok: boolean; error?: string; results?: (CandleRow[] | null)[] } = await new Promise((resolve, reject) => {
    const child = spawn(process.env.PYTHON ?? "python", [script, "--batch"], { windowsHide: true });
    let stdout = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("MT5 candle export timed out")); }, 5 * 60_000);
    child.stdout.on("data", (d) => (stdout += d));
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(`Could not run Python (${e.message})`)); });
    child.on("close", () => { clearTimeout(timer); try { resolve(JSON.parse(stdout)); } catch { reject(new Error("Empty response from MT5 script")); } });
    child.stdin.end(JSON.stringify(missing.map((i) => windows[i])));
  });
  if (!fetched.ok) throw new Error(fetched.error ?? "MT5 candle export failed");
  const now = Date.now() / 1000;
  for (let k = 0; k < missing.length; k++) {
    const rows = fetched.results?.[k] ?? null, w = windows[missing[k]];
    out[missing[k]] = rows;
    if (rows && w.to < now - 120) { // finished windows never change: cache them
      if (dbConfigured()) await dbPutCandles(m1Key(w), rows).catch(() => {});
      else {
        await fs.mkdir(path.join(DATA_DIR, "candles"), { recursive: true });
        await fs.writeFile(path.join(DATA_DIR, "candles", `${m1Key(w)}.json`), JSON.stringify(rows));
      }
    }
  }
  return out;
}

const MAX_HOLD_SEC = 12 * 3600; // very long holds would need huge candle sets; skip them

/** Analyse trades that have no stored analysis yet (or all, with force). Stores results in Postgres when configured. */
export async function runAnalysis(trades: Trade[], force = false): Promise<{ analyses: Record<string, Analysis>; computed: number; failed: number }> {
  const analyses: Record<string, Analysis> = dbConfigured() && !force ? ((await dbGetAnalyses(ANALYSIS_VERSION, trades.map((t) => t.id))) as Record<string, Analysis>) : {};
  const todo = trades.filter((t) => !analyses[t.id]);
  const eligible: Trade[] = [];
  let failed = 0;
  for (const t of todo) {
    const hold = (+new Date(t.closeTime) - +new Date(t.openTime)) / 1000;
    if (hold > MAX_HOLD_SEC || !(t.entry > 0) || !(t.exit > 0)) {
      analyses[t.id] = { ...analyzeTrade(t, []), reason: hold > MAX_HOLD_SEC ? "Trade lasted longer than 12 hours; not analysed." : "Trade has no entry/exit price." };
      failed++;
    } else eligible.push(t);
  }
  const windows = eligible.map((t) => ({
    symbol: t.symbol,
    from: Math.floor(+new Date(t.openTime) / 1000) - LOOKBACK_SEC,
    to: Math.ceil(+new Date(t.closeTime) / 1000) + LOOKAHEAD_SEC,
  }));
  const candles = eligible.length ? await getCandlesBatch(windows) : [];
  let computed = 0;
  for (let i = 0; i < eligible.length; i++) {
    const t = eligible[i];
    const a = analyzeTrade(t, candles[i] ?? []);
    analyses[t.id] = a;
    if (a.ok) {
      computed++;
      if (dbConfigured()) await dbPutAnalysis(t.id, ANALYSIS_VERSION, a).catch(() => {});
    } else failed++;
  }
  return { analyses, computed, failed };
}

export async function storedAnalyses(): Promise<Record<string, Analysis>> {
  return dbConfigured() ? ((await dbGetAnalyses(ANALYSIS_VERSION)) as Record<string, Analysis>) : {};
}

export async function stopBot(): Promise<void> {
  const { running, status } = await readBotStatus();
  if (running && status && Number.isInteger(status.pid) && status.pid > 0) {
    try { process.kill(status.pid); } catch {}
  }
  await fs.rm(botFile("bot-status.json"), { force: true });
}
