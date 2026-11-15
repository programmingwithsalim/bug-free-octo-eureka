"""Integration tests for the runner using a fake MetaTrader5 module (no terminal, no real orders)."""
import json
import os
import tempfile
import types

import manager_logic as ml
from trade_manager import Manager


class Pos(types.SimpleNamespace):
    def _asdict(self):
        return dict(vars(self))


class FakeMT5:
    def __init__(self, positions, bid=2010.0, ask=2010.2):
        self.positions, self.bid, self.ask = positions, bid, ask
        self.checks, self.sends = [], []
        self.check_ret, self.send_ret = 0, 10009
        self.deals = []

    def positions_get(self): return list(self.positions)
    def account_info(self): return types.SimpleNamespace(login=1, currency="USD", balance=100.0, equity=100.0)
    def symbol_info(self, s): return types.SimpleNamespace(point=0.001, digits=3, volume_min=0.01, volume_step=0.01, trade_stops_level=10, filling_mode=2)
    def symbol_info_tick(self, s): return types.SimpleNamespace(bid=self.bid, ask=self.ask)
    def history_deals_get(self, *a, **k): return self.deals
    def copy_rates_from_pos(self, *a): return None
    def last_error(self): return (0, "ok")

    def order_check(self, req):
        self.checks.append(req)
        return types.SimpleNamespace(retcode=self.check_ret, comment="chk")

    def order_send(self, req):
        self.sends.append(req)
        return types.SimpleNamespace(retcode=self.send_ret, comment="snd")


def pos(ticket=1, **o):
    return Pos(**{**dict(ticket=ticket, symbol="XAUUSDm", type=0, volume=0.10, price_open=2000.0, sl=1990.0, tp=0.0, magic=0, profit=10.0, swap=0.0), **o})


def mgr(positions, cfg, **fake_kw):
    d = tempfile.mkdtemp()
    with open(os.path.join(d, "bot-config.json"), "w") as f:
        json.dump(cfg, f)
    m = Manager(d)
    m.load_config()
    m.mt5, m.connected = FakeMT5(positions, **fake_kw), True
    return m, m.mt5


def logs(m):
    try:
        return [json.loads(l) for l in open(m.p("bot-log.jsonl"))]
    except OSError:
        return []


BE = {"breakEven": {"enabled": True, "trigger": {"value": 5, "unit": "price"}, "offset": {"value": 0, "unit": "price"}}}


def test_disabled_never_calls_the_broker_but_previews():
    m, f = mgr([pos()], {"enabled": False, "dryRun": False, **BE})
    rows = m.cycle()
    assert f.checks == [] and f.sends == [] and logs(m) == []
    assert "break-even" in rows[0]["next"]


def test_dry_run_checks_but_never_sends_and_does_not_spam():
    m, f = mgr([pos()], {"enabled": True, "dryRun": True, **BE})
    for _ in range(5):
        m.cycle()
    assert f.sends == [] and len(f.checks) == 1
    [e] = logs(m)
    assert e["dry"] is True and e["ok"] is True and e["action"] == "modify"


def test_live_modify_is_sent_once_and_tied_to_position():
    m, f = mgr([pos()], {"enabled": True, "dryRun": False, **BE})
    m.cycle()
    assert len(f.sends) == 1 and f.sends[0]["position"] == 1 and f.sends[0]["sl"] == 2000.0
    f.positions = [pos(sl=2000.0)]  # broker applied it
    m.cycle()
    assert len(f.sends) == 1


def test_failed_send_is_logged_and_backs_off():
    m, f = mgr([pos()], {"enabled": True, "dryRun": False, **BE})
    f.send_ret = 10013
    m.cycle(); m.cycle(); m.cycle()
    assert len(f.sends) == 1  # retry only after the 30s back-off
    assert logs(m)[0]["ok"] is False


def test_check_rejection_blocks_send():
    m, f = mgr([pos()], {"enabled": True, "dryRun": False, **BE})
    f.check_ret = 10016  # invalid stops
    m.cycle()
    assert f.sends == [] and logs(m)[0]["ok"] is False


def test_partial_closes_once_even_if_position_volume_is_unchanged():
    cfg = {"enabled": True, "dryRun": False, "partials": {"enabled": True, "levels": [{"at": {"value": 5, "unit": "price"}, "closePct": 50}]}}
    m, f = mgr([pos()], cfg)
    m.cycle(); m.cycle(); m.cycle()
    assert len(f.sends) == 1
    s = f.sends[0]
    assert s["action"] == ml.ACTION_DEAL and s["position"] == 1 and s["volume"] == 0.05 and s["type"] == 1
    assert json.load(open(m.p("bot-state.json")))["1"]["partialsDone"] == [0]


def test_manual_only_ignores_bot_trades_and_closed_positions_are_forgotten():
    m, f = mgr([pos(1, magic=555), pos(2)], {"enabled": True, "dryRun": False, **BE})
    m.cycle()
    assert [s["position"] for s in f.sends] == [2]
    f.positions = []
    m.cycle()
    assert m.state == {}


def test_daily_loss_close_all_flattens_in_scope_positions_only():
    cfg = {"enabled": True, "dryRun": False, "dailyLoss": {"enabled": True, "limit": 20, "action": "close_all"}}
    m, f = mgr([pos(1, profit=-15.0), pos(2, profit=-10.0), pos(3, magic=9, profit=0.0)], cfg)
    m.cycle()
    assert sorted(s["position"] for s in f.sends) == [1, 2]
    assert all(s["volume"] == 0.10 and s["action"] == ml.ACTION_DEAL for s in f.sends)


def test_daily_loss_alert_only_does_not_close():
    cfg = {"enabled": True, "dryRun": False, "dailyLoss": {"enabled": True, "limit": 20, "action": "alert"}}
    m, f = mgr([pos(1, profit=-30.0)], cfg)
    m.cycle(); m.cycle()
    assert f.sends == []
    assert [e["action"] for e in logs(m)].count("daily_loss") == 1


def test_no_request_ever_lacks_a_position():
    cfg = {"enabled": True, "dryRun": False, **BE, "autoStops": {"enabled": True, "sl": {"value": 5, "unit": "price"}, "tp": {"value": 20, "unit": "price"}},
           "partials": {"enabled": True, "levels": [{"at": {"value": 5, "unit": "price"}, "closePct": 50}]}}
    m, f = mgr([pos(1, sl=0.0), pos(2)], cfg)
    for _ in range(3):
        m.cycle()
    assert f.sends and all("position" in r and r["position"] in (1, 2) for r in f.sends + f.checks)
