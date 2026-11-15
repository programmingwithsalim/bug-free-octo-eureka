import { getCandles, isLocalRequest } from "@/lib/server";
import { validateCandleRequest } from "@/lib/chart";

export const dynamic = "force-dynamic";

/** GET /api/candles?symbol=XAUUSDm&tf=M5&from=<epoch s>&to=<epoch s> - read-only price history from MT5. */
export async function GET(req: Request) {
  if (!isLocalRequest(req)) return Response.json({ error: "Local access only" }, { status: 403 });
  const q = new URL(req.url).searchParams;
  const symbol = q.get("symbol") ?? "", tf = q.get("tf") ?? "", from = Number(q.get("from")), to = Number(q.get("to"));
  const bad = validateCandleRequest(symbol, tf, from, to);
  if (bad) return Response.json({ error: bad }, { status: 400 });
  try {
    return Response.json({ candles: await getCandles(symbol, tf, from, to) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
