from patterns import Series, candle_signals, double_top_bottom, head_shoulders, sweep_signals, trendline_signals

T0, TF = 1_700_000_000, 900


def path(waypoints, steps, wick=0.2, extra=()):
    """Closes interpolate linearly between waypoints (steps = bars per leg); each bar opens at the previous close."""
    closes = [waypoints[0]]
    for a, b, n in zip(waypoints, waypoints[1:], steps):
        closes += [a + (b - a) * k / n for k in range(1, n + 1)]
    rows, prev = [], closes[0]
    for idx, c in enumerate(closes):
        rows.append((T0 + idx * TF, prev, max(prev, c) + wick, min(prev, c) - wick, c))
        prev = c
    for o, h, l, c in extra:  # hand-built final bars
        rows.append((T0 + len(rows) * TF, o, h, l, c))
    return rows


def scan(rows, fn):
    s = Series(rows)
    return [(i, r) for i in range(40, s.n) for r in fn(s, i)]


def mirror(rows, pivot=200.0):
    return [(t, pivot - o, pivot - l, pivot - h, pivot - c) for t, o, h, l, c in rows]


def test_double_top_fires_once_on_the_neckline_break_and_not_before():
    rows = path([100, 120, 110, 120.3, 105], [20, 10, 10, 15])
    hits = scan(rows, double_top_bottom)
    assert len(hits) == 1
    i, r = hits[0]
    s = Series(rows)
    assert r["setup"] == "double_top" and r["side"] == "sell"
    assert s.c[i] < 110 < s.c[i - 1]                         # first close below the neckline (110)
    assert r["sl"] > r["entry"] > r["tp"]
    assert abs(r["level"] - 110) < 0.5
    assert 98.9 < r["tp"] < 99.9                             # neckline minus the pattern height (wicks included)


def test_double_bottom_is_the_mirror_image():
    hits = scan(mirror(path([100, 120, 110, 120.3, 105], [20, 10, 10, 15])), double_top_bottom)
    assert len(hits) == 1 and hits[0][1]["setup"] == "double_bottom" and hits[0][1]["side"] == "buy"
    assert hits[0][1]["sl"] < hits[0][1]["entry"] < hits[0][1]["tp"]


def test_unequal_peaks_are_not_a_double_top():
    assert scan(path([100, 120, 110, 126, 105], [20, 10, 10, 15]), double_top_bottom) == []


def test_head_and_shoulders_and_inverse():
    rows = path([100, 110, 105, 120, 105.5, 110.5, 95], [10, 5, 15, 15, 5, 15])
    hits = scan(rows, head_shoulders)
    assert len(hits) == 1 and hits[0][1]["setup"] == "head_shoulders" and hits[0][1]["side"] == "sell"
    r = hits[0][1]
    assert r["sl"] > r["entry"] > r["tp"] and len(r["points"]) == 5
    inv = scan(mirror(rows), head_shoulders)
    assert len(inv) == 1 and inv[0][1]["setup"] == "inverse_head_shoulders" and inv[0][1]["side"] == "buy"


def test_head_lower_than_shoulders_is_rejected():
    assert scan(path([100, 115, 105, 110, 105.5, 115.5, 95], [10, 5, 15, 15, 5, 15]), head_shoulders) == []


def test_trendline_bounce_needs_three_touches_and_a_confirmation_candle():
    wp = [100, 110, 104, 114, 108, 118, 112, 122, 116.3]
    hammer = [(116.5, 116.7, 114.9, 116.6)]
    hits = [h for h in scan(path(wp, [10] * 8, extra=hammer), trendline_signals) if h[1]["setup"] == "trendline_bounce"]
    assert len(hits) == 1
    r = hits[0][1]
    assert r["side"] == "buy" and r["sl"] < r["entry"] < r["tp"] and "Hammer" in " ".join(r["reasons"])
    # same approach WITHOUT a confirmation candle: no signal
    plain = [(116.4, 116.8, 116.2, 116.6)]
    assert [h for h in scan(path(wp, [10] * 8, extra=plain), trendline_signals) if h[1]["setup"] == "trendline_bounce"] == []


def test_liquidity_sweep_rejection_targets_the_opposite_pool():
    # swing high ~120.2, price returns to 119.3, then a candle spikes to 121.5 and closes back at 119.0 (stops taken)
    rows = path([100, 120, 112, 119.3], [20, 10, 10], extra=[(119.3, 121.5, 118.9, 119.0)])
    hits = [h for h in scan(rows, sweep_signals) if h[1]["setup"] == "sweep_reject"]
    assert len(hits) == 1
    r = hits[0][1]
    assert r["side"] == "sell" and r["sl"] > 121.5 and r["tp"] < r["entry"]
    assert "sweep" in r["reasons"][0].lower()


def test_sweep_that_closes_beyond_the_level_is_a_breakout_not_a_sweep():
    rows = path([100, 120, 112, 119.3], [20, 10, 10], extra=[(119.3, 122.0, 119.2, 121.8)])
    assert [h for h in scan(rows, sweep_signals) if h[1]["setup"] == "sweep_reject"] == []


def test_sweep_then_structure_shift_is_confirmed_on_the_shift_bar_only():
    rows = path([100, 120, 112, 119.3], [20, 10, 10], extra=[(119.3, 121.5, 119.0, 119.4), (119.4, 119.5, 117.0, 117.2)])
    s = Series(rows)
    hits = [h for h in scan(rows, sweep_signals) if h[1]["setup"] == "sweep_mss"]
    assert len(hits) == 1 and hits[0][0] == s.n - 1
    assert hits[0][1]["confirmed"] and hits[0][1]["side"] == "sell"


def test_candlestick_patterns():
    base = path([100, 105, 100], [10, 10])
    bull = base + [(T0 + 99, 100, 100.2, 98.0, 98.2), (T0 + 100, 98.0, 101.2, 97.9, 101.0)]
    s = Series([(T0 + k * TF, *r[1:]) for k, r in enumerate(bull)])
    assert "Bullish engulfing" in [c["name"] for c in candle_signals(s, s.n - 1)]
    hammer = base + [(T0 + 99, 100, 100.1, 98.3, 100.0)]  # long lower wick, closes at the top
    s = Series([(T0 + k * TF, *r[1:]) for k, r in enumerate(hammer)])
    assert [c["side"] for c in candle_signals(s, s.n - 1) if "Hammer" in c["name"]] == ["buy"]
    star = base + [(T0 + 99, 100, 100.2, 99.9, 100.0), (T0 + 100, 100.0, 102.6, 99.9, 102.5)]
    shooting = base + [(T0 + 99, 100.0, 102.5, 99.9, 100.1)]  # long upper wick, closes at the bottom
    s = Series([(T0 + k * TF, *r[1:]) for k, r in enumerate(shooting)])
    assert [c["side"] for c in candle_signals(s, s.n - 1) if "Shooting" in c["name"]] == ["sell"]
    # an ordinary small candle triggers nothing
    flat = base + [(T0 + 99, 100.0, 100.4, 99.7, 100.2)]
    s = Series([(T0 + k * TF, *r[1:]) for k, r in enumerate(flat)])
    assert candle_signals(s, s.n - 1) == []
    del star


def test_no_lookahead_changing_future_bars_never_changes_earlier_signals():
    rows = path([100, 120, 110, 120.3, 105], [20, 10, 10, 15])
    a = [(i, r["setup"]) for i, r in scan(rows, double_top_bottom)]
    cut = a[0][0]
    wild = rows[: cut + 1] + [(t, o + 30, h + 40, l - 40, c + 30) for t, o, h, l, c in rows[cut + 1:]]
    s = Series(wild)
    assert [(i, r["setup"]) for i in range(40, cut + 1) for r in double_top_bottom(s, i)] == [(cut, "double_top")]
