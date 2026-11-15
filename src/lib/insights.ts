import type { Insight, Trade } from "./types";
import {
  WEEKDAYS, WEEKDAY_NAMES, byClose, byDay, byHour, byOpen, bySymbol, byTag, byWeekday, computeStats,
  dayKey, holdMinutes, mean, median, round, sum,
} from "./analytics";

const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(round(n, 0)).toLocaleString("en-US")}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;
const REVENGE_WINDOW_MIN = 15;
const full = (abbr: string) => WEEKDAY_NAMES[WEEKDAYS.indexOf(abbr)] ?? abbr;

/** Rule-based behavioural analysis. Needs ~20+ trades to be meaningful. */
export function generateInsights(trades: Trade[]): Insight[] {
  const out: Insight[] = [];
  if (trades.length < 10) {
    return [{
      id: "need-data", severity: "low", title: "Not enough trades yet",
      evidence: `Only ${trades.length} trade(s) found. Patterns need at least ~20 trades to be reliable.`,
      advice: "Import your history or keep journaling — insights unlock as data grows.",
    }];
  }
  const st = computeStats(trades);
  const closed = byClose(trades);
  const opened = byOpen(trades);
  const losers = trades.filter((t) => t.pnl < 0);
  const winners = trades.filter((t) => t.pnl > 0);

  // 1. Risk/reward vs win rate (are you mathematically viable?)
  if (st.losses && st.wins) {
    const breakEvenWR = 1 / (1 + st.payoff);
    if (st.payoff < 1 && st.winRate < breakEvenWR) {
      out.push({
        id: "payoff", severity: "high", title: "Your average loss is bigger than your average win",
        evidence: `Avg win ${money(st.avgWin)} vs avg loss ${money(st.avgLoss)} (payoff ${st.payoff.toFixed(2)}). You need a ${pct(breakEvenWR)} win rate to break even but win ${pct(st.winRate)}.`,
        advice: "Set a hard stop at entry and never widen it. Take profit targets at ≥1.5× your risk, or trade setups with a much higher hit rate. Don't exit winners at the first bit of profit.",
        cost: st.netPnl < 0 ? st.netPnl : undefined,
      });
    } else if (st.payoff < 0.8) {
      out.push({
        id: "payoff-low", severity: "medium", title: "Small winners, large losers",
        evidence: `Payoff ratio is ${st.payoff.toFixed(2)} (avg win ${money(st.avgWin)}, avg loss ${money(st.avgLoss)}). You're profitable only because of a ${pct(st.winRate)} win rate.`,
        advice: "That's fragile — a few bad losses wipe out many wins. Let winners run toward targets and cap loss size per trade.",
      });
    }
  }

  // 2. Holding losers longer than winners (disposition effect)
  if (st.wins >= 5 && st.losses >= 5 && st.avgHoldWin > 0 && st.avgHoldLoss > st.avgHoldWin * 1.3) {
    out.push({
      id: "hold-losers", severity: "high", title: "You hold losing trades much longer than winners",
      evidence: `Losers are held ${fmtMin(st.avgHoldLoss)} on average vs ${fmtMin(st.avgHoldWin)} for winners (${(st.avgHoldLoss / st.avgHoldWin).toFixed(1)}×).`,
      advice: "Classic hope-and-pray behaviour. Define the invalidation level before entry, place the stop there, and exit when it's hit. Add a time-stop: if the trade hasn't worked in X minutes, close it.",
    });
  } else if (st.wins >= 5 && st.losses >= 5 && st.avgHoldLoss > 0 && st.avgHoldWin < st.avgHoldLoss * 0.6) {
    out.push({
      id: "cut-winners", severity: "medium", title: "You cut winners short",
      evidence: `Winners are held ${fmtMin(st.avgHoldWin)} vs ${fmtMin(st.avgHoldLoss)} for losers.`,
      advice: "Use a pre-planned target or trail the stop under structure instead of closing as soon as you're nervous about giving profit back.",
    });
  }

  // 3. Revenge trading: re-entering right after a loss
  const revenge: Trade[] = [];
  const afterLossNormal: Trade[] = [];
  for (let i = 0; i < opened.length; i++) {
    const prev = lastClosedBefore(closed, +new Date(opened[i].openTime), opened[i].id);
    if (!prev || prev.pnl >= 0) continue;
    const gap = (+new Date(opened[i].openTime) - +new Date(prev.closeTime)) / 60000;
    (gap <= REVENGE_WINDOW_MIN ? revenge : afterLossNormal).push(opened[i]);
  }
  if (revenge.length >= 4) {
    const rp = sum(revenge.map((t) => t.pnl));
    const rwr = revenge.filter((t) => t.pnl > 0).length / revenge.length;
    if (rp < 0 && rwr < st.winRate) {
      out.push({
        id: "revenge", severity: "high", title: "Revenge trading after losses",
        evidence: `${revenge.length} trades were opened within ${REVENGE_WINDOW_MIN} min of a losing trade. They won ${pct(rwr)} (vs ${pct(st.winRate)} overall) and lost ${money(rp)} combined.`,
        advice: `Enforce a cooling-off rule: after any loss, step away for at least 30 minutes. After 2 consecutive losses, stop for the session. Write down what went wrong before the next entry.`,
        cost: rp,
      });
    }
  }

  // 4. Size escalation after a loss
  const medSize = median(trades.map((t) => t.size));
  const bigAfterLoss: Trade[] = [];
  for (let i = 1; i < closed.length; i++) {
    if (closed[i - 1].pnl < 0 && closed[i].size > medSize * 1.5) bigAfterLoss.push(closed[i]);
  }
  if (bigAfterLoss.length >= 3) {
    const p = sum(bigAfterLoss.map((t) => t.pnl));
    out.push({
      id: "size-after-loss", severity: p < 0 ? "high" : "medium",
      title: "You size up after losing trades",
      evidence: `${bigAfterLoss.length} trades following a loss used >1.5× your typical size (${round(medSize, 2)}). Net result of those trades: ${money(p)}.`,
      advice: "Trying to win it back with bigger size is how accounts blow up. Fix position size as a % of equity (0.5–1% risk) and never increase it after a loss.",
      cost: p < 0 ? p : undefined,
    });
  }

  // 5. Overtrading
  const days = byDay(trades);
  if (days.length >= 5) {
    const med = median(days.map((d) => d.count));
    const heavy = days.filter((d) => d.count > Math.max(med * 1.75, med + 2));
    const light = days.filter((d) => !heavy.includes(d));
    if (heavy.length >= 2 && light.length >= 2) {
      const heavyAvg = mean(heavy.map((d) => d.pnl / d.count));
      const lightAvg = mean(light.map((d) => d.pnl / d.count));
      if (heavyAvg < lightAvg && heavyAvg < 0) {
        const cost = sum(heavy.map((d) => d.pnl));
        out.push({
          id: "overtrading", severity: "high", title: "Overtrading on your busiest days",
          evidence: `On ${heavy.length} high-volume days (more than ${Math.round(Math.max(med * 1.75, med + 2))} trades) you averaged ${money(heavyAvg)}/trade vs ${money(lightAvg)}/trade on normal days. Total on busy days: ${money(cost)}.`,
          advice: `Set a daily max of ${Math.max(2, Math.round(med * 1.5))} trades. When you hit it — or a daily loss limit — close the platform.`,
          cost: cost < 0 ? cost : undefined,
        });
      }
    }
  }

  // 6. Missing stop losses
  const noStop = trades.filter((t) => t.stopLoss == null);
  const stopPct = noStop.length / trades.length;
  if (stopPct > 0.3) {
    const nsLoss = noStop.filter((t) => t.pnl < 0);
    out.push({
      id: "no-stop", severity: stopPct > 0.6 ? "high" : "medium", title: "Many trades have no recorded stop loss",
      evidence: `${pct(stopPct)} of trades (${noStop.length}) have no stop. Without stops, your worst-case loss is undefined — avg loss on unprotected losers is ${money(mean(nsLoss.map((t) => t.pnl)) || 0)}.`,
      advice: "Decide the stop before you click buy/sell, and place it with the order. If your broker export lacks the stop column, add it in the journal so R-multiples can be calculated.",
    });
  }

  // 7. Catastrophic outlier loss
  if (st.losses >= 5 && st.largestLoss < -3 * st.avgLoss) {
    out.push({
      id: "outlier-loss", severity: "high", title: "One loss was far outside your normal risk",
      evidence: `Largest loss ${money(st.largestLoss)} is ${(Math.abs(st.largestLoss) / st.avgLoss).toFixed(1)}× your average loss (${money(st.avgLoss)}) — it consumed ${pct(Math.abs(st.largestLoss) / Math.max(st.grossProfit, 1))} of your total gross profit.`,
      advice: "Find that trade in the journal and check what failed: no stop, moved stop, oversized, or news event. Add a hard max-loss-per-trade rule.",
      cost: st.largestLoss + st.avgLoss,
    });
  }

  // 8. Loss streak behaviour
  if (st.maxConsecLosses >= 5) {
    out.push({
      id: "streak", severity: "medium", title: `Longest losing streak: ${st.maxConsecLosses} trades`,
      evidence: "Long streaks usually mean you kept trading through a bad session or a market that didn't suit your setup.",
      advice: "Add a circuit-breaker: after 3 consecutive losses, stop trading for the day and review. Reduce size by half the next day.",
    });
  }

  // 9. Worst hours / weekdays / symbols
  const worst = <T extends { pnl: number; count: number; key: string }>(bs: T[], min: number) =>
    bs.filter((b) => b.count >= min && b.pnl < 0).sort((a, b) => a.pnl - b.pnl)[0];
  const minN = Math.max(5, Math.floor(trades.length * 0.06));
  const wh = worst(byHour(trades), minN);
  if (wh) out.push({
    id: "bad-hour", severity: Math.abs(wh.pnl) > st.grossLoss * 0.2 ? "high" : "medium",
    title: `Trades opened around ${wh.key}:00 lose money`,
    evidence: `${wh.count} trades, ${pct(wh.winRate)} win rate, net ${money(wh.pnl)}.`,
    advice: `Stop trading this hour (or trade it half-size) for 30 days and compare results.`, cost: wh.pnl,
  });
  const wd = worst(byWeekday(trades), minN);
  if (wd) out.push({
    id: "bad-day", severity: "medium", title: `${full(wd.key)}s are your weakest day`,
    evidence: `${wd.count} trades, ${pct(wd.winRate)} win rate, net ${money(wd.pnl)}.`,
    advice: `Review what's different on ${full(wd.key)}s — news, low liquidity, fatigue, weekly-close behaviour. Consider skipping or sizing down.`, cost: wd.pnl,
  });
  const ws = worst(bySymbol(trades), minN);
  if (ws) out.push({
    id: "bad-symbol", severity: Math.abs(ws.pnl) > st.grossLoss * 0.2 ? "high" : "medium",
    title: `${ws.key} is costing you money`,
    evidence: `${ws.count} trades, ${pct(ws.winRate)} win rate, net ${money(ws.pnl)}.`,
    advice: `Drop ${ws.key} from your watchlist until you can show an edge on it in a demo/small-size sample.`, cost: ws.pnl,
  });

  // 10. Fee drag
  if (st.grossProfit > 0 && st.fees > st.grossProfit * 0.2) {
    out.push({
      id: "fees", severity: "medium", title: "Fees are eating a big part of your profits",
      evidence: `Fees/commissions total ${money(st.fees)} = ${pct(st.fees / st.grossProfit)} of gross profit.`,
      advice: "Trade fewer, higher-quality setups, or move to lower-cost instruments/account type. Scalping needs tight spreads.",
      cost: -st.fees,
    });
  }

  // 11. Self-tagged mistakes (from journal)
  const tagStats = byTag(trades).filter((b) => b.key !== "Good execution" && b.count >= 2 && b.pnl < 0).sort((a, b) => a.pnl - b.pnl);
  for (const tg of tagStats.slice(0, 3)) {
    out.push({
      id: `tag-${tg.key}`, severity: "medium", title: `Your journal flags "${tg.key}" — it has cost ${money(tg.pnl)}`,
      evidence: `${tg.count} trades tagged "${tg.key}", win rate ${pct(tg.winRate)}.`,
      advice: `Make a pre-trade checklist item that specifically prevents "${tg.key}". Track whether the count falls week over week.`, cost: tg.pnl,
    });
  }

  // 12. Emotion-driven results
  const emo = new Map<string, number[]>();
  trades.forEach((t) => t.emotion && (emo.get(t.emotion) ?? emo.set(t.emotion, []).get(t.emotion)!).push(t.pnl));
  for (const [e, ps] of emo) {
    if (ps.length >= 4 && ["Angry", "Frustrated", "Greedy", "Anxious", "Tired", "Bored"].includes(e) && sum(ps) < 0) {
      out.push({
        id: `emo-${e}`, severity: "medium", title: `Trading while "${e.toLowerCase()}" costs you`,
        evidence: `${ps.length} trades logged as ${e.toLowerCase()}, net ${money(sum(ps))}.`,
        advice: `If you notice this state before entering, don't trade. Add a "How do I feel?" check to your routine.`, cost: sum(ps),
      });
    }
  }

  // Strengths
  const bestSetup = byTag(trades.map((t) => ({ ...t, tags: t.setup ? [t.setup] : [] })))
    .filter((b) => b.count >= 5 && b.pnl > 0).sort((a, b) => b.pnl - a.pnl)[0];
  if (bestSetup) out.push({
    id: "best-setup", severity: "good", title: `Your edge: "${bestSetup.key}"`,
    evidence: `${bestSetup.count} trades, ${pct(bestSetup.winRate)} win rate, net ${money(bestSetup.pnl)}.`,
    advice: "Do more of this. Make it your A-setup and size up slightly (within risk limits) only on perfectly matching conditions.",
  });
  const bs = bySymbol(trades).filter((b) => b.count >= minN && b.pnl > 0)[0];
  if (bs) out.push({
    id: "best-symbol", severity: "good", title: `${bs.key} is your best market`,
    evidence: `${bs.count} trades, ${pct(bs.winRate)} win rate, net ${money(bs.pnl)}.`,
    advice: "Focus more of your attention here and study what you do differently on it.",
  });
  if (st.profitFactor >= 1.5 && st.count >= 30) out.push({
    id: "pf", severity: "good", title: "Healthy profit factor",
    evidence: `Profit factor ${st.profitFactor.toFixed(2)} over ${st.count} trades, expectancy ${money(st.expectancy)} per trade.`,
    advice: "The edge looks real. Protect it: keep risk constant and avoid changing too many things at once.",
  });

  const order = { high: 0, medium: 1, low: 2, good: 3 } as const;
  return out.sort((a, b) => order[a.severity] - order[b.severity] || (a.cost ?? 0) - (b.cost ?? 0));
}

/** Binary search: latest trade (excluding `skipId`) that closed at or before time `at`. */
function lastClosedBefore(closed: Trade[], at: number, skipId: string): Trade | undefined {
  let lo = 0, hi = closed.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (+new Date(closed[mid].closeTime) <= at) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  while (idx >= 0 && closed[idx].id === skipId) idx--;
  return idx >= 0 ? closed[idx] : undefined;
}

export function fmtMin(m: number) {
  if (m < 60) return `${Math.round(m)}m`;
  if (m < 60 * 24) return `${(m / 60).toFixed(1)}h`;
  return `${(m / 1440).toFixed(1)}d`;
}

export { holdMinutes, dayKey, WEEKDAYS };
