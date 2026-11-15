import { isLocalRequest, readJournal, storageKind, writeJournal } from "@/lib/server";

export const dynamic = "force-dynamic";
const deny = () => Response.json({ error: "Local access only" }, { status: 403 });

export async function GET(req: Request) {
  if (!isLocalRequest(req)) return deny();
  try {
    return Response.json({ journal: await readJournal(), storage: storageKind() });
  } catch (e) {
    return Response.json({ error: `Storage error: ${(e as Error).message}` }, { status: 500 });
  }
}

const validTrade = (t: any) =>
  t && typeof t.id === "string" && t.id && typeof t.symbol === "string" && (t.side === "long" || t.side === "short") &&
  !isNaN(+new Date(t.openTime)) && !isNaN(+new Date(t.closeTime)) && typeof t.pnl === "number" && isFinite(t.pnl);

export async function PUT(req: Request) {
  if (!isLocalRequest(req)) return deny();
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.trades) || typeof body.account !== "object" || !body.account) {
    return Response.json({ error: "Invalid journal" }, { status: 400 });
  }
  if (!body.trades.every(validTrade)) return Response.json({ error: "Journal contains an invalid trade" }, { status: 400 });
  if (new Set(body.trades.map((t: any) => t.id)).size !== body.trades.length) return Response.json({ error: "Duplicate trade ids" }, { status: 400 });
  try {
    await writeJournal({ trades: body.trades, account: body.account });
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: `Storage error: ${(e as Error).message}` }, { status: 500 });
  }
}
