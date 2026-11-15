"use client";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Play, Plus, ShieldCheck, Square, Trash2 } from "lucide-react";
import type { JournalApi } from "./App";
import Seg from "./Seg";
import { DEFAULT_BOT_CONFIG, TIMEFRAMES, UNITS, type BotConfig, type BotLogEntry, type BotStatus, type Dist } from "@/lib/bot";
import { money } from "@/lib/format";

type Mode = "off" | "dry" | "live";
const modeOf = (c: BotConfig): Mode => (!c.enabled ? "off" : c.dryRun ? "dry" : "live");
const UNIT_LABEL: Record<string, string> = { price: "price", pips: "pips", points: "points", r: "R" };
const MODE_TEXT: Record<Mode, string> = {
  off: "Nothing is touched. The manager only watches and shows what it would do.",
  dry: "Rules run against your open trades and every action is validated with MT5 (order check) and logged, but nothing is sent. Use this first.",
  live: "The manager changes stops and closes parts of your open trades on your real account.",
};

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? "on" : ""}`} onClick={() => onChange(!on)}><span /></button>;
}

function DistField({ label, d, set, hint }: { label: string; d: Dist; set: (d: Dist) => void; hint?: string }) {
  return (
    <div>
      <label>{label}</label>
      <div className="dist">
        <input type="number" min={0} step="any" value={d.value} onChange={(e) => set({ ...d, value: Number(e.target.value) || 0 })} />
        <select value={d.unit} onChange={(e) => set({ ...d, unit: e.target.value as Dist["unit"] })}>
          {UNITS.map((u) => <option key={u} value={u}>{UNIT_LABEL[u]}</option>)}
        </select>
      </div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

function Rule({ title, desc, on = true, onToggle, children }: { title: string; desc: string; on?: boolean; onToggle?: (v: boolean) => void; children: ReactNode }) {
  return (
    <div className={`card rule ${on ? "" : "off"}`}>
      <div className="rule-head">
        <div><b>{title}</b><div className="sub">{desc}</div></div>
        {onToggle && <Switch on={on} onChange={onToggle} label={title} />}
      </div>
      <div className="rule-body">{children}</div>
    </div>
  );
}

export default function BotPanel({ j }: { j: JournalApi }) {
  const [saved, setSaved] = useState<BotConfig | null>(null);
  const [draft, setDraft] = useState<BotConfig>(DEFAULT_BOT_CONFIG);
  const [run, setRun] = useState<{ running: boolean; status: BotStatus | null; log: BotLogEntry[] }>({ running: false, status: null, log: [] });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const cur = j.account.currency;

  const poll = useCallback(async () => {
    try { setRun(await (await fetch("/api/bot/status")).json()); } catch {}
  }, []);
  useEffect(() => {
    fetch("/api/bot/config").then((r) => r.json()).then(({ config }) => { setSaved(config); setDraft(config); }).catch(() => setMsg({ ok: false, text: "Can't reach the local server." }));
    poll();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  }, [poll]);

  const put = async (c: BotConfig) => {
    const r = await fetch("/api/bot/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(c) });
    if (!r.ok) throw new Error("Save failed");
    return (await r.json()).config as BotConfig;
  };
  const edit = (fn: (d: BotConfig) => void) => setDraft((d) => { const n = structuredClone(d); fn(n); return n; });

  const setMode = async (m: Mode) => {
    if (!saved || m === modeOf(saved)) return;
    if (m === "live" && !confirm("Live mode lets the manager modify stops and close parts of your open trades on your REAL account.\n\nTip: run Dry run first and check the log. Continue?")) return;
    try {
      const next = await put({ ...saved, enabled: m !== "off", dryRun: m !== "live" });
      setSaved(next); setDraft((d) => ({ ...d, enabled: next.enabled, dryRun: next.dryRun }));
      setMsg({ ok: true, text: m === "off" ? "Manager is off." : m === "dry" ? "Dry run on: nothing will be sent." : "Live mode on." });
    } catch { setMsg({ ok: false, text: "Could not change mode." }); }
  };

  const save = async () => {
    if (!saved) return;
    if (draft.dailyLoss.enabled && draft.dailyLoss.action === "close_all" && !(saved.dailyLoss.enabled && saved.dailyLoss.action === "close_all")
      && !confirm("'Close all' will close every managed position as soon as your daily loss limit is hit, including trades you open afterwards that day. Continue?")) return;
    setBusy(true);
    try {
      const next = await put({ ...draft, enabled: saved.enabled, dryRun: saved.dryRun }); // mode is only changed via the mode switch
      setSaved(next); setDraft(next);
      setMsg({ ok: true, text: "Saved. The manager picks this up within a second." });
    } catch { setMsg({ ok: false, text: "Could not save." }); }
    setBusy(false);
  };

  const control = async (action: "start" | "stop") => {
    setBusy(true);
    try {
      const r = await (await fetch("/api/bot/control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) })).json();
      setRun((p) => ({ ...p, running: r.running, status: r.status }));
      setMsg(action === "start" && !r.running ? { ok: false, text: "The service didn't start. Is Python installed and MT5 open?" } : null);
    } catch { setMsg({ ok: false, text: "Could not reach the server." }); }
    setBusy(false);
    poll();
  };

  const dirty = saved != null && JSON.stringify({ ...draft, enabled: 0, dryRun: 0 }) !== JSON.stringify({ ...saved, enabled: 0, dryRun: 0 });
  const mode = saved ? modeOf(saved) : "off";
  const st = run.status;

  return (
    <div className="grid">
      <div className="page-head">
        <div><h2>Trade Manager</h2><div className="sub">Manages trades you open yourself. It never opens a trade.</div></div>
        <div className="bar" style={{ margin: 0 }}>
          <span className={`pill ${run.running ? (st?.connected ? "ok" : "warn") : ""}`}>
            <span className={`dot ${run.running && st?.connected ? "ok" : ""}`} />
            {run.running ? (st?.connected ? "Service running" : "Running · MT5 not connected") : "Service stopped"}
          </span>
          {run.running
            ? <button className="btn ghost" disabled={busy} onClick={() => control("stop")}><Square size={15} />Stop service</button>
            : <button className="btn" disabled={busy} onClick={() => control("start")}><Play size={15} />Start service</button>}
        </div>
      </div>

      {msg && <div className={`note ${msg.ok ? "" : "neg"}`}>{msg.text}</div>}
      {st?.error && run.running && <div className="note neg">{st.error}</div>}

      <div className="card">
        <div className="mode-row">
          <div>
            <h3 style={{ marginBottom: 6 }}>Mode</h3>
            <Seg label="Mode" value={mode} onChange={setMode} options={[{ id: "off", label: "Off" }, { id: "dry", label: "Dry run" }, { id: "live", label: "Live" }]} />
          </div>
          <div className="mode-desc"><ShieldCheck size={18} /><div>{MODE_TEXT[mode]}{mode !== "off" && !run.running && <div className="neg" style={{ marginTop: 4 }}>The service is stopped, so nothing is happening. Press Start service.</div>}</div></div>
        </div>
      </div>

      <div className="note">
        <b>Units:</b> <b>price</b> = the symbol's own price (gold: 2.50 = $2.50) · <b>pips</b> = 10 points on 3/5-digit symbols (gold: 1 pip = 0.01) · <b>points</b> = the smallest price step · <b>R</b> = a multiple of the trade's initial stop distance (needs a stop-loss on the trade).
      </div>

      <div className="grid two">
        <div className="grid" style={{ alignContent: "start" }}>
          <Rule title="Break-even" desc="Move the stop to your entry (plus an offset) once the trade is in profit." on={draft.breakEven.enabled} onToggle={(v) => edit((d) => { d.breakEven.enabled = v; })}>
            <div className="form">
              <DistField label="Trigger at profit of" d={draft.breakEven.trigger} set={(x) => edit((d) => { d.breakEven.trigger = x; })} />
              <DistField label="Lock in (offset)" d={draft.breakEven.offset} set={(x) => edit((d) => { d.breakEven.offset = x; })} hint="Small positive offset covers spread/commission." />
            </div>
          </Rule>

          <Rule title="Trailing stop" desc="Follow price with the stop. It only ever moves in your favour." on={draft.trailing.enabled} onToggle={(v) => edit((d) => { d.trailing.enabled = v; })}>
            <Seg label="Trailing mode" value={draft.trailing.mode} onChange={(m) => edit((d) => { d.trailing.mode = m; })} options={[{ id: "fixed", label: "Fixed distance" }, { id: "atr", label: "ATR (volatility)" }]} />
            <div className="form" style={{ marginTop: 12 }}>
              <DistField label="Start trailing at profit of" d={draft.trailing.start} set={(x) => edit((d) => { d.trailing.start = x; })} />
              {draft.trailing.mode === "fixed"
                ? <DistField label="Keep stop this far behind price" d={draft.trailing.distance} set={(x) => edit((d) => { d.trailing.distance = x; })} />
                : <>
                    <div><label>ATR period</label><input type="number" min={2} value={draft.trailing.atrPeriod} onChange={(e) => edit((d) => { d.trailing.atrPeriod = Number(e.target.value) || 14; })} /></div>
                    <div><label>ATR timeframe</label><select value={draft.trailing.atrTimeframe} onChange={(e) => edit((d) => { d.trailing.atrTimeframe = e.target.value as BotConfig["trailing"]["atrTimeframe"]; })}>{TIMEFRAMES.map((t) => <option key={t}>{t}</option>)}</select></div>
                    <div><label>ATR multiplier</label><input type="number" min={0.1} step="0.1" value={draft.trailing.atrMultiplier} onChange={(e) => edit((d) => { d.trailing.atrMultiplier = Number(e.target.value) || 2; })} /></div>
                  </>}
              <DistField label="Only move in steps of" d={draft.trailing.step} set={(x) => edit((d) => { d.trailing.step = x; })} hint="0 = move on every tick." />
            </div>
          </Rule>

          <Rule title="Partial take-profit" desc="Close part of the position at profit levels, let the rest run." on={draft.partials.enabled} onToggle={(v) => edit((d) => { d.partials.enabled = v; })}>
            {draft.partials.levels.map((lv, i) => (
              <div className="level" key={i}>
                <DistField label={`Level ${i + 1}: at profit of`} d={lv.at} set={(x) => edit((d) => { d.partials.levels[i].at = x; })} />
                <div><label>Close % of original lots</label><input type="number" min={1} max={99} value={lv.closePct} onChange={(e) => edit((d) => { d.partials.levels[i].closePct = Number(e.target.value) || 1; })} /></div>
                <button className="btn ghost" aria-label="Remove level" disabled={draft.partials.levels.length <= 1} onClick={() => edit((d) => { d.partials.levels.splice(i, 1); })}><Trash2 size={15} /></button>
              </div>
            ))}
            <button className="btn ghost" disabled={draft.partials.levels.length >= 6} onClick={() => edit((d) => { d.partials.levels.push({ at: { value: 2, unit: "r" }, closePct: 25 }); })}><Plus size={15} />Add level</button>
            <div className="hint">Never closes the whole position; levels too small for the minimum lot are skipped and logged.</div>
          </Rule>

          <Rule title="Auto stops" desc="Attach a stop-loss / take-profit to trades that have none." on={draft.autoStops.enabled} onToggle={(v) => edit((d) => { d.autoStops.enabled = v; })}>
            <div className="form">
              <DistField label="Stop-loss distance from entry" d={draft.autoStops.sl} set={(x) => edit((d) => { d.autoStops.sl = x; })} hint="0 = don't attach. 'R' can't be used here." />
              <DistField label="Take-profit distance from entry" d={draft.autoStops.tp} set={(x) => edit((d) => { d.autoStops.tp = x; })} hint="0 = don't attach." />
            </div>
          </Rule>

          <Rule title="Daily loss limit" desc="Guard rail on today's realised + floating loss." on={draft.dailyLoss.enabled} onToggle={(v) => edit((d) => { d.dailyLoss.enabled = v; })}>
            <div className="form">
              <div><label>Limit ({cur})</label><input type="number" min={0} step="any" value={draft.dailyLoss.limit} onChange={(e) => edit((d) => { d.dailyLoss.limit = Number(e.target.value) || 0; })} /></div>
              <div><label>When reached</label>
                <Seg label="Daily loss action" value={draft.dailyLoss.action} onChange={(a) => edit((d) => { d.dailyLoss.action = a; })} options={[{ id: "alert", label: "Log only" }, { id: "close_all", label: "Close all" }]} />
              </div>
            </div>
            <div className="hint">Day resets at 00:00 UTC. "Close all" also closes trades you open afterwards that day.</div>
          </Rule>

          <Rule title="Which trades" desc="Scope of everything above.">
            <div className="form">
              <div><label>Trades to manage</label>
                <Seg label="Scope" value={draft.scope.manualOnly ? "manual" : "all"} onChange={(v) => edit((d) => { d.scope.manualOnly = v === "manual"; })} options={[{ id: "manual", label: "Manual only" }, { id: "all", label: "Including EAs" }]} />
              </div>
              <div><label>Only these symbols (comma-separated, empty = all)</label>
                <input value={draft.scope.symbols.join(", ")} placeholder="XAUUSDm, EURUSDm" onChange={(e) => edit((d) => { d.scope.symbols = e.target.value.split(",").map((s) => s.trim()).filter(Boolean); })} /></div>
            </div>
          </Rule>

          <div className="save-bar">
            <button className="btn" disabled={!dirty || busy} onClick={save}>Save changes</button>
            {dirty && <button className="btn ghost" onClick={() => saved && setDraft({ ...saved })}>Discard</button>}
            <span className="muted">{dirty ? "Unsaved changes" : "All changes saved"}</span>
          </div>
        </div>

        <div className="grid" style={{ alignContent: "start" }}>
          <div className="card">
            <h3>Open positions {st?.account && <span className="muted" style={{ textTransform: "none", letterSpacing: 0 }}>· floating <b className={st.floating >= 0 ? "pos" : "neg"}>{money(st.floating, cur)}</b></span>}</h3>
            {!run.running ? <div className="muted">Start the service to see live positions.</div>
              : !st?.positions.length ? <div className="muted">No open positions.</div>
              : <div className="scroll"><table>
                  <thead><tr><th>Symbol</th><th>Side</th><th>Lots</th><th>SL</th><th>P&L</th><th>Next action</th></tr></thead>
                  <tbody>{st.positions.map((p) => (
                    <tr key={p.ticket}>
                      <td><b>{p.symbol}</b></td><td>{p.type}</td><td>{p.volume}</td><td>{p.sl || "–"}</td>
                      <td className={p.profit >= 0 ? "pos" : "neg"}>{money(p.profit, cur)}</td>
                      <td>{!p.managed ? <span className="muted">not managed</span> : p.next ?? <span className="muted">watching</span>}</td>
                    </tr>))}</tbody>
                </table></div>}
            {st?.dailyLoss.enabled && <div className={`hint ${st.dailyLoss.breached ? "neg" : ""}`}>Daily loss: realised {money(st.dailyLoss.realized, cur)} + floating {money(st.floating, cur)} / limit −{money(st.dailyLoss.limit, cur)}{st.dailyLoss.breached ? " — LIMIT REACHED" : ""}</div>}
          </div>

          <div className="card">
            <h3>Action log</h3>
            {!run.log.length ? <div className="muted">Nothing yet. Actions (and dry-run simulations) appear here.</div>
              : <div className="log">{run.log.map((e, i) => (
                  <div key={i} className={`log-row ${e.ok ? "" : "bad"}`}>
                    <span className="muted">{new Date(e.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                    <span className="badge" style={{ marginLeft: 0 }}>{e.dry ? "dry" : "live"}</span>
                    <span><b>{e.symbol || "account"}</b> {e.reason}{e.volume ? ` · ${e.volume} lots` : ""}{e.sl ? ` · SL ${e.sl}` : ""}{e.detail ? <span className="muted"> — {e.detail}</span> : null}</span>
                  </div>))}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
