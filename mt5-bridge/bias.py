"""Top-down market bias: H4 + H1 decide direction and regime BEFORE any M15 entry is considered. Pure + causal.

Per timeframe (computed on the last CLOSED bar):
  structure  - higher highs/higher lows ("up"), lower highs/lower lows ("down") or "mixed", from ATR-filtered swing pivots
  ema        - price vs EMA50 and its slope
  er         - Kaufman efficiency ratio over 20 bars (net move / total path): low = chop
  trend      - "up" | "down" | "range"
Combined:
  bias       - "bullish" | "bearish" | "neutral"   (H4 leads, H1 refines)
  regime     - "trending" | "ranging"              (from H1: are we consolidating?)
"""
from bisect import bisect_right

ER_N = 20
ER_RANGE = 0.20
SLOPE_MIN = 0.15          # EMA slope (ATR per 5 bars) that counts as directional


def ema_array(s, n=50):
    cached = getattr(s, "_ema_%d" % n, None)
    if cached is not None:
        return cached
    k, e, out = 2 / (n + 1), None, []
    for c in s.c:
        e = c if e is None else e + k * (c - e)
        out.append(e)
    setattr(s, "_ema_%d" % n, out)
    return out


def efficiency(s, j, n=ER_N):
    if j < n:
        return 0.0
    path = sum(abs(s.c[k] - s.c[k - 1]) for k in range(j - n + 1, j + 1))
    return abs(s.c[j] - s.c[j - n]) / path if path else 0.0


def structure(piv):
    hs = [p for p in piv if p[2] == "H"][-2:]
    ls = [p for p in piv if p[2] == "L"][-2:]
    if len(hs) == 2 and len(ls) == 2:
        if hs[1][1] > hs[0][1] and ls[1][1] > ls[0][1]:
            return "up"
        if hs[1][1] < hs[0][1] and ls[1][1] < ls[0][1]:
            return "down"
    return "mixed"


def tf_state(s, j, range_bars=24):
    """State of one timeframe as of closed bar j."""
    if j < 30:
        return {"trend": "range", "structure": "mixed", "ema": "flat", "er": 0.0, "hi": s.h[max(j, 0)], "lo": s.l[max(j, 0)], "close": s.c[max(j, 0)], "ok": False}
    a = s.atr[j] or 1e-9
    em = ema_array(s)
    slope = (em[j] - em[j - 5]) / a
    ema_t = "up" if (s.c[j] > em[j] and slope > SLOPE_MIN) else "down" if (s.c[j] < em[j] and slope < -SLOPE_MIN) else "flat"
    st = structure(s.pivots_at(j, lookback=140))
    er = efficiency(s, j)
    if er < ER_RANGE:
        trend = "range"
    elif st == "up" and ema_t != "down":
        trend = "up"
    elif st == "down" and ema_t != "up":
        trend = "down"
    elif st == "mixed" and er > 0.35 and ema_t != "flat":
        trend = ema_t
    else:
        trend = "range"
    lo_i = max(0, j - range_bars + 1)
    return {"trend": trend, "structure": st, "ema": ema_t, "er": round(er, 3), "hi": max(s.h[lo_i:j + 1]), "lo": min(s.l[lo_i:j + 1]), "close": s.c[j], "ok": True}


def combine(h4, h1):
    """-> (bias, strength, regime, why)"""
    t4, t1 = h4["trend"], h1["trend"]
    regime = "ranging" if t1 == "range" else "trending"
    if t4 == "up" and t1 == "up":
        return "bullish", "strong", regime, "H4 and H1 both trending up (higher highs/lows, price above a rising EMA50)"
    if t4 == "down" and t1 == "down":
        return "bearish", "strong", regime, "H4 and H1 both trending down (lower highs/lows, price below a falling EMA50)"
    if t4 == "up" and t1 == "range":
        return "bullish", "weak", regime, "H4 uptrend, H1 consolidating"
    if t4 == "down" and t1 == "range":
        return "bearish", "weak", regime, "H4 downtrend, H1 consolidating"
    if t4 == "range" and t1 == "up":
        return "bullish", "weak", regime, "H1 trending up inside an H4 range"
    if t4 == "range" and t1 == "down":
        return "bearish", "weak", regime, "H1 trending down inside an H4 range"
    if t4 == "up" and t1 == "down":
        return "neutral", "none", regime, "Conflict: H1 pulling back against an H4 uptrend. Wait for H1 to turn back up"
    if t4 == "down" and t1 == "up":
        return "neutral", "none", regime, "Conflict: H1 bouncing against an H4 downtrend. Wait for H1 to turn back down"
    return "neutral", "none", "ranging", "H4 and H1 both ranging"


class HTF:
    """H1 + H4 series with cached per-bar states and previous day/week levels; all lookups use closed bars only."""

    def __init__(self, h1_series, h4_series):
        self.h1, self.h4 = h1_series, h4_series
        self._h1_close = [t + 3600 for t in h1_series.t] if h1_series else []
        self._h4_close = [t + 14400 for t in h4_series.t] if h4_series else []
        self._c1, self._c4 = {}, {}
        self._days, self._weeks = {}, {}
        if h1_series:
            for k in range(h1_series.n):
                d = h1_series.t[k] // 86400
                w = (d + 3) // 7                       # Monday-based week id (1970-01-01 was a Thursday)
                for table, key in ((self._days, d), (self._weeks, w)):
                    hi, lo = table.get(key, (-1e18, 1e18))
                    table[key] = (max(hi, h1_series.h[k]), min(lo, h1_series.l[k]))

    def _idx(self, closes, t):
        return bisect_right(closes, t) - 1

    def state(self, t_close):
        """(h4_state, h1_state) as of time t_close."""
        j1, j4 = self._idx(self._h1_close, t_close), self._idx(self._h4_close, t_close)
        if j1 < 0 or j4 < 0:
            return None, None
        if j1 not in self._c1:
            self._c1[j1] = tf_state(self.h1, j1)
        if j4 not in self._c4:
            self._c4[j4] = tf_state(self.h4, j4)
        return self._c4[j4], self._c1[j1]

    def prev_levels(self, t):
        """Previous completed UTC day high/low and previous completed week high/low as of time t."""
        d = t // 86400
        w = (d + 3) // 7
        out = []
        pd = max((k for k in self._days if k < d), default=None)
        if pd is not None:
            out += [{"price": self._days[pd][0], "kind": "high", "label": "Previous day high"}, {"price": self._days[pd][1], "kind": "low", "label": "Previous day low"}]
        pw = max((k for k in self._weeks if k < w), default=None)
        if pw is not None:
            out += [{"price": self._weeks[pw][0], "kind": "high", "label": "Previous week high"}, {"price": self._weeks[pw][1], "kind": "low", "label": "Previous week low"}]
        return out

    def swing_levels(self, t_close, price):
        """Recent H1 swing highs/lows (liquidity pools) as of t_close."""
        j1 = self._idx(self._h1_close, t_close)
        if j1 < 30:
            return []
        return [{"price": p[1], "kind": "high" if p[2] == "H" else "low", "label": "H1 swing " + ("high" if p[2] == "H" else "low")}
                for p in self.h1.pivots_at(j1, lookback=120)]


def read(htf: HTF, t_close):
    """Full top-down read at time t_close."""
    h4, h1 = htf.state(t_close)
    if not h4 or not h1 or not h4["ok"] or not h1["ok"]:
        return {"bias": "neutral", "strength": "none", "regime": "ranging", "why": "Not enough higher-timeframe history", "h4": h4, "h1": h1, "ok": False}
    bias, strength, regime, why = combine(h4, h1)
    return {"bias": bias, "strength": strength, "regime": regime, "why": why, "h4": h4, "h1": h1, "ok": True}
