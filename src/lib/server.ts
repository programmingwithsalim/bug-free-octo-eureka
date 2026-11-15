import { promises as fs } from "fs";
import path from "path";
import { execFile, spawn } from "child_process";
import { DEFAULT_BOT_CONFIG, sanitizeBotConfig, type BotConfig, type BotLogEntry, type BotStatus } from "./bot";
import { DEFAULT_ACCOUNT, type AccountSettings, type Trade } from "./types";
import type { Mt5Export } from "./mt5";

export interface Persisted { trades: Trade[]; account: AccountSettings }

const DATA_DIR = process.env.JOURNAL_DATA_DIR ?? path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "journal.json");

export async function readJournal(): Promise<Persisted | null> {
  try {
    const p = JSON.parse(await fs.readFile(FILE, "utf8"));
    return { trades: p.trades ?? [], account: { ...DEFAULT_ACCOUNT, ...p.account } };
  } catch {
    return null; // no file yet
  }
}

/** Atomic write (temp file + rename) so a crash never leaves a half-written journal. */
export async function writeJournal(p: Persisted) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(p, null, 2));
  await fs.rename(tmp, FILE);
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
export async function stopBot(): Promise<void> {
  const { running, status } = await readBotStatus();
  if (running && status && Number.isInteger(status.pid) && status.pid > 0) {
    try { process.kill(status.pid); } catch {}
  }
  await fs.rm(botFile("bot-status.json"), { force: true });
}
