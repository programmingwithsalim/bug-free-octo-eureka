import { isLocalRequest, readBotLog, readBotStatus } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isLocalRequest(req)) return Response.json({ error: "Local access only" }, { status: 403 });
  const [{ running, status }, log] = await Promise.all([readBotStatus(), readBotLog(100)]);
  return Response.json({ running, status, log });
}
