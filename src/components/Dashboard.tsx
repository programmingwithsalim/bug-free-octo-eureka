"use client";
import { useMemo, useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis, ReferenceLine } from "recharts";
import type { JournalApi, Tab } from "./App";
import { WEEKDAYS, byDay, byHour, bySymbol, byWeekday, computeStats, equityCurve } from "@/lib/analytics";
import { money, pct } from "@/lib/format";
import { CHART, type Theme } from "@/lib/theme";
import Empty from "./Empty";

const RANGES = { "7D": 7, "30D": 30, "90D": 90, All: 0 } as const;

function Kpi({ l, v, s, cls }: { l: string; v: string; s?: string; cls?: string }) {
  return <div className="card kpi"><div className="l">{l}</div><div className={`v ${cls ?? ""}`}>{v}</div>{s && <div className="s">{s}</div>}</div>;
}
const sign = (n: number) => (n > 0 ? "pos" : n < 0 ? "neg" : "");

function PnlBars({ data, fmt, theme }: { data: { key: string; pnl: number }[]; fmt?: (k: string) => string; theme: Theme }) {
  const c = CHART[theme];
  const axis = { stroke: c.axis, fontSize: 11 };
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data}>
        <CartesianGrid stroke={c.grid} vertical={false} />
        <XAxis dataKey="key" tickFormatter={fmt} {...axis} /><YAxis {...axis} width={50} />
        <Tooltip contentStyle={{ background: c.tipBg, border: `1px solid ${c.tipLine}`, borderRadius: 8 }} labelStyle={{ color: c.axis }} itemStyle={{ color: c.axis }}
          formatter={(v) => money(Number(v))} cursor={{ fill: c.cursor }} />
        <ReferenceLine y={0} stroke={c.grid} />
        <Bar dataKey="pnl" radius={3} isAnimationActive={false}>{data.map((d, i) => <Cell key={i} fill={d.pnl >= 0 ? c.green : c.red} />)}</Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export default function Dashboard({ j, go, theme }: { j: JournalApi; go: (t: Tab) => void; theme: Theme }) {
  const [range, setRange] = useState<keyof typeof RANGES>("All");
  const cur = j.account.currency;
  const c = CHART[theme];
  const trades = useMemo(() => {
    const days = RANGES[range];
    if (!days) return j.trades;
    const cutoff = Date.now() - days * 86400000;
    return j.trades.filter((t) => +new Date(t.closeTime) >= cutoff);
  }, [j.trades, range]);

  const st = useMemo(() => computeStats(trades, range === "All" ? j.account.startingBalance : 0), [trades, range, j.account.startingBalance]);
  const eq = useMemo(() => equityCurve(trades, range === "All" ? j.account.startingBalance : 0), [trades, range, j.account.startingBalance]);
  const wd = useMemo(() => { const m = byWeekday(trades); return WEEKDAYS.slice(1).concat("Sun").map((k) => m.find((b) => b.key === k) ?? { key: k, pnl: 0 }); }, [trades]);
  const hr = useMemo(() => byHour(trades).sort((a, b) => a.key.localeCompare(b.key)), [trades]);
  const sy = useMemo(() => bySymbol(trades), [trades]);
  const days = useMemo(() => byDay(trades).slice(-60), [trades]);

  if (!j.trades.length) return <Empty go={go} />;
  const m = (n: number) => money(n, cur);
  const axis = { stroke: c.axis, fontSize: 11 };

  return (
    <div className="grid">
      <div className="page-head">
        <h2>Dashboard</h2>
        <div className="chips">
          {Object.keys(RANGES).map((r) => (
            <span key={r} className={`chip ${r === range ? "on good" : ""}`} onClick={() => setRange(r as keyof typeof RANGES)}>{r}</span>
          ))}
        </div>
      </div>
      <div className="grid kpis">
        <Kpi l="Net P&L" v={m(st.netPnl)} cls={sign(st.netPnl)} s={`${st.count} trades`} />
        <Kpi l="Win rate" v={pct(st.winRate, 1)} s={`${st.wins}W / ${st.losses}L`} />
        <Kpi l="Profit factor" v={isFinite(st.profitFactor) ? st.profitFactor.toFixed(2) : "∞"} cls={st.profitFactor >= 1 ? "pos" : "neg"} s=">1.5 is solid" />
        <Kpi l="Expectancy / trade" v={m(st.expectancy)} cls={sign(st.expectancy)} />
        <Kpi l="Avg win / avg loss" v={`${m(st.avgWin)} / ${m(-st.avgLoss)}`} s={`payoff ${st.payoff.toFixed(2)}`} />
        <Kpi l="Max drawdown" v={m(-st.maxDrawdown)} cls="neg" s={pct(st.maxDrawdownPct, 1)} />
        <Kpi l="Longest loss streak" v={String(st.maxConsecLosses)} s={`best win streak ${st.maxConsecWins}`} />
        <Kpi l="Avg R" v={st.avgR != null ? `${st.avgR.toFixed(2)}R` : "n/a"} s={st.avgR == null ? "add stop losses" : undefined} cls={st.avgR != null ? sign(st.avgR) : ""} />
      </div>

      <div className="card">
        <h3>Equity curve</h3>
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={eq}>
            <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={c.blue} stopOpacity={0.4} /><stop offset="100%" stopColor={c.blue} stopOpacity={0} /></linearGradient></defs>
            <CartesianGrid stroke={c.grid} vertical={false} />
            <XAxis dataKey="n" {...axis} /><YAxis {...axis} width={60} domain={["auto", "auto"]} />
            <Tooltip contentStyle={{ background: c.tipBg, border: `1px solid ${c.tipLine}`, borderRadius: 8 }} labelStyle={{ color: c.axis }} itemStyle={{ color: c.axis }}
              formatter={(v) => m(Number(v))} labelFormatter={(n) => `Trade #${n}`} />
            <Area isAnimationActive={false} dataKey="equity" stroke={c.blue} fill="url(#g)" strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="grid two">
        <div className="card"><h3>Daily P&L</h3><PnlBars theme={theme} data={days} fmt={(k) => k.slice(5)} /></div>
        <div className="card"><h3>P&L by weekday</h3><PnlBars theme={theme} data={wd as any} /></div>
        <div className="card"><h3>P&L by hour opened</h3><PnlBars theme={theme} data={hr} fmt={(k) => `${k}h`} /></div>
        <div className="card"><h3>P&L by symbol</h3><PnlBars theme={theme} data={sy} /></div>
      </div>
    </div>
  );
}
