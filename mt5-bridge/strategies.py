"""Turns raw detector candidates into scored, explainable M15 signals, following a top-down method:

  1. BIAS first: H4 + H1 decide direction and regime (bias.py). Entries are on M15 only.
  2. Trending regime  -> "trend" mode: only setups WITH the bias; targets are the nearest key level in that direction
                         (previous day/week high/low, Asia range, H1 swing pools), the market's usual "draw on liquidity".
  3. Ranging regime   -> "scalp" mode: only fades of the range edge back toward the middle, with small targets.
  4. H4/H1 in conflict -> stand aside (no signal).

Pure + causal: no MT5, no network, closed data only.
"""
from bisect import bisect_right

import bias as BIAS
import patterns as P

TF_SEC = {"M1": 60, "M5": 300, "M15": 900, "M30": 1800, "H1": 3600, "H4": 14400, "D1": 86400}
ENTRY_TF = "M15"
MIN_RR_TREND = 1.2
MIN_RR_SCALP = 1.1
SCALP_SETUPS = {"sweep_reject", "sweep_mss", "double_top", "double_bottom", "news_sweep", "range_scalp"}

SETUPS = {
    "sweep_mss": {"name": "Liquidity sweep + structure shift", "base": 45, "about": "Stops above/below a swing high/low, previous day/week level or Asia range are taken, then price closes back through structure."},
    "sweep_reject": {"name": "Liquidity sweep rejection", "base": 36, "about": "A candle spikes through a liquidity pool and closes back inside with a long wick (earlier, less confirmed than the structure shift)."},
    "news_sweep": {"name": "News sweep & reclaim", "base": 45, "about": "After a high-impact USD release price takes out the pre-news range and closes back inside it."},
    "double_top": {"name": "Double top", "base": 40, "about": "Two equal highs, neckline broken on a closed candle."},
    "double_bottom": {"name": "Double bottom", "base": 40, "about": "Two equal lows, neckline broken on a closed candle."},
    "head_shoulders": {"name": "Head & shoulders", "base": 42, "about": "Head above two similar shoulders, neckline broken on a closed candle."},
    "inverse_head_shoulders": {"name": "Inverse head & shoulders", "base": 42, "about": "Head below two similar shoulders, neckline broken on a closed candle."},
    "trendline_bounce": {"name": "Trendline bounce", "base": 38, "about": "A 3+ touch trendline holds and a confirming candle forms at it."},
    "trendline_break": {"name": "Trendline break", "base": 28, "about": "A 3+ touch trendline is broken by a strong close (momentum, lower base quality)."},
    "range_scalp": {"name": "Range-edge scalp", "base": 38, "about": "While H1 is consolidating: a rejection candle at the top/bottom of the range, targeting the middle."},
    "draw_07": {"name": "Daily plan: draw on liquidity (London open)", "base": 0, "about": "At 07:00 UTC head toward the nearer of the previous day's high/low (it is taken out first ~79% of days)."},
    "draw_12": {"name": "Daily plan: draw on liquidity (New York run-up)", "base": 0, "about": "At 12:00 UTC head toward the nearer of the previous day's high/low."},
}
PLAN_HOURS = (7, 12)
PLAN_MIN_ATR, PLAN_MAX_ATR = 1.0, 12.0
HIGH_IMPACT = ("High",)


class Context:
    """Everything a detector needs beyond the M15 bars. `htf` is a bias.HTF (H1 + H4). All lookups are causal."""

    def __init__(self, s: P.Series, tf=ENTRY_TF, htf: "BIAS.HTF|None" = None, events=None):
        self.s, self.tf, self.tfs, self.htf = s, tf, TF_SEC[tf], htf
        self.events = sorted((e for e in (events or []) if e.get("impact") in HIGH_IMPACT and e.get("country") == "USD"), key=lambda e: e["time"])
        self._ev_times = [e["time"] for e in self.events]
        self.day, self.asia, count = {}, {}, {}
        for i in range(s.n):
            d, hour = s.t[i] // 86400, (s.t[i] % 86400) // 3600
            hi, lo = self.day.get(d, (-1e18, 1e18))
            self.day[d] = (max(hi, s.h[i]), min(lo, s.l[i]))
            count[d] = count.get(d, 0) + 1
            if hour < 7:
                ah, al = self.asia.get(d, (-1e18, 1e18))
                self.asia[d] = (max(ah, s.h[i]), min(al, s.l[i]))
        # only FULL sessions can be a "previous day": Sunday's ~1h open must not become Monday's previous day high/low
        full = 12 * 3600 // self.tfs
        self._days = sorted(d for d in self.day if count[d] >= full)
        self._read = {}

    # ---- levels ------------------------------------------------------------------------------
    def key_levels(self, i):
        """Previous day high/low, the finished Asia range, and (with HTF) the previous week high/low."""
        s = self.s
        d = s.t[i] // 86400
        out = []
        pos = bisect_right(self._days, d - 1)
        if pos:
            hi, lo = self.day[self._days[pos - 1]]
            out += [{"price": hi, "kind": "high", "label": "Previous day high", "i": max(0, i - 1)}, {"price": lo, "kind": "low", "label": "Previous day low", "i": max(0, i - 1)}]
        if d in self.asia and (s.t[i] % 86400) >= 7 * 3600:
            ah, al = self.asia[d]
            out += [{"price": ah, "kind": "high", "label": "Asia high", "i": max(0, i - 1)}, {"price": al, "kind": "low", "label": "Asia low", "i": max(0, i - 1)}]
        if self.htf:
            out += [{**l, "i": max(0, i - 1)} for l in self.htf.prev_levels(s.t[i]) if "week" in l["label"]]
        return out

    def read(self, i):
        """Top-down bias/regime as of the close of bar i (cached)."""
        if i not in self._read:
            t_close = self.s.t[i] + self.tfs
            self._read[i] = BIAS.read(self.htf, t_close) if self.htf else {"bias": "neutral", "strength": "none", "regime": "ranging", "why": "No higher-timeframe data", "h4": None, "h1": None, "ok": False}
        return self._read[i]

    def news_window(self, i, before=15 * 60, after=10 * 60):
        t = self.s.t[i] + self.tfs
        k = bisect_right(self._ev_times, t + before) - 1
        while k >= 0 and self._ev_times[k] >= t - after:
            if self._ev_times[k] - before <= t <= self._ev_times[k] + after:
                return self.events[k]
            k -= 1
        return None

    def targets(self, i, side, entry, n=3):
        """Key levels beyond the entry in the trade direction (nearest first): the market's likely draw on liquidity."""
        a = self.s.atr[i]
        lv = [l for l in self.key_levels(i)]
        if self.htf:
            lv += self.htf.swing_levels(self.s.t[i] + self.tfs, entry)
        want = "high" if side == "buy" else "low"
        beyond = [l for l in lv if l["kind"] == want and ((l["price"] - entry) if side == "buy" else (entry - l["price"])) >= 1.0 * a]
        beyond.sort(key=lambda l: abs(l["price"] - entry))
        seen, out = set(), []
        for l in beyond:
            k = round(l["price"], 1)
            if k not in seen:
                seen.add(k)
                out.append({"price": l["price"], "label": l["label"]})
        return out[:n]


def news_sweep(ctx: Context, i):
    """Fade a sweep of the pre-news range after a high-impact USD release.

    sell: some post-release bar took out the pre-news HIGH; every close since that bar stayed outside the range;
    bar i is the first close back inside. buy is the mirror image on the pre-news LOW.
    """
    s = ctx.s
    a = s.atr[i]
    t_close = s.t[i] + ctx.tfs
    k = bisect_right(ctx._ev_times, t_close) - 1
    if k < 0:
        return []
    ev = ctx.events[k]
    E = ev["time"]
    if not (E < t_close <= E + 60 * 60):
        return []
    pre = [j for j in range(max(0, i - 60), i + 1) if E - 3600 <= s.t[j] < E]
    post = [j for j in range(max(0, i - 40), i + 1) if s.t[j] >= E]
    if len(pre) < 3 or not post:
        return []
    hi, lo = max(s.h[j] for j in pre), min(s.l[j] for j in pre)
    out = []
    for side in ("sell", "buy"):
        if side == "sell":
            level, opp = hi, lo
            sweeps = [j for j in post if s.h[j] > hi + 0.05 * a]
            inside = lambda j: s.c[j] < hi
        else:
            level, opp = lo, hi
            sweeps = [j for j in post if s.l[j] < lo - 0.05 * a]
            inside = lambda j: s.c[j] > lo
        if not sweeps:
            continue
        sw0 = sweeps[0]
        if i - sw0 > 4 or not inside(i) or any(inside(j) for j in range(sw0, i)):
            continue  # reclaim must be THIS bar: no earlier close back inside since the sweep
        extreme = max(s.h[j] for j in post) if side == "sell" else min(s.l[j] for j in post)
        sl = extreme + 0.25 * a if side == "sell" else extreme - 0.25 * a
        entry = s.c[i]
        tp = opp if P._rr(side, entry, sl, opp) >= P.MIN_RR else entry + (2 if side == "buy" else -2) * abs(entry - sl)
        if P._rr(side, entry, sl, tp) >= P.MIN_RR and abs(entry - sl) <= 5 * a:
            out.append({
                "setup": "news_sweep", "side": side, "entry": entry, "sl": sl, "tp": tp,
                "reasons": [f"{ev['title']} released; price swept the pre-news {'high' if side == 'sell' else 'low'} {level:.2f}",
                            "Closed back inside the pre-news range: the spike was a liquidity grab",
                            f"Target: the other side of the range ({opp:.2f})"],
                "points": [{"i": sw0, "price": extreme, "label": "News sweep"}], "level": level, "level_label": "Pre-news range", "event": ev["title"],
            })
    return out


def range_scalp(ctx: Context, i, r):
    """While H1 consolidates: rejection at the edge of the H1 range, aiming for the middle."""
    s = ctx.s
    a = s.atr[i]
    h1 = r.get("h1")
    if not h1 or not h1.get("ok"):
        return []
    hi, lo = h1["hi"], h1["lo"]
    height = hi - lo
    if height < 3 * a:
        return []
    out = []
    for c in P.candle_signals(s, i):
        side = c["side"]
        pos = (s.c[i] - lo) / height
        if side == "sell" and pos >= 0.75 and s.h[i] >= hi - 0.2 * height:
            sl, tp = max(s.h[i], hi) + 0.4 * a, (hi + lo) / 2
        elif side == "buy" and pos <= 0.25 and s.l[i] <= lo + 0.2 * height:
            sl, tp = min(s.l[i], lo) - 0.4 * a, (hi + lo) / 2
        else:
            continue
        entry = s.c[i]
        if P._rr(side, entry, sl, tp) >= MIN_RR_SCALP and abs(entry - sl) <= 3 * a:
            out.append({"setup": "range_scalp", "side": side, "entry": entry, "sl": sl, "tp": tp,
                        "reasons": [f"H1 is consolidating between {lo:.2f} and {hi:.2f}", f"{c['name']} at the {'top' if side == 'sell' else 'bottom'} of the range ({pos * 100:.0f}% of the way up)", f"Scalp target: the middle ({tp:.2f})"],
                        "points": [], "level": hi if side == "sell" else lo, "level_label": "Range edge"})
    return out[:1]


def _hhmm(t):
    return f"{(t % 86400) // 3600:02d}:{(t % 3600) // 60:02d}"


def score(cand, ctx: Context, i, r, mode):
    """Return (score 0-100, [(points, reason)])."""
    s = ctx.s
    a = s.atr[i]
    side = cand["side"]
    parts = [(SETUPS[cand["setup"]]["base"], f"Setup: {SETUPS[cand['setup']]['name']}")]
    # 1. bias / regime
    if mode == "trend":
        parts.append((12, f"With the bias: {r['bias']} (H4 {r['h4']['trend']}, H1 {r['h1']['trend']})") if r["strength"] == "strong" else (6, f"With a weak {r['bias']} bias ({r['why']})"))
    else:
        h1 = r["h1"]
        pos = (cand["entry"] - h1["lo"]) / max(h1["hi"] - h1["lo"], 1e-9)
        parts.append((10, f"Fading the edge of the H1 range ({pos * 100:.0f}% up the range): scalp toward the middle"))
        if r["bias"] != "neutral" and (r["bias"] == "bullish") != (side == "buy"):
            parts.append((-4, f"Against the weak {r['bias']} bias: keep size small"))
    # 2. candlestick confirmation
    confirm = [c for c in P.candle_signals(s, i) if c["side"] == side]
    if confirm and cand["setup"] not in ("trendline_bounce", "range_scalp"):
        parts.append((12, f"Candlestick confirmation: {confirm[0]['name']}"))
    # 3. key level
    lvl = cand.get("level")
    hit = next((x for x in ctx.key_levels(i) if lvl is not None and abs(lvl - x["price"]) <= 0.5 * a), None)
    if hit and cand["setup"] != "range_scalp":
        parts.append((10, f"At a key level: {hit['label']} {hit['price']:.2f}"))
    elif lvl is not None and abs(lvl - round(lvl / 50) * 50) <= 0.3 * a:
        parts.append((5, f"Near the round number {round(lvl / 50) * 50:.0f}"))
    if cand.get("equal"):
        parts.append((5, "Equal highs/lows: a deeper liquidity pool"))
    # 4. target at a key level = draw on liquidity
    if cand.get("target_label"):
        parts.append((6, f"Target is a key level: {cand['target_label']} {cand['tp']:.2f}"))
    rr = P._rr(side, cand["entry"], cand["sl"], cand["tp"])
    if rr >= 3:
        parts.append((12, f"Reward:risk {rr:.1f}"))
    elif rr >= 2:
        parts.append((8, f"Reward:risk {rr:.1f}"))
    hour = ((s.t[i] + ctx.tfs) % 86400) // 3600
    parts.append((5, "London/New York session") if 7 <= hour < 20 else (-5, "Thin session (Asia / late NY)"))
    ev = ctx.news_window(i)
    if ev and cand["setup"] != "news_sweep":
        parts.append((-30, f"News window: {ev['title']} at {_hhmm(ev['time'])} UTC. Spreads widen and moves are erratic"))
    return max(0, min(100, sum(p for p, _ in parts))), parts


def retarget(cand, ctx, i, mode, r):
    """Trend mode: aim at the nearest key level that still pays >= MIN_RR_TREND. Scalp mode: the middle of the range."""
    side, entry, sl = cand["side"], cand["entry"], cand["sl"]
    tg = ctx.targets(i, side, entry)
    cand["targets"] = tg
    if mode == "trend":
        for t in tg:
            if P._rr(side, entry, sl, t["price"]) >= MIN_RR_TREND:
                cand["tp"], cand["target_label"] = t["price"], t["label"]
                return cand
    else:
        mid = (r["h1"]["hi"] + r["h1"]["lo"]) / 2
        if ((mid > entry) == (side == "buy")) and P._rr(side, entry, sl, mid) >= MIN_RR_SCALP:
            cand["tp"], cand["target_label"] = mid, "Range middle"
    return cand


def scan(ctx: Context, i, setups=None):
    """All scored signals completed by the close of bar i (one per setup+side, best score first)."""
    s = ctx.s
    if i < 45 or not s.atr[i]:
        return []
    r = ctx.read(i)
    if not r["ok"]:
        return []
    mode = "scalp" if r["regime"] == "ranging" else "trend"
    if mode == "trend" and r["bias"] == "neutral":
        return []                               # H4 and H1 disagree: stand aside
    piv = s.pivots_at(i, lookback=200)
    extra = ctx.key_levels(i)
    cands = []
    cands += P.double_top_bottom(s, i, piv)
    cands += P.head_shoulders(s, i, piv)
    cands += P.trendline_signals(s, i, piv)
    cands += P.sweep_signals(s, i, piv, extra)
    cands += news_sweep(ctx, i)
    if mode == "scalp":
        cands += range_scalp(ctx, i, r)
    out = {}
    for c in cands:
        if setups is not None and c["setup"] not in setups:
            continue
        side = c["side"]
        if mode == "trend":
            if (r["bias"] == "bullish") != (side == "buy"):
                continue                        # never against the bias
        else:
            if c["setup"] not in SCALP_SETUPS:
                continue                        # no breakouts/continuations while the market is consolidating
            h1 = r["h1"]
            pos = (c["entry"] - h1["lo"]) / max(h1["hi"] - h1["lo"], 1e-9)
            if (side == "sell" and pos < 0.55) or (side == "buy" and pos > 0.45):
                continue                        # only fade FROM the edge, toward the middle
        c = retarget(dict(c), ctx, i, mode, r)
        need = MIN_RR_TREND if mode == "trend" else MIN_RR_SCALP
        if P._rr(side, c["entry"], c["sl"], c["tp"]) < need:
            continue
        total, parts = score(c, ctx, i, r, mode)
        risk = abs(c["entry"] - c["sl"])
        sig = {
            **c, "tf": ctx.tf, "i": i, "time": s.t[i], "close_time": s.t[i] + ctx.tfs, "score": total, "mode": mode,
            "score_parts": [{"points": p, "reason": rs} for p, rs in parts], "rr": round(P._rr(side, c["entry"], c["sl"], c["tp"]), 2),
            "risk": risk, "tp1": c["entry"] + (1 if side == "buy" else -1) * risk, "atr": s.atr[i],
            "name": SETUPS[c["setup"]]["name"] + (" (scalp)" if mode == "scalp" else ""),
            "bias": {"bias": r["bias"], "strength": r["strength"], "regime": r["regime"], "why": r["why"], "h4": r["h4"]["trend"], "h1": r["h1"]["trend"]},
        }
        key = (c["setup"], side)
        if key not in out or sig["score"] > out[key]["score"]:
            out[key] = sig
    return sorted(out.values(), key=lambda x: -x["score"])


def draw_plan(ctx: Context, i):
    """Daily plan (definition fixed in advance, 1:1): at the 07:00 / 12:00 UTC close, trade toward the NEARER of the
    previous day's high/low with the stop one target-distance on the other side. Not filtered by bias: requiring the
    H4/H1 bias to agree removed the edge in testing (this is a liquidity effect, not trend-following)."""
    s = ctx.s
    t_close = s.t[i] + ctx.tfs
    hour, rem = (t_close % 86400) // 3600, (t_close % 86400) % 3600
    if hour not in PLAN_HOURS or rem != 0 or ((t_close // 86400) + 4) % 7 >= 5 or i < 45:
        return None
    lv = {l["label"]: l["price"] for l in ctx.key_levels(i)}
    pdh, pdl = lv.get("Previous day high"), lv.get("Previous day low")
    if pdh is None or pdl is None:
        return None
    px, a = s.c[i], s.atr[i]
    tgt, side = (pdh, "buy") if abs(pdh - px) < abs(pdl - px) else (pdl, "sell")
    dist = abs(tgt - px)
    if not (PLAN_MIN_ATR * a <= dist <= PLAN_MAX_ATR * a):
        return None
    r = ctx.read(i)
    sl = px - dist if side == "buy" else px + dist
    agrees = r["ok"] and r["bias"] != "neutral" and ((r["bias"] == "bullish") == (side == "buy"))
    return {
        "setup": f"draw_{hour:02d}", "side": side, "entry": px, "sl": sl, "tp": tgt, "tf": ctx.tf, "i": i, "time": s.t[i], "close_time": t_close,
        "score": 0, "mode": "trend", "rr": 1.0, "risk": dist, "tp1": px, "atr": a, "kind": "plan", "level": tgt, "level_label": "Previous day high" if side == "buy" else "Previous day low",
        "name": SETUPS[f"draw_{hour:02d}"]["name"], "points": [], "score_parts": [],
        "reasons": [f"Nearer of the previous day's extremes: {'high' if side == 'buy' else 'low'} {tgt:.2f}, {dist:.2f} away ({dist / a:.1f} ATR)",
                    "Gold took out one of the previous day's extremes on ~88% of days over 3 years, the nearer one first ~79% of the time",
                    f"Plan: {'buy' if side == 'buy' else 'sell'} toward {tgt:.2f}, stop {dist:.2f} the other side (1:1). Cancel if price closes beyond the stop first"],
        "bias": {"bias": r["bias"], "strength": r["strength"], "regime": r["regime"], "why": r["why"], "h4": (r["h4"] or {}).get("trend"), "h1": (r["h1"] or {}).get("trend"), "agrees": bool(agrees)},
    }


def snapshot(ctx: Context, i):
    """Plain-language market read for the UI / morning briefing: bias, regime, levels and the likely draw on liquidity."""
    s = ctx.s
    r = ctx.read(i)
    price = s.c[i]
    lv = ctx.key_levels(i)
    day = {l["label"]: l["price"] for l in lv}
    pdh, pdl = day.get("Previous day high"), day.get("Previous day low")
    draw = None
    if pdh is not None and pdl is not None:
        nearer = ("Previous day high", pdh) if abs(pdh - price) < abs(pdl - price) else ("Previous day low", pdl)
        draw = {"label": nearer[0], "price": nearer[1], "distance": round(abs(nearer[1] - price), 2)}
    mode = "scalp" if r["regime"] == "ranging" else "trend"
    action = ("Stand aside: H4 and H1 disagree. Wait for H1 to resume the H4 direction." if (mode == "trend" and r["bias"] == "neutral")
              else f"Only look for {'buys' if r['bias'] == 'bullish' else 'sells'} (trend mode), aiming at the next key level." if mode == "trend"
              else "Range: scalps only. Fade the top of the range or buy the bottom, targeting the middle. No breakout trades.")
    return {"price": price, "time": s.t[i] + ctx.tfs, "bias": r["bias"], "strength": r["strength"], "regime": r["regime"], "mode": mode, "why": r["why"],
            "h4": r.get("h4"), "h1": r.get("h1"), "levels": lv, "draw": draw, "action": action, "atr": s.atr[i]}
