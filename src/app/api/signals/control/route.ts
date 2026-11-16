import { isLocalRequest, readSignalStatus, runAlertTest, runBacktestJob, startSignalService, stopSignalService } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** POST { action: "start" | "stop" | "test" | "backtest" } */
export async function POST(req: Request) {
  if (!isLocalRequest(req)) return Response.json({ error: "Local access only" }, { status: 403 });
  const { action } = (await req.json().catch(() => ({}))) as { action?: string };
  try {
    if (action === "start") {
      await startSignalService();
      for (let i = 0; i < 24; i++) { // wait up to ~6s for the first heartbeat
        if ((await readSignalStatus()).running) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      return Response.json(await readSignalStatus());
    }
    if (action === "stop") { await stopSignalService(); return Response.json(await readSignalStatus()); }
    if (action === "test") return Response.json(await runAlertTest());
    if (action === "backtest") return Response.json(await runBacktestJob());
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
  return Response.json({ error: "action must be start, stop, test or backtest" }, { status: 400 });
}
