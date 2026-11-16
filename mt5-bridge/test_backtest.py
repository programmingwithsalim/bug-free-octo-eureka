import backtest as BT
import patterns as P
import strategies as S


def series(rows):
    return P.Series([(i * 900, o, h, l, c) for i, (o, h, l, c) in enumerate(rows)])


def sig(i, side="buy", sl=98.0, tp=104.0, mode="trend"):
    return {"i": i, "side": side, "sl": sl, "tp": tp, "mode": mode, "setup": "double_bottom", "score": 80, "rr": 2.0, "bias": {"bias": "bullish"}}


def flat(n, p=100.0, rng=0.4):
    return [(p, p + rng, p - rng, p)] * n


def test_target_hit_is_paid_with_the_spread_deducted():
    rows = flat(20) + [(100, 100.3, 99.8, 100.1)] * 1 + [(100.0, 101.0, 99.5, 100.8), (100.8, 104.5, 100.6, 104.2)] + flat(5, 104.2)
    s = series(rows)
    t = BT.simulate(s, sig(20))
    assert t["why"] == "target" and t["bars"] == 2
    risk = s.o[21] - 98.0
    assert abs(t["r"] - ((104.0 - s.o[21]) - BT.SPREAD) / risk) < 1e-9


def test_stop_wins_when_one_candle_touches_both():
    rows = flat(21) + [(100.0, 104.5, 97.5, 101.0)] + flat(5)
    t = BT.simulate(series(rows), sig(20))
    assert t["why"] == "stop" and t["r"] < -1.0                # a full loss plus the spread


def test_gap_past_the_stop_at_the_entry_is_not_a_fill():
    rows = flat(21) + [(97.0, 97.5, 96.5, 97.0)] + flat(5, 97.0)   # next candle OPENS below the stop
    assert BT.simulate(series(rows), sig(20)) is None
    rows2 = flat(21) + [(105.0, 105.5, 104.5, 105.0)] + flat(5, 105.0)   # opens beyond the target: no fill either
    assert BT.simulate(series(rows2), sig(20)) is None


def test_time_exit_closes_at_the_candle_close():
    rows = flat(21) + flat(120, 100.1, 0.3)
    t = BT.simulate(series(rows), sig(20, mode="scalp"))
    assert t["why"] == "time" and t["bars"] == BT.MAX_HOLD["scalp"]


def test_sell_side_mirrors():
    rows = flat(21) + [(100.0, 100.4, 99.0, 99.2), (99.2, 99.4, 95.5, 95.8)] + flat(5, 95.8)
    t = BT.simulate(series(rows), sig(20, side="sell", sl=102.0, tp=96.0))
    assert t["why"] == "target" and t["r"] > 0


def test_stats_split_and_gate():
    mk = lambda r, t: {"r": r, "t": t, "score": 75, "mode": "trend", "setup": "double_top"}
    good = [mk(1.5 if k % 3 else -1.0, k) for k in range(60)]
    st = BT.stats(good)
    assert st["n"] == 60 and abs(st["win"] - 40 / 60) < 1e-9 and st["avg_r"] > 0.3 and st["pf"] > 2 and st["max_dd"] >= 1.0
    ins, oos = BT.split(good)
    assert len(ins) + len(oos) == 60 and max(t["t"] for t in ins) < min(t["t"] for t in oos)
    ok, why = BT.passes(BT.stats(good), BT.stats(oos))
    assert ok and why == []
    # profitable in-sample but losing out-of-sample must be rejected (overfit)
    bad = [mk(1.5, k) for k in range(40)] + [mk(-1.0, 100 + k) for k in range(20)]
    i2, o2 = BT.split(bad)
    ok, why = BT.passes(BT.stats(bad), BT.stats(o2))
    assert not ok and any("out-of-sample" in w for w in why)
    # too few trades is never a pass
    few = [mk(2.0, k) for k in range(10)]
    assert not BT.passes(BT.stats(few), BT.stats(BT.split(few)[1]))[0]


def test_report_lists_each_setup_with_gate_verdict():
    trades = [{"r": 1.0 if k % 2 else -1.0, "t": k, "score": 80, "mode": "trend", "setup": "double_top", "bars": 3, "side": "sell", "rr_plan": 2, "bias": "bearish", "entry": 1, "i": k} for k in range(40)]
    rep = BT.report(trades)
    assert rep["n_trades"] == 40 and rep["setups"][0]["setup"] == "double_top" and rep["setups"][0]["passes"] is False
    assert rep["setups"][0]["name"] == S.SETUPS["double_top"]["name"] and rep["gate"]["min_n"] == 30
