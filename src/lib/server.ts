import { promises as fs } from "fs";
import path from "path";
import { execFile } from "child_process";
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
