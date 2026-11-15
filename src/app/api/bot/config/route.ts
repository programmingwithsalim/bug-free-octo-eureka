import { isLocalRequest, readBotConfig, writeBotConfig } from "@/lib/server";
import { sanitizeBotConfig } from "@/lib/bot";

export const dynamic = "force-dynamic";
const deny = () => Response.json({ error: "Local access only" }, { status: 403 });

export async function GET(req: Request) {
  if (!isLocalRequest(req)) return deny();
  return Response.json({ config: await readBotConfig() });
}

/** Whatever the UI sends is sanitised before it is written, so the manager only ever sees valid config. */
export async function PUT(req: Request) {
  if (!isLocalRequest(req)) return deny();
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return Response.json({ error: "Invalid config" }, { status: 400 });
  const config = sanitizeBotConfig(body);
  await writeBotConfig(config);
  return Response.json({ config });
}
