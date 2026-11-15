"use client";
import { useMemo, useState, type ReactNode } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis, ReferenceLine } from "recharts";
import { Activity, ArrowDownRight, ArrowUpRight, Flame, Gauge, Scale, Target, TrendingDown } from "lucide-react";
import type { JournalApi, Tab } from "./App";
import { WEEKDAYS, byDay, byHour, bySymbol, byWeekday, computeStats, equityCurve } from "@/lib/analytics";
import { money } from "@/lib/format";
import { CHART, type Theme } from "@/lib/theme";
import { useCountUp, useMounted } from "@/lib/anim";
import Empty from "./Empty";
import Seg from "./Seg";

const RANGES = { "7D": 7, "30D": 30, "90D": 90, All: 0 } as const;
type Range = keyof typeof RANGES;
const sign = (n: number) => (n > 0 ? "pos" : n < 0 ? "neg" : "");

/** A number that counts up to its value whenever it changes. */
function Num({ n, fmt }: { n: number; fmt: (n: number) => string }) {
  return <>{fmt(useCountUp(n))}</>;
}

function Kpi({ i, icon, tone = "", l, v, s, cls }: { i: number; icon: ReactNode; tone?: string; l: string; v: ReactNode; s?: string; cls?: string }) {
  return (
    <div className="card kpi" style={{ "--d": i } as React.CSSProperties}>
      <div className="l"><span className={`ico ${tone}`}>{icon}</span>{l}</div>
      <div className={`v ${cls ?? ""}`}>{v}</div>
      {s && <div className="s">{s}</div>}
    </div>
  );
}

function WinRing({ rate }: { rate: number }) {
  const mounted = useMounted();
  const R = 66, C = 2 * Math.PI * R;
  return (
    <div className="ring">
      <svg width="168" height="168" viewBox="0 0 168 168">
        <circle className="bg" cx="84" cy="84" r={R} />
        <circle className="fg" cx="84" cy="84" r={R} strokeDasharray={C} strokeDashoffset={mounted ? C * (1 - rate) : C} />
      </svg>
      <div className="mid"><b><Num n={rate * 100} fmt={(n) => `${n.toFixed(1)}%`} /></b><span>win rate</span></div>
    </div>
  );
}

function PnlBars({ data, fmt, theme }: { data: { key: string; pnl: number }[]; fmt?: (k: string) => string; theme: Theme }) {
  const c = CHART[theme];
  const axis = { stroke: c.axis, fontSize: 11, axisLine: false, tickLine: false } as const;
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} barCategoryGap="22%">
        <CartesianGrid stroke={c.grid} strokeDasharray="3 5" vertical={false} />
        <XAxis dataKey="key" tickFormatter={fmt} {...axis} /><YAxis {...axis} width={46} />
        <Tooltip contentStyle={{ background: c.tipBg, border: 0, borderRadius: 12, boxShadow: "0 8px 30px #0004" }} labelStyle={{ color: c.axis }} itemStyle={{ color: c.axis }}
          formatter={(v) => money(Number(v))} cursor={{ fill: c.cursor, radius: 6 }} />
        <ReferenceLine y={0} stroke={c.grid} />
        <Bar dataKey="pnl" radius={[6, 6, 6, 6]} animationDuration={900} animationEasing="ease-out">{data.map((d, i) => <Cell key={i} fill={d.pnl >= 0 ? c.green : c.red} />)}</Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export default function Dashboard({ j, go, theme }: { j: JournalApi; go: (t: Tab) => void; theme: Theme }) {
  const [range, setRange] = useState<Range>("All");
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
  const axis = { stroke: c.axis, fontSize: 11, axisLine: false, tickLine: false } as const;
  const pf = isFinite(st.profitFactor);

  return (
    <div className="grid">
      <div className="page-head">
        <div><h2>Dashboard</h2><div className="sub">{st.count} trades · {j.account.broker || "MT5"}</div></div>
        <Seg label="Range" value={range} onChange={setRange} options={(Object.keys(RANGES) as Range[]).map((r) => ({ id: r, label: r }))} />
      </div>

      <div className="hero">
        <div className="card">
          <div className="hero-top">
            <div>
              <div className="muted">Net P&L</div>
              <div className={`big ${sign(st.netPnl)}`}>
                <Num n={st.netPnl} fmt={m} />
                <span className={`delta ${st.expectancy >= 0 ? "up" : "down"}`}>
                  {st.expectancy >= 0 ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}{m(st.expectancy)} / trade
                </span>
              </div>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={340}>
            <AreaChart data={eq}>
              <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={c.blue} stopOpacity={0.35} /><stop offset="100%" stopColor={c.blue} stopOpacity={0} /></linearGradient></defs>
              <CartesianGrid stroke={c.grid} strokeDasharray="3 5" vertical={false} />
              <XAxis dataKey="n" {...axis} minTickGap={24} /><YAxis {...axis} width={56} domain={["auto", "auto"]} />
              <Tooltip contentStyle={{ background: c.tipBg, border: 0, borderRadius: 12, boxShadow: "0 8px 30px #0004" }} labelStyle={{ color: c.axis }} itemStyle={{ color: c.axis }}
                formatter={(v) => m(Number(v))} labelFormatter={(n) => `Trade #${n}`} cursor={{ stroke: c.axis, strokeDasharray: "3 4" }} />
              <Area dataKey="equity" type="monotone" stroke={c.blue} fill="url(#g)" strokeWidth={2.5} dot={false} animationDuration={1200} animationEasing="ease-out" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="card ring-wrap">
          <h3 style={{ alignSelf: "flex-start", marginBottom: 0 }}>Win rate</h3>
          <WinRing rate={st.winRate} />
          <div className="mini">
            <div><div className="l">Wins</div><div className="v pos">{st.wins}</div></div>
            <div><div className="l">Losses</div><div className="v neg">{st.losses}</div></div>
            <div><div className="l">Profit factor</div><div className={`v ${st.profitFactor >= 1 ? "pos" : "neg"}`}>{pf ? st.profitFactor.toFixed(2) : "∞"}</div></div>
            <div><div className="l">Payoff</div><div className={`v ${st.payoff >= 1 ? "pos" : "neg"}`}>{st.payoff.toFixed(2)}</div></div>
          </div>
        </div>
      </div>

      <div className="grid kpis anim">
        <Kpi i={0} icon={<Target size={15} />} l="Expectancy / trade" v={<Num n={st.expectancy} fmt={m} />} cls={sign(st.expectancy)} s="average result per trade" />
        <Kpi i={1} icon={<Scale size={15} />} tone="g" l="Avg win" v={<Num n={st.avgWin} fmt={m} />} cls="pos" s={`avg loss ${m(-st.avgLoss)} · payoff ${st.payoff.toFixed(2)}`} />
        <Kpi i={2} icon={<TrendingDown size={15} />} tone="r" l="Max drawdown" v={<Num n={-st.maxDrawdown} fmt={m} />} cls="neg" s={`${(st.maxDrawdownPct * 100).toFixed(1)}% of peak equity`} />
        <Kpi i={3} icon={<Flame size={15} />} tone="a" l="Longest loss streak" v={<Num n={st.maxConsecLosses} fmt={(n) => String(Math.round(n))} />} s={`best win streak ${st.maxConsecWins}`} />
        <Kpi i={4} icon={<Gauge size={15} />} l="Avg R" v={st.avgR != null ? <Num n={st.avgR} fmt={(n) => `${n.toFixed(2)}R`} /> : "n/a"} s={st.avgR == null ? "add stop losses" : "risk-adjusted result"} cls={st.avgR != null ? sign(st.avgR) : ""} />
        <Kpi i={5} icon={<Activity size={15} />} l="Trades" v={<Num n={st.count} fmt={(n) => String(Math.round(n))} />} s={range === "All" ? "all time" : `last ${range}`} />
      </div>

      <div className="grid two anim">
        <div className="card" style={{ "--d": 0 } as React.CSSProperties}><h3>Daily P&L</h3><PnlBars theme={theme} data={days} fmt={(k) => k.slice(5)} /></div>
        <div className="card" style={{ "--d": 1 } as React.CSSProperties}><h3>P&L by weekday</h3><PnlBars theme={theme} data={wd as any} /></div>
        <div className="card" style={{ "--d": 2 } as React.CSSProperties}><h3>P&L by hour opened</h3><PnlBars theme={theme} data={hr} fmt={(k) => `${k}h`} /></div>
        <div className="card" style={{ "--d": 3 } as React.CSSProperties}><h3>P&L by symbol</h3><PnlBars theme={theme} data={sy} /></div>
      </div>
    </div>
  );
}
