import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { DEFAULT_ACCOUNT, type AccountSettings, type Trade } from "./types";
import type { CandleRow } from "./chart";

/** Postgres is used when DATABASE_URL is set (see `npm run db:setup`); otherwise the app keeps using data/*.json. */
export const dbConfigured = () => !!process.env.DATABASE_URL;

const g = globalThis as unknown as { __pgPool?: Pool; __pgReady?: Promise<void> };

export function pool(): Pool {
  return (g.__pgPool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 5 })); // survives dev hot-reload
}

/** Creates tables if missing (idempotent). A failed attempt is retried on the next call. */
export function ensureSchema(): Promise<void> {
  if (!g.__pgReady) {
    const sql = fs.readFileSync(path.join(process.cwd(), "db", "schema.sql"), "utf8");
    g.__pgReady = pool().query(sql).then(() => undefined, (e) => { g.__pgReady = undefined; throw e; });
  }
  return g.__pgReady;
}

export interface Persisted { trades: Trade[]; account: AccountSettings }

export async function dbReadJournal(): Promise<Persisted | null> {
  await ensureSchema();
  const [t, a] = await Promise.all([
    pool().query("SELECT data FROM trades ORDER BY close_time"),
    pool().query("SELECT data FROM account WHERE id = 1"),
  ]);
  if (!t.rowCount && !a.rowCount) return null;
  return { trades: t.rows.map((r) => r.data as Trade), account: { ...DEFAULT_ACCOUNT, ...(a.rows[0]?.data ?? {}) } };
}

const CHUNK = 200;

/** Replace the stored journal with `p`: upsert changed trades, delete removed ones, all in one transaction. */
export async function dbWriteJournal(p: Persisted) {
  await ensureSchema();
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < p.trades.length; i += CHUNK) {
      const rows = p.trades.slice(i, i + CHUNK);
      const vals: unknown[] = [];
      const tuples = rows.map((t, k) => {
        vals.push(t.id, t.symbol, t.side, t.openTime, t.closeTime, t.entry ?? null, t.exit ?? null, t.size ?? null, t.pnl, t.fees ?? 0, JSON.stringify(t));
        const o = k * 11;
        return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9},$${o + 10},$${o + 11}::jsonb)`;
      });
      await client.query(
        `INSERT INTO trades (id,symbol,side,open_time,close_time,entry,exit,size,pnl,fees,data) VALUES ${tuples.join(",")}
         ON CONFLICT (id) DO UPDATE SET symbol=EXCLUDED.symbol, side=EXCLUDED.side, open_time=EXCLUDED.open_time, close_time=EXCLUDED.close_time,
           entry=EXCLUDED.entry, exit=EXCLUDED.exit, size=EXCLUDED.size, pnl=EXCLUDED.pnl, fees=EXCLUDED.fees, data=EXCLUDED.data, updated_at=now()
         WHERE trades.data IS DISTINCT FROM EXCLUDED.data`,
        vals,
      );
    }
    await client.query("DELETE FROM trades WHERE NOT (id = ANY($1::text[]))", [p.trades.map((t) => t.id)]);
    await client.query(
      `INSERT INTO account (id, data) VALUES (1, $1::jsonb)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now() WHERE account.data IS DISTINCT FROM EXCLUDED.data`,
      [JSON.stringify(p.account)],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function dbGetAnalyses(version: number, ids?: string[]): Promise<Record<string, unknown>> {
  await ensureSchema();
  const r = ids
    ? await pool().query("SELECT trade_id, analysis FROM trade_analysis WHERE version = $1 AND trade_id = ANY($2::text[])", [version, ids])
    : await pool().query("SELECT trade_id, analysis FROM trade_analysis WHERE version = $1", [version]);
  return Object.fromEntries(r.rows.map((x) => [x.trade_id, x.analysis]));
}

export async function dbPutAnalysis(tradeId: string, version: number, analysis: unknown) {
  await ensureSchema();
  await pool().query(
    `INSERT INTO trade_analysis (trade_id, version, analysis) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (trade_id) DO UPDATE SET version = EXCLUDED.version, analysis = EXCLUDED.analysis, created_at = now()`,
    [tradeId, version, JSON.stringify(analysis)],
  );
}

export async function dbGetCandles(key: string): Promise<CandleRow[] | null> {
  await ensureSchema();
  const r = await pool().query("SELECT candles FROM candles_cache WHERE key = $1", [key]);
  return r.rowCount ? (r.rows[0].candles as CandleRow[]) : null;
}

export async function dbPutCandles(key: string, candles: CandleRow[]) {
  await ensureSchema();
  await pool().query("INSERT INTO candles_cache (key, candles) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING", [key, JSON.stringify(candles)]);
}
