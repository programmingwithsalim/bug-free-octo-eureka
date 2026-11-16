import json
import math
import os
import tempfile
from datetime import datetime, timezone

import patterns as P
import signal_service as SV

UTC = timezone.utc
MON_1200 = int(datetime(2026, 11, 16, 12, 0, 30, tzinfo=UTC).timestamp())      # a Monday


class FakeMT5:
    """Serves a synthetic XAUUSD: every weekday oscillates 4500-4560, Saturday closed, Sunday only its last hour."""
    TIMEFRAME_M15, TIMEFRAME_H1, TIMEFRAME_H4 = "M15", "H1", "H4"
    PHASE = 0.7297 - math.pi                     # puts 12:00 UTC at ~4550, rising toward the day's high

    def __init__(self, now):
        self.now = now

    def symbol_select(self, *a):
        return True

    @staticmethod
    def price(k):
        return 4530 + 30 * math.sin(2 * math.pi * k / 96 + FakeMT5.PHASE)

    def m15(self, t_end):
        rows, prev = [], None
        day0 = (t_end // 86400 - 30) * 86400
        for t in range(day0, int(t_end) + 1, 900):
            wd = ((t // 86400) + 4) % 7                       # 0 = Monday
            k = (t % 86400) // 900
            if wd == 5 or (wd == 6 and k < 92):
                prev = None
                continue
            c = self.price(k)
            o = c if prev is None else prev
            rows.append((t, o, max(o, c) + 0.3, min(o, c) - 0.3, c))
            prev = c
        return rows

    def copy_rates_range(self, sym, tf, d0, d1):
        t0, t1 = int(d0.timestamp()), int(d1.timestamp())
        base = [r for r in self.m15(t1) if t0 <= r[0] <= t1]
        size = {"M15": 900, "H1": 3600, "H4": 14400}[tf]
        out, cur = [], None
        for t, o, h, l, c in base:
            k = t // size * size
            if cur and cur[0] == k:
                cur = [k, cur[1], max(cur[2], h), min(cur[3], l), c]
                out[-1] = cur
            else:
                cur = [k, o, h, l, c]
                out.append(cur)
        return [{"time": r[0], "open": r[1], "high": r[2], "low": r[3], "close": r[4]} for r in out]


def make(now=MON_1200, cfg=None, events=None, backtest=None):
    d = tempfile.mkdtemp()
    if cfg is not None:
        json.dump(cfg, open(os.path.join(d, "alerts-config.json"), "w"))
    if backtest is not None:
        json.dump(backtest, open(os.path.join(d, "backtest.json"), "w"))
    clock = [now]
    log = []
    senders = {"toast": lambda t, b: (log.append(("toast", t)), (True, "shown"))[1], "beep": lambda lv: (log.append(("beep", lv)), (True, "ok"))[1],
               "telegram": lambda tok, chat, text: (log.append(("tg", text)), (True, "sent"))[1]}
    news = {"ok": True, "events": events or [], "note": "fake"}
    svc = SV.Service(d, FakeMT5(now), now=lambda: clock[0], news_loader=lambda path, now=None: news, senders=senders)
    return svc, clock, log, d


def entries(d):
    try:
        return [json.loads(l) for l in open(os.path.join(d, "signals.jsonl"), encoding="utf8")]
    except OSError:
        return []


def test_daily_plan_fires_once_and_not_again_after_a_restart():
    svc, clock, log, d = make()
    svc.cycle()
    assert svc.error is None, svc.error
    sigs = [e for e in entries(d) if e["type"] == "signal"]
    assert len(sigs) == 1 and sigs[0]["setup"] == "draw_12" and sigs[0]["side"] == "buy" and sigs[0]["kind"] == "plan"
    assert sigs[0]["tp"] > sigs[0]["entry"] > sigs[0]["sl"] and sigs[0]["rr"] == 1.0
    assert [x[0] for x in log].count("toast") == 1 and ("beep", "signal") in log
    svc.cycle()                                              # same bar again: nothing new
    assert len([e for e in entries(d) if e["type"] == "signal"]) == 1
    restarted = SV.Service(d, FakeMT5(MON_1200), now=lambda: clock[0], news_loader=lambda path, now=None: {"ok": True, "events": []}, senders=svc.senders)
    restarted.cycle()                                        # a restart must not replay the same alert
    assert len([e for e in entries(d) if e["type"] == "signal"]) == 1


def test_plan_can_be_switched_off_and_the_reason_is_logged():
    svc, clock, log, d = make(cfg={"plans": {"12": False}})
    svc.cycle()
    assert [e for e in entries(d) if e["type"] == "signal"] == [] and log == []
    assert any(e["type"] == "suppressed" and e["reason"] == "plan disabled" for e in entries(d))


def test_a_stale_bar_is_never_alerted():
    svc, clock, log, d = make(now=MON_1200 + 21 * 60)        # PC woke up 21 minutes after the 12:00 close
    svc.cycle()
    assert [e for e in entries(d) if e["type"] == "signal"] == [] and log == []


def test_status_file_reports_the_market_read_and_never_contains_the_telegram_token():
    svc, clock, log, d = make(cfg={"channels": {"telegram": {"enabled": True, "token": "SECRET-TOKEN", "chatId": "7"}}})
    svc.cycle()
    raw = open(os.path.join(d, "signal-status.json"), encoding="utf8").read()
    st = json.loads(raw)
    assert "SECRET-TOKEN" not in raw and st["config"]["channels"]["telegram"]["token"] == "set"
    assert st["connected"] and st["symbol"] == "XAUUSDm" and st["snapshot"]["bias"] in ("bullish", "bearish", "neutral")
    assert st["snapshot"]["draw"]["label"] in ("Previous day high", "Previous day low") and "action" in st["snapshot"]
    assert any(x[0] == "tg" for x in log)                    # telegram channel was used


def test_not_enough_mt5_history_is_reported_not_crashed():
    class Empty(FakeMT5):
        def copy_rates_range(self, *a):
            return []
    svc, clock, log, d = make()
    svc.mt5 = Empty(MON_1200)
    svc.cycle()
    st = json.load(open(os.path.join(d, "signal-status.json")))
    assert st["connected"] is False and "Not enough" in st["error"]


def sig(**o):
    return {"setup": "sweep_mss", "side": "sell", "score": 80, "mode": "trend", "time": MON_1200, "close_time": MON_1200, **o}


def test_alert_policy_follows_the_backtest_gate_and_user_overrides():
    svc, clock, log, d = make()
    cfg, gate = svc.config(), {"sweep_mss": {"passes": False}, "range_scalp": {"passes": True}}
    assert svc.allowed(sig(), cfg, gate)[0] is False                                  # auto + failed gate -> silent
    assert svc.allowed(sig(setup="range_scalp"), cfg, gate)[0] is True                # auto + passed gate -> alert
    cfg["setups"]["sweep_mss"] = "on"
    assert svc.allowed(sig(), cfg, gate)[0] is True                                   # explicit opt-in
    cfg["setups"]["range_scalp"] = "off"
    assert svc.allowed(sig(setup="range_scalp"), cfg, gate)[0] is False
    assert svc.allowed(sig(score=60), cfg, gate)[1].startswith("score 60")            # below min score
    cfg["scalps"] = False
    assert svc.allowed(sig(mode="scalp"), cfg, gate)[1] == "scalps off"
    cfg["scalps"] = True
    day = datetime.fromtimestamp(MON_1200, UTC).strftime("%Y-%m-%d")
    svc.state["day_counts"][day] = cfg["maxPerDay"]
    assert svc.allowed(sig(), cfg, gate) == (False, "daily alert cap reached")
    svc.state["day_counts"].clear()
    cfg["quiet"] = {"enabled": True, "start": 11, "end": 13}                          # 12:00 is inside
    assert svc.allowed(sig(), cfg, gate) == (False, "quiet hours")
    cfg["quiet"] = {"enabled": True, "start": 22, "end": 6}                           # wraps midnight; 12:00 is outside
    assert svc.allowed(sig(), cfg, gate)[0] is True


def test_evidence_text_is_honest_about_unproven_setups():
    bt = {"report": {"setups": [{"setup": "sweep_mss", "passes": False, "total": {"n": 493, "avg_r": 0.04, "win": 0.41}, "out_of_sample": {"n": 148, "avg_r": -0.15}},
                                {"setup": "draw_12", "passes": True, "total": {"n": 122, "avg_r": 0.20, "win": 0.6}, "out_of_sample": {"n": 40, "avg_r": 0.15}}]}}
    svc, *_ = make(backtest=bt)
    assert "UNPROVEN" in svc.evidence("sweep_mss") and "-0.15R" in svc.evidence("sweep_mss")
    assert "PASSED" in svc.evidence("draw_12") and "UNPROVEN" not in svc.evidence("draw_12")
    assert "no backtest" in svc.evidence("never_tested")


def test_forward_tracking_resolves_target_stop_time_and_open():
    rows = [(i * 900, 100, 100.4, 99.6, 100) for i in range(30)]
    rows += [(30 * 900, 100, 101, 99.8, 100.9), (31 * 900, 100.9, 104.6, 100.5, 104.0)]           # target 104 hit on bar 31
    s = P.Series(rows)
    base = {"side": "buy", "sl": 98.0, "tp": 104.0, "mode": "trend", "time": 29 * 900}
    r = SV.resolve(s, base)
    assert r["status"] == "tp" and r["at"] == 31 * 900 and r["r"] > 0
    assert SV.resolve(s, {**base, "tp": 120.0}) is None                                            # still open
    stop_rows = rows[:30] + [(30 * 900, 100, 100.2, 97.5, 98.0)]
    assert SV.resolve(P.Series(stop_rows), base)["status"] == "sl"
    assert SV.resolve(P.Series(rows[:30]), base) is None                                           # no bar after the signal yet
    gap = rows[:30] + [(30 * 900, 97.0, 97.5, 96.5, 97.0)]
    assert SV.resolve(P.Series(gap), base)["status"] == "skipped"                                  # opened beyond the stop: never a real fill
    t = P.Series(rows[:30] + [(30 * 900 + k * 900, 100, 100.3, 99.7, 100.1) for k in range(40)])
    assert SV.resolve(t, {**base, "tp": 150.0, "mode": "scalp"})["status"] == "time"


def test_news_countdown_alerts_once_per_lead_time():
    ev = [{"time": MON_1200 + 25 * 60, "title": "Core CPI", "impact": "High", "country": "USD", "forecast": "0.3%", "previous": "0.2%"}]
    svc, clock, log, d = make(events=ev)
    svc.cycle()
    news = [e for e in entries(d) if e["type"] == "info" and e["kind"] == "news"]
    assert len(news) == 1 and "Core CPI" in news[0]["title"]                                      # the 30-minute lead
    svc.cycle()
    assert len([e for e in entries(d) if e.get("kind") == "news"]) == 1
    clock[0] = MON_1200 + 17 * 60                                                                  # 8 minutes before: the 10-minute lead
    svc.cycle()
    assert len([e for e in entries(d) if e.get("kind") == "news"]) == 2
    clock[0] = MON_1200 + 18 * 60
    svc.cycle()
    assert len([e for e in entries(d) if e.get("kind") == "news"]) == 2                            # no repeats
    assert not any(x[0] == "beep" and x[1] == "info" for x in log)                                  # info alerts are silent


def test_morning_briefing_is_sent_once_per_day():
    now = int(datetime(2026, 11, 16, 6, 45, 30, tzinfo=UTC).timestamp())
    svc, clock, log, d = make(now=now)
    svc.cycle()
    b = [e for e in entries(d) if e.get("kind") == "briefing"]
    assert len(b) == 1 and "Morning read" in b[0]["title"] and "Don't enter without a reason" in b[0]["body"]
    clock[0] = now + 900
    svc.cycle()
    assert len([e for e in entries(d) if e.get("kind") == "briefing"]) == 1


def test_heartbeat_keeps_the_status_fresh_between_scans_without_rescanning():
    svc, clock, log, d = make()
    svc.cycle()
    p = os.path.join(d, "signal-status.json")
    t0 = json.load(open(p))["ts"]
    entries_before = len(entries(d))
    clock[0] += 2
    svc.heartbeat()
    clock[0] += 2
    svc.heartbeat()
    st = json.load(open(p))
    assert st["ts"] == t0 + 4 and st["snapshot"] is not None and st["connected"]      # fresh timestamp, same content
    assert len(entries(d)) == entries_before                                           # no re-scan, no new alerts
    fresh = SV.Service(tempfile.mkdtemp(), FakeMT5(MON_1200), now=lambda: 0, news_loader=lambda p, now=None: {"ok": True, "events": []})
    fresh.heartbeat()                                                                  # before the first scan: harmless no-op
    assert fresh.last_status is None


def test_duplicate_instances_resolve_to_the_lowest_pid():
    live = {"pid": 100, "ts": 1000.0}
    assert SV.yield_to_other(live, my_pid=200, now=1005.0) is True       # a lower-pid copy is alive: this one exits
    assert SV.yield_to_other(live, my_pid=50, now=1005.0) is False       # I am the lowest: keep running
    assert SV.yield_to_other(live, my_pid=100, now=1005.0) is False      # it is me
    assert SV.yield_to_other(live, my_pid=200, now=1000.0 + SV.STALE_AFTER + 1) is False   # the other one is dead (stale heartbeat)
    assert SV.yield_to_other({}, my_pid=200, now=1.0) is False


def test_merge_ignores_junk_config_and_keeps_defaults():
    c = SV.merge(SV.DEFAULT_CFG, {"minScore": "high", "maxPerDay": 3, "setups": {"sweep_mss": "maybe", "range_scalp": "on"}, "channels": {"telegram": {"token": 5}}, "junk": 1})
    assert c["minScore"] == 70 and c["maxPerDay"] == 3 and c["setups"] == {"range_scalp": "on"} and c["channels"]["telegram"]["token"] == ""
