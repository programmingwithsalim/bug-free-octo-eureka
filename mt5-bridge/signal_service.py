"""Signal alert service: watches XAUUSD on MT5 and alerts you even when the web page is closed.

Method (see strategies.py): H4+H1 decide bias/regime first; entries are M15 setups; daily plans head for the previous
day's high/low. Alerts only fire on CLOSED candles, for the newest closed bar only (a restart never replays old signals).

Reads  <data-dir>/alerts-config.json (re-read on change) and <data-dir>/backtest.json (for the quality gate)
Writes <data-dir>/signal-status.json (heartbeat + market read), signals.jsonl (alerts + outcomes), signal-state.json
"""
import argparse
import json
import os
import signal as os_signal
import sys
import time
from bisect import bisect_left
from datetime import datetime, timezone

import backtest as BT
import bias as BIAS
import history as H
import news as NEWS
import notify as NOTIFY
import patterns as P
import strategies as S

DEFAULT_CFG = {
    "enabled": True,
    "symbol": "XAUUSDm",
    "channels": {"desktop": True, "sound": True, "telegram": {"enabled": False, "token": "", "chatId": ""}},
    "minScore": 70,                 # for pattern/sweep/trendline setups
    "maxPerDay": 6,                 # hard cap on setup alerts per UTC day (patience!)
    "plans": {"07": False, "12": True},   # 07:00 failed the backtest gate: off unless you turn it on
    "briefing": True,               # morning read ~06:45 UTC
    "biasChange": True,
    "news": {"enabled": True, "minutes": [30, 10]},
    "setups": {},                   # setup -> "auto" (alert only if it passed the backtest gate) | "on" | "off"
    "scalps": True,
    "quiet": {"enabled": False, "start": 22, "end": 6},     # UTC hours: no alerts in this window
}
FRESH_SEC = 20 * 60                 # a bar older than this is never alerted (startup / PC woke from sleep)
STALE_AFTER = 6.0


def merge(base, over):
    out = {}
    for k, v in base.items():
        o = (over or {}).get(k) if isinstance(over, dict) else None
        if isinstance(v, dict) and k != "setups":
            out[k] = merge(v, o if isinstance(o, dict) else {})
        elif k == "setups":
            out[k] = {a: b for a, b in (o or {}).items() if b in ("auto", "on", "off")}
        else:
            out[k] = o if (o is not None and type(o) is type(v) or (isinstance(v, (int, float)) and isinstance(o, (int, float)) and not isinstance(o, bool))) else v
    return out


def resolve(s: P.Series, sig):
    """Forward-test outcome of an alerted signal on closed bars (same rules as the backtest). None while still open."""
    j0 = bisect_left(s.t, sig["time"])
    if j0 >= s.n or s.t[j0] != sig["time"] or j0 + 1 >= s.n:
        return None
    d = 1 if sig["side"] == "buy" else -1
    entry, sl, tp = s.o[j0 + 1], sig["sl"], sig["tp"]
    risk = (entry - sl) * d
    if risk <= 0.1 * s.atr[j0] or (tp - entry) * d <= 0:
        return {"status": "skipped", "r": 0.0, "note": "price had already moved past the stop or target at the next open"}
    hold = BT.MAX_HOLD.get(sig.get("mode", "trend"), 96)
    last = min(s.n - 1, j0 + hold)
    for j in range(j0 + 1, last + 1):
        if (s.l[j] <= sl) if d > 0 else (s.h[j] >= sl):
            return {"status": "sl", "r": ((sl - entry) * d - BT.SPREAD) / risk, "at": s.t[j]}
        if (s.h[j] >= tp) if d > 0 else (s.l[j] <= tp):
            return {"status": "tp", "r": ((tp - entry) * d - BT.SPREAD) / risk, "at": s.t[j]}
    if j0 + hold <= s.n - 1:
        return {"status": "time", "r": ((s.c[last] - entry) * d - BT.SPREAD) / risk, "at": s.t[last]}
    return None


def _write_json(path, obj):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf8") as f:
        json.dump(obj, f)
    os.replace(tmp, path)


def _read_json(path, default):
    try:
        with open(path, encoding="utf8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def hhmm(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime("%H:%M")


class Service:
    def __init__(self, data_dir, mt5, now=time.time, news_loader=NEWS.load, senders=None):
        self.dir, self.mt5, self.now, self.news_loader, self.senders = data_dir, mt5, now, news_loader, senders
        os.makedirs(data_dir, exist_ok=True)
        self.p = lambda n: os.path.join(data_dir, n)
        self.state = merge_state(_read_json(self.p("signal-state.json"), {}))
        self.cfg, self._cfg_m = merge(DEFAULT_CFG, {}), -1.0
        self._ctx_key, self.s, self.ctx = None, None, None
        self.error, self.news_info = None, {"ok": False, "events": [], "note": "not loaded"}

    # ---- plumbing ------------------------------------------------------------------------------
    def config(self):
        try:
            m = os.path.getmtime(self.p("alerts-config.json"))
        except OSError:
            m = 0.0
        if m != self._cfg_m:
            self._cfg_m = m
            self.cfg = merge(DEFAULT_CFG, _read_json(self.p("alerts-config.json"), {}))
        return self.cfg

    def log(self, **e):
        with open(self.p("signals.jsonl"), "a", encoding="utf8") as f:
            f.write(json.dumps({"t": int(self.now()), **e}) + "\n")

    def save_state(self):
        st = self.state
        st["seen"] = st["seen"][-600:]
        st["sent"] = st["sent"][-300:]
        _write_json(self.p("signal-state.json"), st)

    def gate(self):
        bt = _read_json(self.p("backtest.json"), {})
        return {r["setup"]: r for r in (bt.get("report", {}) or {}).get("setups", [])}

    def evidence(self, setup):
        r = self.gate().get(setup)
        if not r:
            return "Evidence: no backtest yet (run the Strategy lab). Treat as unproven."
        t, o = r["total"], r["out_of_sample"]
        base = f"Backtest 13 months M15: n={t['n']}, avg {t['avg_r']:+.2f}R, win {t['win'] * 100:.0f}%, out-of-sample {o['avg_r']:+.2f}R (n={o['n']})."
        return base + (" PASSED the quality gate." if r["passes"] else " UNPROVEN: did not pass the gate. Use it as a prompt to look, not a reason to trade.")

    # ---- market data -----------------------------------------------------------------------------
    def load_market(self, cfg):
        now = self.now()
        sym = cfg["symbol"]
        m15 = H.get_rows(self.mt5, self.dir, sym, "M15", 25, now)
        h1 = H.get_rows(self.mt5, self.dir, sym, "H1", 120, now)
        h4 = H.get_rows(self.mt5, self.dir, sym, "H4", 300, now)
        if len(m15) < 120 or len(h1) < 60 or len(h4) < 40:
            raise RuntimeError(f"Not enough {sym} history from MT5 (M15 {len(m15)}, H1 {len(h1)}, H4 {len(h4)}). Open the symbol in MT5 and scroll the charts so it loads.")
        key = (m15[-1][0], len(m15), len(self.news_info.get("events", [])))
        if key != self._ctx_key:
            self.s = P.Series(m15)
            self.ctx = S.Context(self.s, S.ENTRY_TF, htf=BIAS.HTF(P.Series(h1), P.Series(h4)), events=self.news_info.get("events", []))
            self._ctx_key = key

    # ---- alert policy --------------------------------------------------------------------------
    def allowed(self, sig, cfg, gate):
        """-> (ok, reason)"""
        now = self.now()
        q = cfg["quiet"]
        h = datetime.fromtimestamp(now, timezone.utc).hour
        if q["enabled"] and ((q["start"] <= h or h < q["end"]) if q["start"] > q["end"] else (q["start"] <= h < q["end"])):
            return False, "quiet hours"
        if sig.get("kind") == "plan":
            return (bool(cfg["plans"].get(sig["setup"][-2:], True)), "plan disabled")
        pref = cfg["setups"].get(sig["setup"], "auto")
        passed = bool(gate.get(sig["setup"], {}).get("passes"))
        if pref == "off" or (pref == "auto" and not passed):
            return False, "setup not enabled (it has not passed the backtest gate)" if pref == "auto" else "setup off"
        if sig["mode"] == "scalp" and not cfg["scalps"]:
            return False, "scalps off"
        if sig["score"] < cfg["minScore"]:
            return False, f"score {sig['score']} < {cfg['minScore']}"
        day = datetime.fromtimestamp(now, timezone.utc).strftime("%Y-%m-%d")
        if self.state["day_counts"].get(day, 0) >= cfg["maxPerDay"]:
            return False, "daily alert cap reached"
        return True, ""

    def sig_record(self, sig):
        s = self.s
        pts = [{"t": s.t[p["i"]], "price": p["price"], "label": p["label"]} for p in sig.get("points", []) if 0 <= p.get("i", -1) < s.n]
        keep = ("setup", "side", "entry", "sl", "tp", "tf", "time", "close_time", "score", "mode", "rr", "risk", "tp1", "atr", "name", "kind", "level", "level_label",
                "reasons", "score_parts", "bias", "targets", "target_label", "event")
        return {**{k: sig[k] for k in keep if k in sig}, "points": pts, "id": f"{self.cfg['symbol']}|{sig['tf']}|{sig['setup']}|{sig['side']}|{sig['time']}", "symbol": self.cfg["symbol"]}

    def handle(self, sig, cfg):
        rec = self.sig_record(sig)
        if rec["id"] in self.state["seen"]:
            return
        if self.now() - sig["close_time"] > FRESH_SEC:
            return
        ok, why = self.allowed(sig, cfg, self.gate())
        self.state["seen"].append(rec["id"])
        if not ok:
            self.log(type="suppressed", id=rec["id"], setup=sig["setup"], side=sig["side"], reason=why, score=sig.get("score"))
            return
        title, body = NOTIFY.format_signal(sig, self.evidence(sig["setup"]))
        res = NOTIFY.send(cfg, title, body, "signal", self.senders)
        self.log(type="signal", status="open", delivery={k: v[0] for k, v in res.items()}, **rec)
        if sig.get("kind") != "plan":
            day = datetime.fromtimestamp(self.now(), timezone.utc).strftime("%Y-%m-%d")
            self.state["day_counts"][day] = self.state["day_counts"].get(day, 0) + 1
        self.state["open"].append({"id": rec["id"], "setup": sig["setup"], "time": sig["time"], "side": sig["side"], "sl": sig["sl"], "tp": sig["tp"], "mode": sig.get("mode", "trend")})

    def info(self, kind, title, body, cfg):
        res = NOTIFY.send(cfg, title, body, "info", self.senders)
        self.log(type="info", kind=kind, title=title, body=body, delivery={k: v[0] for k, v in res.items()})

    # ---- per-bar work --------------------------------------------------------------------------
    def on_new_bar(self, cfg):
        s, ctx = self.s, self.ctx
        i = s.n - 1
        self.track(s)
        if self.now() - (s.t[i] + ctx.tfs) > FRESH_SEC:
            return                                           # market closed / PC was asleep: nothing fresh to say
        plan = S.draw_plan(ctx, i)
        if plan:
            self.handle(plan, cfg)
        for sig in S.scan(ctx, i):
            self.handle(sig, cfg)
        r = ctx.read(i)
        t_close = s.t[i] + ctx.tfs
        day = datetime.fromtimestamp(t_close, timezone.utc).strftime("%Y-%m-%d")
        h = (t_close % 86400) / 3600
        if cfg["briefing"] and 6.75 <= h < 7.75 and ((t_close // 86400) + 4) % 7 < 5 and self.state["briefed"] != day and r["ok"]:
            snap = S.snapshot(ctx, i)
            self.state["briefed"] = day
            d = snap["draw"]
            self.info("briefing", f"Morning read: {snap['bias'].upper()} bias, {snap['mode']} mode",
                      f"H4 {snap['h4']['trend']}, H1 {snap['h1']['trend']}. {snap['action']}"
                      + (f"\nLikely draw on liquidity: {d['label']} {d['price']:,.2f} ({d['distance']:.1f} away)." if d else "")
                      + "\nDon't enter without a reason you can write down.", cfg)
        if cfg["biasChange"] and r["ok"]:
            cur = (r["bias"], r["regime"])
            if cur == tuple(self.state["bias_pending"] or ()) and cur != tuple(self.state["bias"] or ()):
                if self.state["bias"]:
                    self.info("bias", f"Bias changed: {r['bias']} / {r['regime']}", f"{r['why']}.\nPrevious: {self.state['bias'][0]} / {self.state['bias'][1]}. Re-read the chart before your next entry.", cfg)
                self.state["bias"] = list(cur)
            self.state["bias_pending"] = list(cur)

    def track(self, s):
        still = []
        for o in self.state["open"]:
            res = resolve(s, o)
            if res is None:
                still.append(o)
                continue
            self.log(type="update", id=o["id"], setup=o["setup"], **res)
            f = self.state["forward"].setdefault(o["setup"], {"n": 0, "wins": 0, "sum_r": 0.0})
            if res["status"] != "skipped":
                f["n"] += 1
                f["wins"] += 1 if res["r"] > 0 else 0
                f["sum_r"] += res["r"]
        self.state["open"] = still

    def news_alerts(self, cfg):
        if not cfg["news"]["enabled"]:
            return
        now = self.now()
        for e in NEWS.upcoming(self.news_info.get("events", []), now, hours=1):
            if e["time"] < now:
                continue
            for lead in cfg["news"]["minutes"]:
                key = f"news:{e['time']}:{lead}"
                if e["time"] - lead * 60 <= now and key not in self.state["sent"]:
                    self.state["sent"].append(key)
                    mins = max(1, round((e["time"] - now) / 60))
                    self.info("news", f"High-impact USD in {mins} min: {e['title']}", f"{e['title']} at {hhmm(e['time'])} UTC (forecast {e.get('forecast') or 'n/a'}, previous {e.get('previous') or 'n/a'}).\n"
                              "Spreads widen and gold whipsaws. Don't open new trades now: let the first spike sweep liquidity, then look for a reclaim.", cfg)

    # ---- main cycle ------------------------------------------------------------------------------
    def cycle(self):
        cfg = self.config()
        now = self.now()
        self.error = None
        try:
            self.news_info = self.news_loader(self.p("news.json"), now=now) if cfg["news"]["enabled"] else {"ok": False, "events": [], "note": "news off"}
            if cfg["enabled"]:
                self.load_market(cfg)
                bar = self.s.t[-1]
                if bar != self.state["last_bar"]:
                    self.on_new_bar(cfg)
                    self.state["last_bar"] = bar
                self.news_alerts(cfg)
        except Exception as e:  # noqa: BLE001 - keep the service alive and show the problem in the UI
            self.error = f"{type(e).__name__}: {e}"
        self.save_state()
        self.write_status(cfg)

    def write_status(self, cfg):
        snap = None
        if self.ctx is not None and self.s is not None:
            try:
                snap = S.snapshot(self.ctx, self.s.n - 1)
                snap["h4"] = {k: snap["h4"][k] for k in ("trend", "structure", "er")} if snap.get("h4") else None
                snap["h1"] = {k: snap["h1"][k] for k in ("trend", "structure", "er", "hi", "lo")} if snap.get("h1") else None
            except Exception:  # noqa: BLE001
                snap = None
        now = self.now()
        masked = json.loads(json.dumps(cfg))
        tg = masked["channels"]["telegram"]
        tg["token"] = "set" if tg.get("token") else ""
        _write_json(self.p("signal-status.json"), {
            "pid": os.getpid(), "ts": now, "connected": self.error is None, "error": self.error, "enabled": cfg["enabled"], "symbol": cfg["symbol"],
            "bar_time": self.s.t[-1] if self.s else None, "snapshot": snap,
            "news": {"ok": self.news_info.get("ok"), "note": self.news_info.get("note"), "upcoming": NEWS.upcoming(self.news_info.get("events", []), now, hours=48)},
            "today": self.state["day_counts"].get(datetime.fromtimestamp(now, timezone.utc).strftime("%Y-%m-%d"), 0),
            "forward": self.state["forward"], "open": len(self.state["open"]), "config": masked,
        })


def merge_state(st):
    base = {"last_bar": None, "seen": [], "sent": [], "open": [], "day_counts": {}, "forward": {}, "briefed": None, "bias": None, "bias_pending": None}
    return {**base, **{k: v for k, v in (st or {}).items() if k in base}}


def run_forever(data_dir):
    prev = _read_json(os.path.join(data_dir, "signal-status.json"), {})
    if prev.get("pid") not in (None, os.getpid()) and time.time() - prev.get("ts", 0) < STALE_AFTER:
        print("Another signal service is already running.", file=sys.stderr)
        return 1
    import MetaTrader5 as mt5
    stop = {"v": False}
    for sg in (os_signal.SIGINT, os_signal.SIGTERM):
        os_signal.signal(sg, lambda *_: stop.update(v=True))
    svc = Service(data_dir, mt5)
    connected = False
    while not stop["v"]:
        if not connected:
            connected = bool(mt5.initialize())
            if not connected:
                svc.error = f"Cannot connect to MT5: {mt5.last_error()}"
                svc.write_status(svc.config())
        if connected:
            svc.cycle()
            if svc.error and "MT5" in svc.error:
                connected = False
        time.sleep(20)
    svc.write_status(svc.config())
    mt5.shutdown()
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data"))
    sys.exit(run_forever(os.path.abspath(ap.parse_args().data_dir)))
