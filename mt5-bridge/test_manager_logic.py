from manager_logic import (ACTION_DEAL, ACTION_SLTP, DEFAULT_CONFIG, atr_from_rates, build_close_request, build_modify_request,
                           daily_loss_breached, in_scope, merge_config, observe, pick_filling, plan_action)
import copy

# XAUUSDm-like: 3 digits, point 0.001, pip = 0.01
INFO = dict(point=0.001, digits=3, volume_min=0.01, volume_step=0.01, trade_stops_level=10, bid=2010.0, ask=2010.2)


def pos(**o):
    return {**dict(ticket=1, symbol="XAUUSDm", type=0, volume=0.10, price_open=2000.0, sl=1990.0, tp=0.0, magic=0, profit=0), **o}


def cfg(**sections):
    c = copy.deepcopy(DEFAULT_CONFIG)
    c["enabled"] = True
    for k, v in sections.items():
        c[k].update(v)
    return c


def plan(p, c, info=INFO, atr=None, st=None):
    st = observe(p, st if st is not None else {})
    return plan_action(p, info, c, st, atr)


def test_nothing_enabled_does_nothing():
    assert plan(pos(), cfg()) is None


def test_break_even_long_at_1r_with_offset():
    c = cfg(breakEven={"enabled": True, "trigger": {"value": 1, "unit": "r"}, "offset": {"value": 0.5, "unit": "price"}})
    assert plan(pos(), c, info={**INFO, "bid": 2009.0}) is None                      # +9 < 1R(10)
    a = plan(pos(), c)                                                              # +10 = 1R
    assert a == {"type": "modify", "sl": 2000.5, "tp": None, "reason": "break-even"}


def test_break_even_short():
    c = cfg(breakEven={"enabled": True, "trigger": {"value": 5, "unit": "price"}, "offset": {"value": 0, "unit": "price"}})
    p = pos(type=1, price_open=2000.0, sl=2010.0)
    a = plan(p, c, info={**INFO, "bid": 1994.8, "ask": 1995.0})
    assert a["sl"] == 2000.0 and a["reason"] == "break-even"


def test_stop_never_loosens_and_never_repeats():
    c = cfg(trailing={"enabled": True, "start": {"value": 1, "unit": "price"}, "distance": {"value": 3, "unit": "price"}})
    # price 2010 -> candidate 2007; current SL already 2008 -> no change
    assert plan(pos(sl=2008.0), c) is None
    # same SL as candidate -> no change
    assert plan(pos(sl=2007.0), c) is None
    assert plan(pos(sl=2005.0), c)["sl"] == 2007.0


def test_trailing_step_and_start():
    c = cfg(trailing={"enabled": True, "start": {"value": 5, "unit": "price"}, "distance": {"value": 3, "unit": "price"},
                      "step": {"value": 1, "unit": "price"}})
    assert plan(pos(sl=2006.5), c) is None  # candidate 2007 is only +0.5, below the 1.0 step
    assert plan(pos(sl=2005.0), c)["sl"] == 2007.0
    assert plan(pos(sl=2005.0), c, info={**INFO, "bid": 2004.0}) is None  # not yet at start (+4 < 5)


def test_trailing_atr_mode_and_missing_atr():
    c = cfg(trailing={"enabled": True, "mode": "atr", "atrMultiplier": 2.0, "start": {"value": 1, "unit": "price"}})
    assert plan(pos(sl=1990.0), c, atr=None) is None
    assert plan(pos(sl=1990.0), c, atr=1.5)["sl"] == 2007.0  # 2010 - 2*1.5


def test_respects_broker_min_distance():
    c = cfg(trailing={"enabled": True, "start": {"value": 0.1, "unit": "price"}, "distance": {"value": 0.001, "unit": "price"}})
    assert plan(pos(sl=1990.0), c) is None  # 0.001 < stops_level(10 points = 0.01)


def test_break_even_and_trail_pick_most_protective():
    c = cfg(breakEven={"enabled": True, "trigger": {"value": 1, "unit": "price"}, "offset": {"value": 1, "unit": "price"}},
            trailing={"enabled": True, "start": {"value": 1, "unit": "price"}, "distance": {"value": 4, "unit": "price"}})
    a = plan(pos(sl=1990.0), c)
    assert a["sl"] == 2006.0 and a["reason"] == "trailing"  # trail 2006 beats BE 2001


def test_r_units_need_an_initial_stop():
    c = cfg(breakEven={"enabled": True, "trigger": {"value": 1, "unit": "r"}})
    assert plan(pos(sl=0.0), c) is None  # no SL -> risk unknown -> can't use R


def test_partial_close_once_with_lot_rounding():
    c = cfg(partials={"enabled": True, "levels": [{"at": {"value": 1, "unit": "r"}, "closePct": 50}]})
    st = {}
    a = plan(pos(volume=0.10), c, st=st)
    assert a["type"] == "partial" and a["volume"] == 0.05 and a["level"] == 0
    st["partialsDone"].append(0)
    assert plan(pos(volume=0.05), c, st=st) is None  # already done; initialVolume remembered


def test_partial_too_small_is_skipped_not_forced():
    c = cfg(partials={"enabled": True, "levels": [{"at": {"value": 1, "unit": "r"}, "closePct": 50}]})
    a = plan(pos(volume=0.01), c)
    assert a["type"] == "skip_partial"
    c2 = cfg(partials={"enabled": True, "levels": [{"at": {"value": 1, "unit": "r"}, "closePct": 100}]})
    assert plan(pos(volume=0.10), c2)["type"] == "skip_partial"  # never closes the whole position as a "partial"


def test_multi_level_partials_in_order():
    c = cfg(partials={"enabled": True, "levels": [{"at": {"value": 5, "unit": "price"}, "closePct": 30}, {"at": {"value": 20, "unit": "price"}, "closePct": 30}]})
    st = {}
    assert plan(pos(volume=0.10), c, st=st)["level"] == 0
    st["partialsDone"].append(0)
    assert plan(pos(volume=0.07), c, st=st) is None                    # +10 < 20
    a = plan(pos(volume=0.07), c, info={**INFO, "bid": 2021.0}, st=st)
    assert a["level"] == 1 and a["volume"] == 0.03


def test_auto_stops_attach_only_when_missing():
    c = cfg(autoStops={"enabled": True, "sl": {"value": 5, "unit": "price"}, "tp": {"value": 10, "unit": "price"}})
    a = plan(pos(sl=0.0, tp=0.0, price_open=2009.0), c)
    assert (a["sl"], a["tp"]) == (2004.0, 2019.0)
    assert plan(pos(sl=1990.0, tp=2050.0), c) is None
    a = plan(pos(sl=1990.0, tp=0.0, price_open=2005.0), c)  # only TP missing -> SL untouched
    assert a["sl"] is None and a["tp"] == 2015.0
    assert plan(pos(sl=1990.0, tp=0.0), c) is None  # TP would land at/behind the market -> skipped


def test_auto_stops_skips_when_too_close_to_market():
    c = cfg(autoStops={"enabled": True, "sl": {"value": 5, "unit": "price"}, "tp": {"value": 0, "unit": "price"}})
    # price already 15 below the would-be SL for a short? long opened 2000, price 1990 -> SL 1995 is above price: invalid
    assert plan(pos(sl=0.0), c, info={**INFO, "bid": 1990.0, "ask": 1990.2}) is None


def test_pips_and_points_units():
    c = cfg(breakEven={"enabled": True, "trigger": {"value": 500, "unit": "pips"}, "offset": {"value": 0, "unit": "price"}})
    assert plan(pos(), c)["sl"] == 2000.0  # 500 pips = 5.00 on a 3-digit symbol (pip 0.01)... profit 10 >= 5
    c = cfg(breakEven={"enabled": True, "trigger": {"value": 20000, "unit": "points"}})
    assert plan(pos(), c) is None  # 20000 points = 20.0 > 10 profit


def test_requests_are_tied_to_positions_and_opposite_side():
    p = pos(volume=0.10)
    r = build_close_request(p, 0.05, INFO, 1)
    assert r["action"] == ACTION_DEAL and r["position"] == 1 and r["type"] == 1 and r["price"] == INFO["bid"]
    short = pos(type=1)
    r = build_close_request(short, 5.0, INFO, 1)  # volume clamped to the position
    assert r["type"] == 0 and r["price"] == INFO["ask"] and r["volume"] == 0.10
    m = build_modify_request(p, {"type": "modify", "sl": 2005.0, "tp": None})
    assert m["action"] == ACTION_SLTP and m["position"] == 1 and m["sl"] == 2005.0 and m["tp"] == 0.0


def test_scope_filters():
    c = cfg()
    assert in_scope(pos(magic=0), c) and not in_scope(pos(magic=123), c)
    c["scope"]["manualOnly"] = False
    assert in_scope(pos(magic=123), c)
    c["scope"]["symbols"] = ["eurusdm"]
    assert not in_scope(pos(), c) and in_scope(pos(symbol="EURUSDm"), c)


def test_daily_loss_and_config_merge_and_misc():
    c = cfg(dailyLoss={"enabled": True, "limit": 50.0, "action": "alert"})
    assert daily_loss_breached(c, -30, -20) and not daily_loss_breached(c, -30, -19)
    assert not daily_loss_breached(cfg(), -1000, -1000)  # disabled
    m = merge_config({"enabled": True, "trailing": {"enabled": True, "distance": {"value": "bad"}}, "junk": 1})
    assert m["enabled"] is True and m["trailing"]["enabled"] is True and m["dryRun"] is True
    assert m["trailing"]["distance"]["value"] == 1.0  # bad type falls back
    assert pick_filling(2) == 1 and pick_filling(1) == 0 and pick_filling(0) == 2
    assert atr_from_rates([2, 3, 4], [1, 1, 2], [1.5, 2, 3], 2) == (max(3 - 1, abs(3 - 1.5), abs(1 - 1.5)) + max(4 - 2, abs(4 - 2), abs(2 - 2))) / 2
