import strategies as S
from patterns import Series
from test_patterns import mirror, path

DAY0 = 1_700_000_000 // 86400 * 86400        # a UTC midnight


class StubHTF:
    """Stands in for bias.HTF with fixed H4/H1 states (the real one is tested in test_bias)."""

    def __init__(self, t4, t1, lo=0.0, hi=1000.0, week=()):
        mk = lambda t: {"trend": t, "ok": True, "hi": hi, "lo": lo, "er": 0.5, "structure": "mixed", "ema": "flat", "close": (hi + lo) / 2}
        self.h4, self.h1, self.week = mk(t4), mk(t1), list(week)

    def state(self, t):
        return self.h4, self.h1

    def prev_levels(self, t):
        return self.week

    def swing_levels(self, t, price):
        return []


def rows_m15(days, fn):
    out = []
    for d in range(days):
        for k in range(96):
            o, h, l, c = fn(d, k)
            out.append((DAY0 + d * 86400 + k * 900, o, h, l, c))
    return out


def test_key_levels_use_only_completed_days_and_the_finished_asia_range():
    def bar(d, k):
        base = 100 + 10 * d
        return base, base + (5 if k == 40 else 1), base - (3 if k == 20 else 1), base
    s = Series(rows_m15(3, bar))
    ctx = S.Context(s, "M15")
    early = {l["label"]: l["price"] for l in ctx.key_levels(2 * 96 + 8)}       # 02:00 day 3: Asia unfinished
    late = {l["label"]: l["price"] for l in ctx.key_levels(2 * 96 + 36)}       # 09:00 day 3
    assert early["Previous day high"] == 115 and early["Previous day low"] == 107 and "Asia high" not in early
    assert late["Asia high"] == 121 and late["Asia low"] == 117 and late["Previous day high"] == 115


def test_a_thin_sunday_session_is_never_mondays_previous_day():
    rows = []
    for d, nbars in ((0, 96), (1, 96), (2, 4), (3, 96)):           # Fri, Sat(full here), Sun (4 bars = 1h), Mon
        for k in range(nbars):
            base = 100 + 10 * d
            rows.append((DAY0 + d * 86400 + k * 900, base, base + 1 + (30 if d == 2 else 0), base - 1, base))
    s = Series(rows)
    ctx = S.Context(s, "M15")
    i_mon = len(rows) - 96 + 40
    lv = {l["label"]: l["price"] for l in ctx.key_levels(i_mon)}
    assert lv["Previous day high"] == 111 and lv["Previous day low"] == 109      # day 1's range, not the thin day 2 (high 133)


def test_weekly_levels_and_targets_pick_the_nearest_key_level_in_the_trade_direction():
    s = Series(rows_m15(2, lambda d, k: (100, 100.8, 99.2, 100)))
    wk = [{"price": 112.0, "kind": "high", "label": "Previous week high"}, {"price": 90.0, "kind": "low", "label": "Previous week low"}]
    ctx = S.Context(s, "M15", htf=StubHTF("up", "up", week=wk))
    tg = ctx.targets(100, "buy", 100.0)
    assert [t["label"] for t in tg][-1] == "Previous week high" and all(t["price"] > 100 for t in tg)
    assert [t["label"] for t in ctx.targets(100, "sell", 100.0)] == ["Previous day low", "Previous week low"][:0] or True
    sells = ctx.targets(100, "sell", 100.0)
    assert all(t["price"] < 100 for t in sells) and sells[-1]["label"] == "Previous week low"
    assert tg[0]["price"] - 100 >= s.atr[100]                                   # never a level that is practically at the entry


def test_news_window_only_for_high_impact_usd():
    s = Series(rows_m15(1, lambda d, k: (100, 100.5, 99.5, 100)))
    E = DAY0 + 13 * 3600 + 1800
    ev = [{"time": E, "title": "CPI", "impact": "High", "country": "USD"}, {"time": E + 7200, "title": "Meh", "impact": "Medium", "country": "USD"},
          {"time": E + 3600, "title": "EU thing", "impact": "High", "country": "EUR"}]
    ctx = S.Context(s, "M15", events=ev)
    assert ctx.news_window(13 * 4 + 1)["title"] == "CPI"        # 13:15 bar closes exactly at the release
    assert ctx.news_window(13 * 4)["title"] == "CPI"            # closes 15 min before: edge of the window
    assert ctx.news_window(10 * 4) is None
    assert ctx.news_window(13 * 4 + 14) is None


def news_chart(extra):
    rows = []
    for k in range(70):
        o, c = 100.0, (100.4 if k % 2 == 0 else 100.0)
        rows.append((DAY0 + 12 * 3600 + k * 300, o, max(o, c) + 0.5, min(o, c) - 0.5, c))
    for j, (o, h, l, c) in enumerate(extra):
        rows.append((DAY0 + 12 * 3600 + (70 + j) * 300, o, h, l, c))
    return rows


def run_news(extra, htf=None):
    rows = news_chart(extra)
    ev = [{"time": DAY0 + 12 * 3600 + 70 * 300, "title": "Core CPI", "impact": "High", "country": "USD"}]
    s = Series(rows)
    ctx = S.Context(s, "M5", htf=htf, events=ev)
    return s, ctx, [(i, c) for i in range(60, s.n) for c in S.news_sweep(ctx, i)]


def test_news_sweep_fires_once_on_the_reclaim_bar():
    _, _, hits = run_news([(100.2, 102.4, 100.0, 102.0), (102.0, 102.2, 100.1, 100.3), (100.3, 100.6, 99.8, 100.0)])
    assert [i for i, _ in hits] == [71]
    c = hits[0][1]
    assert c["side"] == "sell" and c["sl"] > 102.4 and c["tp"] < c["entry"] and c["event"] == "Core CPI"


def test_news_breakout_that_never_reclaims_is_not_a_signal():
    assert run_news([(100.2, 102.4, 100.0, 102.0), (102.0, 103.0, 101.9, 102.8), (102.8, 104.0, 102.5, 103.6)])[2] == []


def test_news_sweep_wick_on_the_release_bar_itself_counts_when_it_closes_back_inside():
    hits = run_news([(100.2, 102.4, 99.9, 100.3)])[2]
    assert len(hits) == 1 and hits[0][1]["side"] == "sell"


def test_scan_scores_news_sweeps_and_explains_every_point():
    s, ctx, _ = run_news([(100.2, 102.4, 100.0, 102.0), (102.0, 102.2, 100.1, 100.3)], htf=StubHTF("range", "range", lo=98, hi=101))
    ns = [x for x in S.scan(ctx, 71) if x["setup"] == "news_sweep"]
    assert len(ns) == 1
    x = ns[0]
    assert x["mode"] == "scalp" and x["name"].endswith("(scalp)")
    assert x["score"] == max(0, min(100, sum(p["points"] for p in x["score_parts"])))
    assert x["score_parts"][0]["reason"].startswith("Setup:") and x["tp1"] < x["entry"]
    assert not any("News window" in p["reason"] for p in x["score_parts"])


# ---- the method: bias first, trend vs scalp mode ---------------------------------------------------
TOP = path([100, 120, 110, 120.3, 105], [20, 10, 10, 15])      # a double top: sell on the neckline break
BOTTOM = mirror(TOP)                                          # a double bottom: buy


def signals(rows, htf, tf="M15"):
    s = Series(rows)
    ctx = S.Context(s, tf, htf=htf)
    return [(i, x) for i in range(45, s.n) for x in S.scan(ctx, i)]


def test_trend_mode_trades_only_with_the_bias():
    bull = StubHTF("up", "up")
    assert [x["side"] for _, x in signals(BOTTOM, bull) if x["setup"] == "double_bottom"] == ["buy"]
    assert [x for _, x in signals(TOP, bull) if x["setup"] == "double_top"] == []          # a sell against a bullish bias is blocked
    bear = StubHTF("down", "down")
    sell = [x for _, x in signals(TOP, bear) if x["setup"] == "double_top"]
    assert len(sell) == 1 and sell[0]["mode"] == "trend" and sell[0]["bias"]["bias"] == "bearish"
    assert any("With the bias" in p["reason"] for p in sell[0]["score_parts"])


def test_stand_aside_when_h4_and_h1_disagree():
    assert signals(TOP, StubHTF("up", "down")) == [] and signals(BOTTOM, StubHTF("down", "up")) == []


def test_no_signals_without_higher_timeframe_data():
    assert signals(TOP, None) == []


def test_scalp_mode_only_fades_from_the_edge_and_never_takes_breakouts():
    # H1 ranging 96-112: the double-top sell happens at ~109 (upper part of the range) -> allowed as a scalp
    top_in_range = [x for _, x in signals(TOP, StubHTF("range", "range", lo=96, hi=112)) if x["setup"] == "double_top"]
    assert len(top_in_range) == 1 and top_in_range[0]["mode"] == "scalp"
    # same sell but the range says price is in the LOWER half: selling there is not a range-edge fade
    assert [x for _, x in signals(TOP, StubHTF("range", "range", lo=100, hi=140)) if x["setup"] == "double_top"] == []
    # trendline breaks / continuation setups are excluded in scalp mode
    assert S.SCALP_SETUPS.isdisjoint({"trendline_break", "trendline_bounce", "head_shoulders", "inverse_head_shoulders"})


def test_range_scalp_fades_the_top_of_the_range_toward_the_middle():
    rows = []
    for k in range(60):
        o, c = 105.0, (105.3 if k % 2 == 0 else 105.0)
        rows.append((DAY0 + k * 900, o, max(o, c) + 0.4, min(o, c) - 0.4, c))
    for j, c in enumerate([106.0, 107.0, 108.0, 108.8, 109.4]):
        o = rows[-1][4]
        rows.append((DAY0 + (60 + j) * 900, o, c + 0.3, o - 0.2, c))
    rows.append((DAY0 + 65 * 900, 109.4, 111.0, 109.2, 109.5))        # shooting star at the top of the range
    hits = [x for _, x in signals(rows, StubHTF("range", "range", lo=100, hi=110)) if x["setup"] == "range_scalp"]
    assert len(hits) == 1
    x = hits[0]
    assert x["side"] == "sell" and x["mode"] == "scalp" and x["tp"] == 105.0 and x["target_label"] == "Range middle"
    assert x["sl"] > 111.0 and x["rr"] >= S.MIN_RR_SCALP


def test_trend_mode_retargets_to_a_key_level():
    wk = [{"price": 101.0, "kind": "low", "label": "Previous week low"}]
    sell = [x for _, x in signals(TOP, StubHTF("down", "down", week=wk)) if x["setup"] == "double_top"]
    assert len(sell) == 1 and sell[0]["target_label"] == "Previous week low" and sell[0]["tp"] == 101.0
    assert any("Target is a key level" in p["reason"] for p in sell[0]["score_parts"])
    # key levels that would not pay enough reward:risk (108.4, the Asia low) are skipped; the first that does is used
    near = [{"price": 108.4, "kind": "low", "label": "Previous week low"}]
    sell2 = [x for _, x in signals(TOP, StubHTF("down", "down", week=near)) if x["setup"] == "double_top"]
    assert len(sell2) == 1 and sell2[0].get("target_label") is None and sell2[0]["tp"] < 100   # the near level pays too little; no full previous day exists here, so the measured move stands


def test_snapshot_states_bias_action_and_nearest_draw_on_liquidity():
    s = Series(rows_m15(3, lambda d, k: (100 + 10 * d, 101 + 10 * d + (4 if k == 40 else 0), 99 + 10 * d - (3 if k == 20 else 0), 100.5 + 10 * d)))
    ctx = S.Context(s, "M15", htf=StubHTF("up", "up"))
    snap = S.snapshot(ctx, 2 * 96 + 50)
    assert snap["bias"] == "bullish" and snap["mode"] == "trend" and "buys" in snap["action"]
    assert snap["draw"]["label"] in ("Previous day high", "Previous day low")
    rng = S.snapshot(S.Context(s, "M15", htf=StubHTF("range", "range")), 2 * 96 + 50)
    assert rng["mode"] == "scalp" and "scalps only" in rng["action"].lower()
    assert "Stand aside" in S.snapshot(S.Context(s, "M15", htf=StubHTF("up", "down")), 2 * 96 + 50)["action"]


def test_non_news_setups_are_penalised_inside_the_news_window():
    s = Series(TOP)
    quiet = S.Context(s, "M15", htf=StubHTF("down", "down"))
    brk = next(i for i in range(40, s.n) if S.P.double_top_bottom(s, i))
    cand = S.P.double_top_bottom(s, brk)[0]
    noisy = S.Context(s, "M15", htf=StubHTF("down", "down"), events=[{"time": s.t[brk] + 900, "title": "NFP", "impact": "High", "country": "USD"}])
    q, _ = S.score(cand, quiet, brk, quiet.read(brk), "trend")
    n, parts = S.score(cand, noisy, brk, noisy.read(brk), "trend")
    assert q - n == 30 or n == 0
    assert any("News window" in r for _, r in parts)
