import { isLocalRequest, readJournal, runMt5Export, writeJournal } from "@/lib/server";
import { applyMt5Account, inferStartingBalance, mergeMt5 } from "@/lib/mt5";
import { DEFAULT_ACCOUNT } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Pull closed deals from the local MT5 terminal, merge into the journal file, return the new journal. */
export async function POST(req: Request) {
  if (!isLocalRequest(req)) return Response.json({ error: "Local access only" }, { status: 403 });
  const days = Math.min(Math.max(Number(new URL(req.url).searchParams.get("days")) || 90, 1), 3650);
  try {
    const exp = await runMt5Export(days);
    const cur = (await readJournal()) ?? { trades: [], account: DEFAULT_ACCOUNT };
    const { trades, added, updated } = mergeMt5(cur.trades, exp.trades);
    let account = applyMt5Account(cur.account, exp.account);
    // first MT5 sync on an untouched account: replace the 10,000 placeholder with the real starting balance
    if (!cur.trades.some((t) => t.id.startsWith("mt5-")) && cur.account.startingBalance === DEFAULT_ACCOUNT.startingBalance) {
      account = { ...account, startingBalance: inferStartingBalance(exp.account.balance, exp.trades, exp.netDeposits, exp.firstDeposit) };
    }
    const journal = { trades, account };
    await writeJournal(journal);
    return Response.json({ journal, added, updated, balance: exp.account.balance });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
