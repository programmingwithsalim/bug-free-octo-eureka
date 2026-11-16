"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BellRing, Compass, FlaskConical, Newspaper, Play, RefreshCw, Send, Square, Target } from "lucide-react";
import { DEFAULT_ALERTS, SETUP_KEYS, type AlertsConfig, type Backtest, type BtSetup, type InfoRec, type SignalRec, type SignalStatus } from "@/lib/alerts";
import SignalChart from "./SignalChart";

interface Feed { running: boolean; status: SignalStatus | null; signals: SignalRec[]; infos: InfoRec[]; suppressed: number; backtest: Backtest | null; config: AlertsConfig }
const px = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = (t: number) => new Date(t * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const ago = (t: number, now: number) => { const m = Math.round((now - t) / 60000); return m < 1 ? "now" : m < 90 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
const eta = (t: number, now: number) => { const m = Math.round((t * 1000 - now) / 60000); return m < 0 ? `${-m}m ago` : m < 90 ? `in ${m} min` : `in ${Math.floor(m / 60)}h ${m % 60}m`; };
const OUT: Record<string, string> = { open: "Open", tp: "Target hit", sl: "Stopped", time: "Timed out", skipped: "Skipped" };

export default function SignalsPanel() {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [draft, setDraft] = useState<AlertsConfig>(DEFAULT_ALERTS);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const poll = useCallback(async () => {
    try {
      const d: Feed = await (await fetch("/api/signals")).json();
      setFeed(d);
      setDraft((cur) => (dirty ? cur : d.config));
    } catch {}
    setNow(Date.now());
  }, [dirty]);
  useEffect(() => { poll(); const id = setInterval(poll, 5000); return () => clearInterval(id); }, [poll]);

  const control = async (action: "start" | "stop" | "test" | "backtest") => {
    setBusy(action); setMsg(null);
    try {
      const d = await (await fetch("/api/signals/control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) })).json();
      if (d.error) setMsg({ ok: false, text: d.error });
      else if (action === "test") {
        const ch = Object.entries(d.channels ?? {}) as [string, { ok: boolean; detail: string }][];
        setMsg({ ok: !!d.ok, text: ch.length ? ch.map(([k, v]) => `${k}: ${v.ok ? "sent" : "failed (" + v.detail + ")"}`).join(" · ") : "No channel is enabled. Turn one on below and save." });
      } else if (action === "backtest") setMsg({ ok: !!d.ok, text: d.ok ? `Backtest done: ${d.trades} simulated trades.` : d.error ?? "Backtest failed" });
      else if (action === "start" && !d.running) setMsg({ ok: false, text: "The service didn't start. Is MetaTrader 5 open and logged in?" });
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    setBusy(null);
    poll();
  };

  const save = async () => {
    setBusy("save");
    try {
      const r = await fetch("/api/signals/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(draft) });
      const d = await r.json();
      setDraft(d.config); setDirty(false);
      setMsg({ ok: r.ok, text: r.ok ? "Saved. The service picks it up within 20 seconds." : "Could not save." });
    } catch { setMsg({ ok: false, text: "Could not save." }); }
    setBusy(null);
  };
  const edit = (fn: (d: AlertsConfig) => void) => { setDirty(true); setDraft((d) => { const n = structuredClone(d); fn(n); return n; }); };

  const st = feed?.status, snap = st?.snapshot, bt = feed?.backtest, running = !!feed?.running;
  const gate = useMemo(() => new Map((bt?.report.setups ?? []).map((s) => [s.setup, s])), [bt]);
  const tone = snap ? (snap.bias === "bullish" ? "pos" : snap.bias === "bearish" ? "neg" : "") : "";

  return (
    <div className="grid">
      <div className="page-head">
        <div><h2>Signals</h2><div className="sub">Bias first (H4 + H1), entries on M15. Alerts reach you even with this page closed.</div></div>
        <div className="bar" style={{ margin: 0 }}>
          <span className={`pill ${running ? (st?.connected ? "ok" : "warn") : ""}`}><span className={`dot ${running && st?.connected ? "ok" : ""}`} />{running ? (st?.connected ? "Alerts ON" : "Running · MT5 not connected") : "Alerts OFF"}</span>
          <button className="btn ghost" disabled={!!busy} onClick={() => control("test")}><Send size={15} />{busy === "test" ? "Sending…" : "Send test alert"}</button>
          {running ? <button className="btn ghost" disabled={!!busy} onClick={() => control("stop")}><Square size={15} />Stop</button>
            : <button className="btn" disabled={!!busy} onClick={() => control("start")}><Play size={15} />Start alerts</button>}
        </div>
      </div>
      {msg && <div className={`note ${msg.ok ? "" : "neg"}`}>{msg.text}</div>}
      {!running && <div className="note neg"><b>You will not be alerted.</b> The alert service is stopped, so nothing reaches you until you press <b>Start alerts</b> (keep MetaTrader 5 open and logged in). It keeps running in the background after you close this page.</div>}
      {st?.error && running && <div className="note neg">{st.error}</div>}

      <div className="grid two">
        <div className="card">
          <h3><Compass size={14} style={{ verticalAlign: -2 }} /> Market read: bias first</h3>
          {!snap ? <div className="muted">{running ? "Reading the market…" : "Start the service to see the live read."}</div> : (
            <>
              <div className="bias-row">
                <span className={`bias ${snap.bias}`}>{snap.bias.toUpperCase()}</span>
                <span className="chip">{snap.regime}</span><span className="chip">{snap.mode} mode</span>
                {snap.h4 && <span className="chip">H4 {snap.h4.trend}</span>}{snap.h1 && <span className="chip">H1 {snap.h1.trend}</span>}
              </div>
              <p className={`action ${tone}`}>{snap.action}</p>
              <p className="hint">{snap.why}. Price {px(snap.price)} · M15 ATR {snap.atr.toFixed(2)} · as of {when(snap.time)}.</p>
              {snap.draw && <p className="draw"><Target size={14} /> Likely draw on liquidity: <b>{snap.draw.label}</b> at {px(snap.draw.price)} ({snap.draw.distance.toFixed(1)} away).
                {bt?.liquidity?.days ? <span className="muted"> Over {bt.liquidity.days} gold days, {Math.round((bt.liquidity.took_pdh_or_pdl ?? 0) * 100)}% took out the previous day's high or low; the nearer side went first {Math.round((bt.liquidity.nearer_side_first ?? 0) * 100)}% of the time.</span> : null}</p>}
              <div className="lv">{[...snap.levels].sort((a, b) => b.price - a.price).map((l) => <div key={l.label} className={snap.price >= l.price ? "below" : ""}><span>{l.label}</span><b>{px(l.price)}</b><span className="muted">{(l.price - snap.price >= 0 ? "+" : "") + (l.price - snap.price).toFixed(1)}</span></div>)}</div>
            </>
          )}
        </div>

        <div className="card">
          <h3><Newspaper size={14} style={{ verticalAlign: -2 }} /> Upcoming high-impact USD news</h3>
          {st && !st.news.ok && <div className="note neg">{st.news.note}</div>}
          {st?.news.upcoming.length ? <div className="news">{st.news.upcoming.map((e, i) => <div key={i}><b>{e.title}</b><span className="muted">{when(e.time)} · {eta(e.time, now)}</span><span className="muted">{e.forecast ? `forecast ${e.forecast}` : ""}{e.previous ? ` · prev ${e.previous}` : ""}</span></div>)}</div>
            : <div className="muted">{st ? "Nothing high-impact in the next 48 hours." : "Start the service to load the calendar."}</div>}
          <p className="hint">You'll be warned {draft.news.minutes.join(" and ")} minutes before each release. Around news gold sweeps both sides: wait for the spike, then look for a close back inside the pre-news range.</p>
        </div>
      </div>

      <div className="grid two feeds">
        <div className="grid" style={{ alignContent: "start" }}>
          <h3 style={{ margin: "4px 0 0" }} className="muted">Alerts {feed ? `· ${feed.signals.length}` : ""} {st ? `· ${st.today} setup alert(s) today (cap ${draft.maxPerDay})` : ""}</h3>
          {!feed?.signals.length && <div className="card empty" style={{ padding: 28 }}>No alerts yet. Daily plans fire at 07:00 and 12:00 UTC; setup alerts only when a setup that passed the backtest (or one you switched on) forms on a closed M15 candle.{feed?.suppressed ? ` ${feed.suppressed} candidate(s) were held back by your rules.` : ""}</div>}
          {feed?.signals.map((s) => {
            const g = gate.get(s.setup);
            return (
              <div key={s.id} className={`card sigcard ${s.side}`}>
                <div className="sig-head">
                  <span className={`side-pill ${s.side === "buy" ? "long" : "short"}`}>{s.side === "buy" ? "BUY" : "SELL"}</span>
                  <b>{s.name}</b>
                  {s.kind === "plan" ? <span className="badge">daily plan</span> : <span className="badge">score {s.score}</span>}
                  <span className={`outcome ${s.status}`}>{OUT[s.status]}{s.r != null && s.status !== "open" && s.status !== "skipped" ? ` ${s.r >= 0 ? "+" : ""}${s.r.toFixed(2)}R` : ""}</span>
                  <span className="muted sig-when">{when(s.close_time)} · {ago(s.close_time * 1000, now)}</span>
                </div>
                <div className="levels"><span>Entry <b>{px(s.entry)}</b></span><span className="neg">SL <b>{px(s.sl)}</b></span><span className="pos">TP <b>{px(s.tp)}</b></span><span>R:R <b>{s.rr.toFixed(1)}</b></span>{s.target_label && <span className="muted">target: {s.target_label}</span>}</div>
                <ul className="reasons">{s.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
                {s.bias && <div className="muted" style={{ fontSize: 12 }}>Bias: {s.bias.bias}{s.bias.why ? ` (${s.bias.why})` : ""} · {s.mode} mode</div>}
                <div className={`evid-line ${g?.passes ? "ok" : ""}`}>{g ? `Backtest: ${g.total.n} trades, avg ${g.total.avg_r >= 0 ? "+" : ""}${g.total.avg_r.toFixed(2)}R, out-of-sample ${g.out_of_sample.avg_r >= 0 ? "+" : ""}${g.out_of_sample.avg_r.toFixed(2)}R · ${g.passes ? "passed the quality gate" : "UNPROVEN: did not pass"}` : "No backtest for this setup"}</div>
                <div className="checklist">Before you click: does the bias agree? did the candle close? is the stop placed? is the risk within plan?</div>
                <button className="btn ghost" onClick={() => setOpen(open === s.id ? null : s.id)}>{open === s.id ? "Hide chart" : "Show chart"}</button>
                {open === s.id && <div style={{ marginTop: 12 }}>{s.score_parts?.length ? <div className="parts">{s.score_parts.map((p, i) => <span key={i} className={p.points >= 0 ? "pos" : "neg"}>{p.points >= 0 ? "+" : ""}{p.points} {p.reason}</span>)}</div> : null}<SignalChart sig={s} /></div>}
              </div>
            );
          })}
        </div>

        <div className="grid" style={{ alignContent: "start" }}>
          <div className="card">
            <h3><BellRing size={14} style={{ verticalAlign: -2 }} /> Briefings, news and bias changes</h3>
            {!feed?.infos.length ? <div className="muted">Nothing yet.</div> : <div className="log">{feed.infos.map((i, k) => <div className="log-row info" key={k}><span className="muted">{ago(i.t * 1000, now)}</span><span className="badge" style={{ marginLeft: 0 }}>{i.kind}</span><span><b>{i.title}</b><div className="muted" style={{ whiteSpace: "pre-line" }}>{i.body}</div></span></div>)}</div>}
          </div>
          {st && Object.keys(st.forward).length > 0 && (
            <div className="card">
              <h3>Your live track record (forward test)</h3>
              <table className="tight"><thead><tr><th>Setup</th><th>Alerts</th><th>Win</th><th>Total R</th></tr></thead>
                <tbody>{Object.entries(st.forward).map(([k, f]) => <tr key={k}><td>{gate.get(k)?.name ?? k}</td><td>{f.n}</td><td>{f.n ? Math.round((f.wins / f.n) * 100) + "%" : "–"}</td><td className={f.sum_r >= 0 ? "pos" : "neg"}>{f.sum_r >= 0 ? "+" : ""}{f.sum_r.toFixed(2)}R</td></tr>)}</tbody></table>
              <p className="hint">Every alert is followed to its target/stop with the same rules as the backtest. This is the honest, out-of-sample record.</p>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="tc-top"><h3 style={{ margin: 0 }}><FlaskConical size={14} style={{ verticalAlign: -2 }} /> Strategy lab: does each setup actually work on gold?</h3>
          <button className="btn ghost" disabled={!!busy} onClick={() => control("backtest")}><RefreshCw size={15} className={busy === "backtest" ? "spin" : ""} />{busy === "backtest" ? "Running (about a minute)…" : "Re-run backtest"}</button></div>
        {!bt ? <div className="note">No backtest yet. Press "Re-run backtest" (MetaTrader 5 must be open).</div> : (
          <>
            <p className="hint" style={{ marginTop: 0 }}>{bt.symbol} M15, {bt.bars.toLocaleString()} candles ({when(bt.from)} to {when(bt.to)}), ${bt.spread} spread per trade, entry at the NEXT candle's open, stop wins ties. First 70% in-sample, last 30% out-of-sample (never tuned on). Overall: <b>{bt.report.overall.n}</b> simulated trades, average <b>{bt.report.overall.avg_r >= 0 ? "+" : ""}{bt.report.overall.avg_r.toFixed(2)}R</b>, out-of-sample <b>{bt.report.overall_oos.avg_r >= 0 ? "+" : ""}{bt.report.overall_oos.avg_r.toFixed(2)}R</b>. Time spent ranging {Math.round((bt.regime_share.ranging ?? 0) * 100)}%, trending {Math.round((bt.regime_share.trending ?? 0) * 100)}%.</p>
            <div className="scroll"><table className="tight">
              <thead><tr><th>Setup</th><th>Trades</th><th>Win</th><th>Avg R</th><th>PF</th><th>Out-of-sample</th><th>Verdict</th><th>Alerts</th></tr></thead>
              <tbody>{[...bt.report.setups].sort((a, b) => Number(b.passes) - Number(a.passes) || b.total.avg_r - a.total.avg_r).map((r: BtSetup) => (
                <tr key={r.setup}>
                  <td><b>{r.name}</b></td><td>{r.total.n}</td><td>{Math.round(r.total.win * 100)}%</td>
                  <td className={r.total.avg_r >= 0 ? "pos" : "neg"}>{r.total.avg_r >= 0 ? "+" : ""}{r.total.avg_r.toFixed(2)}</td><td>{r.total.pf > 99 ? "∞" : r.total.pf.toFixed(2)}</td>
                  <td className={r.out_of_sample.avg_r >= 0 ? "pos" : "neg"}>{r.out_of_sample.n ? `${r.out_of_sample.avg_r >= 0 ? "+" : ""}${r.out_of_sample.avg_r.toFixed(2)}R (n=${r.out_of_sample.n})` : "–"}</td>
                  <td>{r.passes ? <span className="evid strong">Passed</span> : <span className="evid" title={r.why_not.join("; ")}>Unproven: {r.why_not[0]}</span>}</td>
                  <td>{SETUP_KEYS.includes(r.setup as never) ? (
                    <select className="sel mini" value={draft.setups[r.setup] ?? "auto"} onChange={(e) => edit((d) => { d.setups[r.setup] = e.target.value as "auto" | "on" | "off"; })}>
                      <option value="auto">Auto (only if passed)</option><option value="on">Always alert</option><option value="off">Never</option>
                    </select>) : <span className="muted">{r.setup.startsWith("draw") ? (draft.plans[r.setup.slice(-2) as "07" | "12"] ? "on" : "off") : ""}</span>}</td>
                </tr>))}</tbody>
            </table></div>
            <p className="hint">"Passed" means: 30+ trades, average at least +0.10R, profit factor 1.15+, and positive out-of-sample. Nothing here is a guarantee: results come from one instrument over about 13 months, and I tried several variants of the daily plan before settling on one, so treat even a pass as a lead to forward-test (see your live record above). {bt.note}</p>
          </>
        )}
      </div>

      <div className="card">
        <h3>Alert settings</h3>
        <div className="grid two">
          <div className="grid">
            <label className="check"><input type="checkbox" checked={draft.channels.desktop} onChange={(e) => edit((d) => { d.channels.desktop = e.target.checked; })} /> Windows desktop notification</label>
            <label className="check"><input type="checkbox" checked={draft.channels.sound} onChange={(e) => edit((d) => { d.channels.sound = e.target.checked; })} /> Sound (setup alerts)</label>
            <label className="check"><input type="checkbox" checked={draft.channels.telegram.enabled} onChange={(e) => edit((d) => { d.channels.telegram.enabled = e.target.checked; })} /> Telegram (phone push, works when you're away from the PC)</label>
            {draft.channels.telegram.enabled && (
              <div className="form">
                <div><label>Bot token</label><input type="password" autoComplete="off" value={draft.channels.telegram.token} placeholder="123456789:AA…" onChange={(e) => edit((d) => { d.channels.telegram.token = e.target.value; })} /></div>
                <div><label>Your chat id</label><input value={draft.channels.telegram.chatId} placeholder="e.g. 123456789" onChange={(e) => edit((d) => { d.channels.telegram.chatId = e.target.value; })} /></div>
                <div className="span hint">Setup: in Telegram message <b>@BotFather</b> → <code>/newbot</code> → copy the token. Open your new bot and send it "hi". Get your chat id from <b>@userinfobot</b>. Paste both, Save, then press "Send test alert". The service must keep running on this PC (PC on, MT5 open).</div>
              </div>)}
          </div>
          <div className="grid">
            <label className="check"><input type="checkbox" checked={draft.plans["07"]} onChange={(e) => edit((d) => { d.plans["07"] = e.target.checked; })} /> Daily plan at 07:00 UTC (London open): failed the backtest, off by default</label>
            <label className="check"><input type="checkbox" checked={draft.plans["12"]} onChange={(e) => edit((d) => { d.plans["12"] = e.target.checked; })} /> Daily plan at 12:00 UTC (New York run-up): passed the backtest</label>
            <label className="check"><input type="checkbox" checked={draft.briefing} onChange={(e) => edit((d) => { d.briefing = e.target.checked; })} /> Morning read (bias, levels) at ~06:45 UTC</label>
            <label className="check"><input type="checkbox" checked={draft.biasChange} onChange={(e) => edit((d) => { d.biasChange = e.target.checked; })} /> Tell me when the bias or regime changes</label>
            <label className="check"><input type="checkbox" checked={draft.news.enabled} onChange={(e) => edit((d) => { d.news.enabled = e.target.checked; })} /> Warn before high-impact USD news</label>
            <label className="check"><input type="checkbox" checked={draft.scalps} onChange={(e) => edit((d) => { d.scalps = e.target.checked; })} /> Include range scalps</label>
            <div className="form">
              <div><label>Minimum score (setups)</label><input type="number" min={40} max={100} value={draft.minScore} onChange={(e) => edit((d) => { d.minScore = Number(e.target.value) || 70; })} /></div>
              <div><label>Max setup alerts per day</label><input type="number" min={1} max={30} value={draft.maxPerDay} onChange={(e) => edit((d) => { d.maxPerDay = Number(e.target.value) || 6; })} /></div>
            </div>
            <label className="check"><input type="checkbox" checked={draft.quiet.enabled} onChange={(e) => edit((d) => { d.quiet.enabled = e.target.checked; })} /> Quiet hours (UTC) {draft.quiet.enabled && <><input className="hour" type="number" min={0} max={23} value={draft.quiet.start} onChange={(e) => edit((d) => { d.quiet.start = Number(e.target.value) || 0; })} /> to <input className="hour" type="number" min={0} max={23} value={draft.quiet.end} onChange={(e) => edit((d) => { d.quiet.end = Number(e.target.value) || 0; })} /></>}</label>
          </div>
        </div>
        <div className="save-bar" style={{ marginTop: 14 }}>
          <button className="btn" disabled={!dirty || busy === "save"} onClick={save}>Save settings</button>
          {dirty && <button className="btn ghost" onClick={() => { feed && setDraft(feed.config); setDirty(false); }}>Discard</button>}
          <span className="muted">{dirty ? "Unsaved changes" : "All changes saved"}</span>
        </div>
      </div>
      <div className="note">These are decision aids, not financial advice. Pattern and sweep setups showed no reliable edge in the backtest (see the lab); only the verdicts above are measured, and they can change. Never risk money you can't afford to lose, and always place a stop.</div>
    </div>
  );
}

