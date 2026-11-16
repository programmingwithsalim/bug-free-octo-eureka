import { isLocalRequest, readAlertsConfig, readBacktest, readSignalFeed, readSignalStatus } from "@/lib/server";
import { maskAlerts } from "@/lib/alerts";

export const dynamic = "force-dynamic";

/** Everything the Signals tab needs in one poll: service status + market read, alert feed, backtest, settings. */
export async function GET(req: Request) {
  if (!isLocalRequest(req)) return Response.json({ error: "Local access only" }, { status: 403 });
  const [{ running, status }, feed, backtest, config] = await Promise.all([readSignalStatus(), readSignalFeed(), readBacktest(), readAlertsConfig()]);
  return Response.json({ running, status, ...feed, backtest, config: maskAlerts(config) });
}
