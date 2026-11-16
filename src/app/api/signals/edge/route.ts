import { getCandles, isLocalRequest, readJournal } from "@/lib/server";
import { liveFeatures, SIGNAL_LOOKBACK_SEC, type LiveFeatures } from "@/lib/signals";

export const dynamic = "force-dynamic";

/** The symbols you actually trade, most used first. */
async function mySymbols(max = 3): Promise<string[]> {
  const counts = new Map<string, number>();
  for (const t of (await readJournal())?.trades ?? []) counts.set(t.symbol, (counts.get(t.symbol) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([s]) => s);
}

/** GET /api/signals[?symbols=A,B] - entry features of the live market for a hypothetical long/short (read-only MT5). */
export async function GET(req: Request) {
  if (!isLocalRequest(req)) return Response.json({ error: "Local access only" }, { status: 403 });
  const q = new URL(req.url).searchParams.get("symbols");
  const symbols = (q ? q.split(",").map((s) => s.trim()).filter((s) => /^[A-Za-z0-9._#-]{1,24}$/.test(s)).slice(0, 5) : await mySymbols());
  const to = Math.floor(Date.now() / 1000);
  const live: LiveFeatures[] = [], errors: string[] = [];
  for (const s of symbols) {
    try {
      const f = liveFeatures(s, await getCandles(s, "M1", to - SIGNAL_LOOKBACK_SEC, to));
      if (f) live.push(f); else errors.push(`${s}: not enough recent candles (market closed?)`);
    } catch (e) {
      errors.push(`${s}: ${(e as Error).message}`);
    }
  }
  return Response.json({ live, errors });
}
