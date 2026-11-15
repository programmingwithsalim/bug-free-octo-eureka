import { isLocalRequest, readJournal, writeJournal } from "@/lib/server";

export const dynamic = "force-dynamic";
const deny = () => Response.json({ error: "Local access only" }, { status: 403 });

export async function GET(req: Request) {
  if (!isLocalRequest(req)) return deny();
  return Response.json({ journal: await readJournal() });
}

export async function PUT(req: Request) {
  if (!isLocalRequest(req)) return deny();
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.trades) || typeof body.account !== "object") {
    return Response.json({ error: "Invalid journal" }, { status: 400 });
  }
  await writeJournal({ trades: body.trades, account: body.account });
  return Response.json({ ok: true });
}
