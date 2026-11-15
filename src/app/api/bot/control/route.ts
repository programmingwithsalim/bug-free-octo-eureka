import { isLocalRequest, readBotStatus, startBot, stopBot } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Start/stop the background manager process. Starting it does nothing to your trades until the mode is Dry run or Live. */
export async function POST(req: Request) {
  if (!isLocalRequest(req)) return Response.json({ error: "Local access only" }, { status: 403 });
  const { action } = (await req.json().catch(() => ({}))) as { action?: string };
  if (action === "start") {
    await startBot();
    for (let i = 0; i < 20; i++) { // wait up to ~5s for the first heartbeat
      if ((await readBotStatus()).running) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  } else if (action === "stop") {
    await stopBot();
  } else {
    return Response.json({ error: "action must be start or stop" }, { status: 400 });
  }
  return Response.json(await readBotStatus());
}
