import { isLocalRequest, readJournal, runAnalysis, storageKind, storedAnalyses } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** GET: analyses already stored (Postgres only). */
export async function GET(req: Request) {
  if (!isLocalRequest(req)) return Response.json({ error: "Local access only" }, { status: 403 });
  try {
    return Response.json({ analyses: await storedAnalyses(), storage: storageKind() });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

/** POST { ids?: string[], force?: boolean }: analyse missing trades (all, or just `ids`) from MT5 candles and store the results. */
export async function POST(req: Request) {
  if (!isLocalRequest(req)) return Response.json({ error: "Local access only" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { ids?: unknown; force?: unknown };
  try {
    const journal = await readJournal();
    let trades = journal?.trades ?? [];
    if (Array.isArray(body.ids)) {
      const want = new Set(body.ids.filter((x): x is string => typeof x === "string"));
      trades = trades.filter((t) => want.has(t.id));
    }
    return Response.json(await runAnalysis(trades, body.force === true));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
