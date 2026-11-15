"""Trade manager: manages positions YOU opened (trailing stop, break-even, partial closes, auto stops,
daily-loss guard). It never opens a trade.

Run:  python trade_manager.py --data-dir ../data
Reads  <data-dir>/bot-config.json   (re-read on change)
Writes <data-dir>/bot-status.json   (heartbeat + live positions + what it would do next)
       <data-dir>/bot-log.jsonl     (every action taken / simulated)
       <data-dir>/bot-state.json    (per-position memory: initial lot/stop, partials done)
"""
import argparse
import json
import os
import signal
import sys
import time
from datetime import datetime, timedelta, timezone

import manager_logic as ml

STALE = 6.0  # seconds without heartbeat => another instance is considered dead


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf8") as f:
        json.dump(obj, f)
    os.replace(tmp, path)


def read_json(path, default):
    try:
        with open(path, encoding="utf8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


class Manager:
    def __init__(self, data_dir):
        self.dir = data_dir
        os.makedirs(data_dir, exist_ok=True)
        self.p = lambda n: os.path.join(data_dir, n)
        self.cfg, self.cfg_mtime = ml.merge_config({}), 0.0
        self.state = read_json(self.p("bot-state.json"), {})
        self.saved_state = json.dumps(self.state, sort_keys=True)
        self.mem = {}          # ticket -> {"sig":..., "retry_at":...}  (in-memory spam control)
        self.atr_cache = {}
        self.day = None
        self.day_alerted = False
        self.realized, self.realized_at = 0.0, 0.0
        self.last_error = None
        self.mt5 = None
        self.connected = False
        self.account = None

    # ---- plumbing -----------------------------------------------------------------------
    def log(self, **entry):
        entry = {"t": now_iso(), **entry}
        with open(self.p("bot-log.jsonl"), "a", encoding="utf8") as f:
            f.write(json.dumps(entry) + "\n")

    def load_config(self):
        path = self.p("bot-config.json")
        try:
            m = os.path.getmtime(path)
        except OSError:
            m = 0.0
        if m != self.cfg_mtime:
            self.cfg_mtime = m
            self.cfg = ml.merge_config(read_json(path, {}))

    def connect(self):
        import MetaTrader5 as mt5
        self.mt5 = mt5
        if mt5.initialize():
            acc = mt5.account_info()
            self.connected = acc is not None
            self.account = {"login": acc.login, "currency": acc.currency, "balance": acc.balance, "equity": acc.equity} if acc else None
            self.last_error = None if acc else "MT5 is open but not logged in"
        else:
            self.connected = False
            self.last_error = f"Cannot connect to MT5: {mt5.last_error()}"

    # ---- market data --------------------------------------------------------------------
    def symbol_info(self, symbol):
        si, tick = self.mt5.symbol_info(symbol), self.mt5.symbol_info_tick(symbol)
        if si is None or tick is None:
            return None
        return {"point": si.point, "digits": si.digits, "volume_min": si.volume_min, "volume_step": si.volume_step,
                "trade_stops_level": si.trade_stops_level, "filling_mode": si.filling_mode, "bid": tick.bid, "ask": tick.ask}

    def atr(self, symbol):
        tr = self.cfg["trailing"]
        if not (tr["enabled"] and tr["mode"] == "atr"):
            return None
        key = (symbol, tr["atrTimeframe"], int(tr["atrPeriod"]))
        hit = self.atr_cache.get(key)
        if hit and time.time() - hit[0] < 15:
            return hit[1]
        tf = getattr(self.mt5, "TIMEFRAME_" + str(tr["atrTimeframe"]).upper(), None)
        val = None
        if tf is not None:
            rates = self.mt5.copy_rates_from_pos(symbol, tf, 0, int(tr["atrPeriod"]) + 1)
            if rates is not None and len(rates):
                val = ml.atr_from_rates([r["high"] for r in rates], [r["low"] for r in rates], [r["close"] for r in rates], int(tr["atrPeriod"]))
        self.atr_cache[key] = (time.time(), val)
        return val

    def realized_today(self):
        if time.time() - self.realized_at < 10:
            return self.realized
        mt5 = self.mt5
        now = datetime.now(timezone.utc)
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        deals = mt5.history_deals_get(start, now + timedelta(days=1)) or []
        self.realized = sum(d.profit + d.commission + d.swap + d.fee for d in deals if d.type in (0, 1) and d.entry in (1, 3))
        self.realized_at = time.time()
        return self.realized

    # ---- execution ----------------------------------------------------------------------
    def execute(self, pos, info, action, dry):
        """Validate with order_check; send only when not a dry run. Returns (ok, detail)."""
        mt5 = self.mt5
        filling = ml.pick_filling(info["filling_mode"])
        if action["type"] == "modify":
            req = ml.build_modify_request(pos, action)
        else:
            req = ml.build_close_request(pos, action["volume"], info, filling, "tj-bot " + action.get("reason", ""))
        chk = mt5.order_check(req)
        if chk is None or chk.retcode not in (0, 10009):
            return False, f"rejected by order_check: {getattr(chk, 'retcode', None)} {getattr(chk, 'comment', mt5.last_error())}"
        if dry:
            return True, "dry run - order_check passed, nothing sent"
        res = mt5.order_send(req)
        if res is None or res.retcode not in (10008, 10009):
            return False, f"order_send failed: {getattr(res, 'retcode', None)} {getattr(res, 'comment', mt5.last_error())}"
        return True, "sent"

    def apply(self, pos, info, action, st, dry):
        t = pos["ticket"]
        mem = self.mem.setdefault(t, {})
        if action["type"] == "skip_partial":
            if action["level"] not in st["partialsDone"]:
                st["partialsDone"].append(action["level"])
                self.log(ticket=t, symbol=pos["symbol"], action="skip", reason=action["reason"], dry=dry, ok=True)
            return
        sig = (action["type"], action.get("sl"), action.get("tp"), action.get("volume"), action.get("level"))
        if mem.get("sig") == sig and (dry or time.time() < mem.get("retry_at", 0)):
            return  # already logged this exact plan; don't spam
        if time.time() < mem.get("retry_at", 0):
            return
        ok, detail = self.execute(pos, info, action, dry)
        mem["sig"] = sig
        mem["retry_at"] = 0 if ok else time.time() + 30
        if ok and not dry and action["type"] == "partial":
            st["partialsDone"].append(action["level"])
        self.log(ticket=t, symbol=pos["symbol"], action=action["type"], reason=action["reason"], dry=dry, ok=ok, detail=detail,
                 sl=action.get("sl"), tp=action.get("tp"), volume=action.get("volume"))

    # ---- one cycle ----------------------------------------------------------------------
    def cycle(self):
        mt5, cfg = self.mt5, self.cfg
        positions = mt5.positions_get()
        if positions is None:
            self.connected = False
            self.last_error = f"positions_get failed: {mt5.last_error()}"
            return []
        acc = mt5.account_info()
        if acc:
            self.account = {"login": acc.login, "currency": acc.currency, "balance": acc.balance, "equity": acc.equity}
        dry, active = cfg["dryRun"], cfg["enabled"]
        out, floating, open_tickets = [], 0.0, set()
        flatten = False

        today = datetime.now(timezone.utc).date().isoformat()
        if today != self.day:
            self.day, self.day_alerted = today, False
        floating = sum(p.profit + p.swap for p in positions)
        breached = ml.daily_loss_breached(cfg, self.realized_today() if cfg["dailyLoss"]["enabled"] else 0.0, floating)
        if breached and active and not self.day_alerted:
            self.day_alerted = True
            self.log(ticket=0, symbol="", action="daily_loss", reason=f"daily loss limit {cfg['dailyLoss']['limit']:g} reached", dry=dry, ok=True,
                     detail=("closing all managed positions" if cfg["dailyLoss"]["action"] == "close_all" else "alert only"))
        flatten = breached and active and cfg["dailyLoss"]["action"] == "close_all"

        for raw in positions:
            pos = raw._asdict()
            open_tickets.add(str(pos["ticket"]))
            managed = ml.in_scope(pos, cfg)
            row = {"ticket": pos["ticket"], "symbol": pos["symbol"], "type": "buy" if pos["type"] == 0 else "sell", "volume": pos["volume"],
                   "open": pos["price_open"], "sl": pos["sl"], "tp": pos["tp"], "profit": round(pos["profit"], 2), "managed": managed, "next": None}
            if managed:
                info = self.symbol_info(pos["symbol"])
                if info:
                    st = ml.observe(pos, self.state.setdefault(str(pos["ticket"]), {}))
                    if flatten:
                        action = {"type": "partial", "volume": pos["volume"], "level": -1, "reason": "daily loss limit: close position"}
                    else:
                        action = ml.plan_action(pos, info, cfg, st, self.atr(pos["symbol"]))
                    if action:
                        row["next"] = action["reason"] + (f" → SL {action['sl']}" if action.get("sl") else "") + (f" → TP {action['tp']}" if action.get("tp") else "") \
                            + (f" ({action['volume']} lots)" if action.get("volume") else "")
                        if active:
                            self.apply(pos, info, action, st, dry)
            out.append(row)

        for t in list(self.state):
            if t not in open_tickets:
                self.state.pop(t, None)
                self.mem.pop(int(t), None)
        snap = json.dumps(self.state, sort_keys=True)
        if snap != self.saved_state:
            write_json(self.p("bot-state.json"), self.state)
            self.saved_state = snap
        self.connected, self.last_error = True, None
        self.floating = round(floating, 2)
        return out

    def write_status(self, positions):
        write_json(self.p("bot-status.json"), {
            "pid": os.getpid(), "ts": time.time(), "connected": self.connected, "error": self.last_error,
            "enabled": self.cfg["enabled"], "dryRun": self.cfg["dryRun"], "account": self.account,
            "positions": positions, "floating": getattr(self, "floating", 0.0),
            "dailyLoss": {"enabled": self.cfg["dailyLoss"]["enabled"], "limit": self.cfg["dailyLoss"]["limit"],
                          "realized": round(self.realized, 2), "breached": ml.daily_loss_breached(self.cfg, self.realized, getattr(self, "floating", 0.0))},
        })

    def run(self):
        prev = read_json(self.p("bot-status.json"), {})
        # (never probe a PID with os.kill on Windows - it terminates the process; rely on the heartbeat age instead)
        if prev.get("pid") not in (None, os.getpid()) and time.time() - prev.get("ts", 0) < STALE:
            print("Another trade manager is already running.", file=sys.stderr)
            return 1
        stop = {"v": False}
        for s in (signal.SIGINT, signal.SIGTERM):
            signal.signal(s, lambda *_: stop.update(v=True))
        self.log(ticket=0, symbol="", action="service", reason="trade manager started", dry=True, ok=True)
        while not stop["v"]:
            self.load_config()
            positions = []
            try:
                if not self.connected:
                    self.connect()
                if self.connected:
                    positions = self.cycle()
            except Exception as e:  # keep the service alive; surface the problem in the UI
                self.connected, self.last_error = False, f"{type(e).__name__}: {e}"
            self.write_status(positions)
            time.sleep(min(30.0, max(0.5, float(self.cfg["pollSeconds"]))))
        self.write_status([])
        try:
            self.mt5 and self.mt5.shutdown()
        except Exception:
            pass
        return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data"))
    sys.exit(Manager(os.path.abspath(ap.parse_args().data_dir)).run())
