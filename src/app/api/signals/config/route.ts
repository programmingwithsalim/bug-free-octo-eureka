import { isLocalRequest, readAlertsConfig, storedTelegramToken, writeAlertsConfig } from "@/lib/server";
import { maskAlerts, sanitizeAlerts } from "@/lib/alerts";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isLocalRequest(req)) return Response.json({ error: "Local access only" }, { status: 403 });
  return Response.json({ config: maskAlerts(await readAlertsConfig()) });
}

/** Validated before it is written; the Telegram token never goes back to the browser (the UI sees "set"). */
export async function PUT(req: Request) {
  if (!isLocalRequest(req)) return Response.json({ error: "Local access only" }, { status: 403 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return Response.json({ error: "Invalid settings" }, { status: 400 });
  const config = sanitizeAlerts(body, await storedTelegramToken());
  await writeAlertsConfig(config);
  return Response.json({ config: maskAlerts(config) });
}
