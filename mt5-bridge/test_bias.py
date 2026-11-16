import datetime as dt

import bias as B
from patterns import Series

DAY0 = 1_700_000_000 // 86400 * 86400


def wave(waypoints, steps, tf, t0=DAY0, wick=0.2):
    closes = [waypoints[0]]
    for a, b, n in zip(waypoints, waypoints[1:], steps):
        closes += [a + (b - a) * k / n for k in range(1, n + 1)]
    rows, prev = [], closes[0]
    for idx, c in enumerate(closes):
        rows.append((t0 + idx * tf, prev, max(prev, c) + wick, min(prev, c) - wick, c))
        prev = c
    return rows


UP = [100, 110, 105, 116, 111, 122, 117, 128, 123, 134, 129, 140, 135, 146]
DOWN = [200 - p for p in UP]
RANGE = [100, 105] * 8 + [100]


def test_uptrend_downtrend_and_range_are_told_apart():
    up = Series(wave(UP, [8] * 13, 3600))
    dn = Series(wave(DOWN, [8] * 13, 3600))
    rg = Series(wave(RANGE, [5] * 16, 3600))
    assert B.tf_state(up, up.n - 1)["trend"] == "up"
    assert B.tf_state(dn, dn.n - 1)["trend"] == "down"
    st = B.tf_state(rg, rg.n - 1)
    assert st["trend"] == "range" and st["er"] < B.ER_RANGE
    assert B.structure(up.pivots_at(up.n - 1)) == "up" and B.structure(dn.pivots_at(dn.n - 1)) == "down"


def test_combine_table():
    s = lambda t: {"trend": t}
    assert B.combine(s("up"), s("up"))[:3] == ("bullish", "strong", "trending")
    assert B.combine(s("down"), s("down"))[:3] == ("bearish", "strong", "trending")
    assert B.combine(s("up"), s("range"))[:3] == ("bullish", "weak", "ranging")
    assert B.combine(s("range"), s("down"))[:3] == ("bearish", "weak", "trending")
    b = B.combine(s("up"), s("down"))
    assert b[0] == "neutral" and "Wait" in b[3]            # H1 pullback inside an H4 uptrend: stand aside
    assert B.combine(s("range"), s("range"))[:3] == ("neutral", "none", "ranging")


def test_read_uses_only_closed_htf_bars_and_reports_bullish_when_both_up():
    h1 = Series(wave(UP, [8] * 13, 3600))
    h4 = Series(wave(UP, [8] * 13, 14400, t0=DAY0 - 100 * 14400))   # long enough history that H4 has an opinion
    htf = B.HTF(h1, h4)
    t_end = h1.t[-1] + 3600
    r = B.read(htf, t_end)
    assert r["ok"] and r["bias"] == "bullish" and r["regime"] == "trending"
    # not enough history -> neutral, never a guess
    assert B.read(htf, h1.t[5] + 3600)["bias"] == "neutral"
    # the H4 bar that is still forming at t is not used
    j4_forming = htf._idx(htf._h4_close, h4.t[-1] + 100)
    assert htf._h4_close[j4_forming] <= h4.t[-1] + 100


def test_previous_day_and_week_levels_match_an_independent_calendar_calc():
    rows = []
    for d in range(21):
        for k in range(24):
            base = 95 + d
            hi = base + (5 if k == 10 else 1)
            lo = base - (5 if k == 5 else 1)
            rows.append((DAY0 + d * 86400 + k * 3600, base, hi, lo, base))
    h1 = Series(rows)
    htf = B.HTF(h1, Series(wave(UP, [8] * 13, 14400)))
    t = DAY0 + 15 * 86400 + 12 * 3600
    lv = {l["label"]: l["price"] for l in htf.prev_levels(t)}
    assert lv["Previous day high"] == 95 + 14 + 5 and lv["Previous day low"] == 95 + 14 - 5

    def iso(day):
        return dt.datetime.fromtimestamp(DAY0 + day * 86400, dt.timezone.utc).isocalendar()[:2]
    cur = iso(15)
    prev_days = [d for d in range(21) if iso(d) < cur]
    last_week = max(iso(d) for d in prev_days)
    wk = [d for d in prev_days if iso(d) == last_week]
    assert lv["Previous week high"] == max(95 + d + 5 for d in wk) and lv["Previous week low"] == min(95 + d - 5 for d in wk)
