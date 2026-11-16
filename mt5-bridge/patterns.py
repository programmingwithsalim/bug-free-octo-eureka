"""Chart-pattern, candlestick, trendline and liquidity-sweep detectors for gold (pure Python, no MT5).

Strictly causal: every detector evaluated "at bar i" only reads bars <= i (and swing pivots whose fractal window had
fully closed by i), and signals appear only on CLOSED candles, so nothing repaints.

A detector returns candidate dicts:
  {setup, side ("buy"/"sell"), entry, sl, tp, reasons[], points[{i, price, label}], level (key price), height?}
`entry` is the signal bar's close. Scoring/filters (confluence, news, HTF trend) live in strategies.py.
"""
from bisect import bisect_right

FRACTAL_K = 3          # bars on each side that must be lower/higher for a raw pivot
ZZ_ATR = 1.0           # a zigzag swing must move at least this many ATRs from the previous swing
MIN_RR = 1.5           # trendline / sweep setups
MIN_RR_PATTERN = 1.2   # pattern breakouts: the stop sits inside the pattern, so measured-move RR is naturally lower


class Series:
    """OHLC bars as parallel lists (fast) plus an ATR array."""

    def __init__(self, rows, atr_period=14):
        # rows: iterable of (t, o, h, l, c)
        rows = list(rows)
        self.t = [r[0] for r in rows]
        self.o = [float(r[1]) for r in rows]
        self.h = [float(r[2]) for r in rows]
        self.l = [float(r[3]) for r in rows]
        self.c = [float(r[4]) for r in rows]
        self.n = len(rows)
        self.atr = self._atr(atr_period)
        self.raw = self._fractals(FRACTAL_K)
        self._raw_confirm = [p[3] for p in self.raw]

    def _atr(self, n):
        out = [0.0] * self.n
        prev_c, run = None, 0.0
        trs = []
        for i in range(self.n):
            tr = self.h[i] - self.l[i] if prev_c is None else max(self.h[i] - self.l[i], abs(self.h[i] - prev_c), abs(self.l[i] - prev_c))
            trs.append(tr)
            prev_c = self.c[i]
            if i < n:
                run += tr
                out[i] = run / (i + 1)
            else:  # Wilder smoothing
                out[i] = (out[i - 1] * (n - 1) + tr) / n
        return out

    def _fractals(self, k):
        piv = []
        for j in range(k, self.n - k):
            if all(self.h[j] > self.h[j - x] and self.h[j] >= self.h[j + x] for x in range(1, k + 1)):
                piv.append((j, self.h[j], "H", j + k))
            if all(self.l[j] < self.l[j - x] and self.l[j] <= self.l[j + x] for x in range(1, k + 1)):
                piv.append((j, self.l[j], "L", j + k))
        piv.sort(key=lambda p: (p[3], p[0]))
        return piv

    def pivots_at(self, i, lookback=160, atr_mult=ZZ_ATR):
        """Alternating H/L zigzag of pivots confirmed by bar i, within `lookback` bars. Items: (idx, price, 'H'|'L')."""
        hi = bisect_right(self._raw_confirm, i)
        a = self.atr[i] or 1e-9
        out = []
        for idx, price, typ, _c in self.raw[:hi]:
            if idx < i - lookback:
                continue
            if out and out[-1][2] == typ:  # same type twice in a row: keep the more extreme
                if (typ == "H" and price > out[-1][1]) or (typ == "L" and price < out[-1][1]):
                    out[-1] = (idx, price, typ)
                continue
            if out and abs(price - out[-1][1]) < atr_mult * a:  # too small a move to be a real swing
                continue
            out.append((idx, price, typ))
        return out


# ---------------------------------------------------------------------------------------------
# Candlestick confirmations (evaluated on the closed bar i)
# ---------------------------------------------------------------------------------------------
def candle_signals(s: Series, i: int):
    """List of {name, side} candlestick patterns completed at bar i."""
    if i < 2:
        return []
    a = s.atr[i]
    o, h, l, c = s.o[i], s.h[i], s.l[i], s.c[i]
    po, pc = s.o[i - 1], s.c[i - 1]
    body, rng = abs(c - o), h - l
    out = []
    if rng <= 0:
        return out
    upper, lower = h - max(o, c), min(o, c) - l
    # engulfing
    if c > o and pc < po and c >= po and o <= pc and body >= 0.6 * a:
        out.append({"name": "Bullish engulfing", "side": "buy"})
    if c < o and pc > po and c <= po and o >= pc and body >= 0.6 * a:
        out.append({"name": "Bearish engulfing", "side": "sell"})
    # pin bars / hammer / shooting star
    if rng >= 0.8 * a and lower >= 2 * max(body, 0.05 * rng) and upper <= 0.35 * rng and c >= l + 0.6 * rng:
        out.append({"name": "Hammer / bullish pin bar", "side": "buy"})
    if rng >= 0.8 * a and upper >= 2 * max(body, 0.05 * rng) and lower <= 0.35 * rng and c <= h - 0.6 * rng:
        out.append({"name": "Shooting star / bearish pin bar", "side": "sell"})
    # morning / evening star
    o1, c1, o2, c2 = s.o[i - 2], s.c[i - 2], s.o[i - 1], s.c[i - 1]
    b1, b2 = abs(c1 - o1), abs(c2 - o2)
    if c1 < o1 and b1 >= 0.8 * a and b2 <= 0.35 * b1 and c > o and c > (o1 + c1) / 2:
        out.append({"name": "Morning star", "side": "buy"})
    if c1 > o1 and b1 >= 0.8 * a and b2 <= 0.35 * b1 and c < o and c < (o1 + c1) / 2:
        out.append({"name": "Evening star", "side": "sell"})
    return out


def _rr(side, entry, sl, tp):
    risk = abs(entry - sl)
    return abs(tp - entry) / risk if risk > 0 else 0.0


# ---------------------------------------------------------------------------------------------
# Double top / double bottom
# ---------------------------------------------------------------------------------------------
def double_top_bottom(s: Series, i: int, piv=None):
    piv = piv if piv is not None else s.pivots_at(i)
    a = s.atr[i]
    out = []
    for typ, side in (("H", "sell"), ("L", "buy")):
        pts = [p for p in piv if p[2] == typ]
        if len(pts) < 2:
            continue
        p1, p2 = pts[-2], pts[-1]
        mid = [p for p in piv if p1[0] < p[0] < p2[0] and p[2] != typ]
        if not mid:
            continue
        neck = min(p[1] for p in mid) if typ == "H" else max(p[1] for p in mid)
        peak = (p1[1] + p2[1]) / 2
        height = abs(peak - neck)
        spacing = p2[0] - p1[0]
        if abs(p1[1] - p2[1]) > 0.6 * a or height < 1.5 * a or not (6 <= spacing <= 80) or i - p2[0] > 45:
            continue
        # no new extreme beyond the pattern since the second peak
        seg = range(p2[0] + 1, i + 1)
        if typ == "H" and any(s.h[j] > max(p1[1], p2[1]) + 0.3 * a for j in seg):
            continue
        if typ == "L" and any(s.l[j] < min(p1[1], p2[1]) - 0.3 * a for j in seg):
            continue
        brk = s.c[i] < neck - 0.05 * a if typ == "H" else s.c[i] > neck + 0.05 * a
        first = all((s.c[j] >= neck) if typ == "H" else (s.c[j] <= neck) for j in range(p2[0] + 1, i))
        if not (brk and first):
            continue
        entry = s.c[i]
        # stop inside the pattern (halfway to the peaks): a return that far means the break has failed
        sl = (neck + 0.5 * height + 0.25 * a) if typ == "H" else (neck - 0.5 * height - 0.25 * a)
        tp = neck - height if typ == "H" else neck + height
        if _rr(side, entry, sl, tp) < MIN_RR_PATTERN or abs(entry - sl) > 8 * a:
            continue
        name = "Double top" if typ == "H" else "Double bottom"
        out.append({
            "setup": "double_top" if typ == "H" else "double_bottom", "side": side, "entry": entry, "sl": sl, "tp": tp,
            "reasons": [f"{name}: two {'highs' if typ == 'H' else 'lows'} {abs(p1[1] - p2[1]):.2f} apart", f"Neckline {neck:.2f} broken on a closed candle", f"Measured move {height:.2f}"],
            "points": [{"i": p1[0], "price": p1[1], "label": "Peak 1" if typ == "H" else "Low 1"}, {"i": p2[0], "price": p2[1], "label": "Peak 2" if typ == "H" else "Low 2"}],
            "level": neck, "level_label": "Neckline",
        })
    return out


# ---------------------------------------------------------------------------------------------
# Head & shoulders / inverse
# ---------------------------------------------------------------------------------------------
def head_shoulders(s: Series, i: int, piv=None):
    piv = piv if piv is not None else s.pivots_at(i, lookback=220)
    a = s.atr[i]
    out = []
    if len(piv) < 5:
        return out
    for typ, side in (("H", "sell"), ("L", "buy")):
        # need alternating X T X T X ending in the pattern type: ls, t1, head, t2, rs
        seq = piv[-5:] if piv[-1][2] == typ else piv[-6:-1]
        if len(seq) < 5 or seq[0][2] != typ or seq[2][2] != typ or seq[4][2] != typ:
            continue
        ls, t1, hd, t2, rs = seq
        sign = 1 if typ == "H" else -1
        prom_l, prom_r = (hd[1] - ls[1]) * sign, (hd[1] - rs[1]) * sign
        if prom_l < 0.8 * a or prom_r < 0.8 * a:
            continue
        neck_gap = abs(t1[1] - t2[1])
        height = (hd[1] - (t1[1] + t2[1]) / 2) * sign
        if abs(ls[1] - rs[1]) > max(0.9 * a, 0.3 * height) or neck_gap > 0.6 * height or height < 2 * a:
            continue
        if not (4 <= hd[0] - ls[0] <= 70 and 4 <= rs[0] - hd[0] <= 70) or i - rs[0] > 40:
            continue
        slope = (t2[1] - t1[1]) / (t2[0] - t1[0])
        neck_at = lambda j: t1[1] + slope * (j - t1[0])
        brk = s.c[i] < neck_at(i) - 0.05 * a if typ == "H" else s.c[i] > neck_at(i) + 0.05 * a
        first = all((s.c[j] >= neck_at(j)) if typ == "H" else (s.c[j] <= neck_at(j)) for j in range(rs[0] + 1, i))
        if not (brk and first):
            continue
        entry = s.c[i]
        sl = (neck_at(i) + 0.6 * height + 0.25 * a) if typ == "H" else (neck_at(i) - 0.6 * height - 0.25 * a)
        tp = neck_at(i) - height if typ == "H" else neck_at(i) + height
        if _rr(side, entry, sl, tp) < MIN_RR_PATTERN or abs(entry - sl) > 8 * a:
            continue
        name = "Head & shoulders" if typ == "H" else "Inverse head & shoulders"
        out.append({
            "setup": "head_shoulders" if typ == "H" else "inverse_head_shoulders", "side": side, "entry": entry, "sl": sl, "tp": tp,
            "reasons": [f"{name}: head {height:.2f} above the neckline, shoulders within {abs(ls[1] - rs[1]):.2f}", f"Neckline {neck_at(i):.2f} broken on a closed candle", f"Measured move {height:.2f}"],
            "points": [{"i": ls[0], "price": ls[1], "label": "Left shoulder"}, {"i": hd[0], "price": hd[1], "label": "Head"}, {"i": rs[0], "price": rs[1], "label": "Right shoulder"},
                       {"i": t1[0], "price": t1[1], "label": "Neckline"}, {"i": t2[0], "price": t2[1], "label": "Neckline"}],
            "level": neck_at(i), "level_label": "Neckline",
        })
    return out


# ---------------------------------------------------------------------------------------------
# Trendlines (touch/bounce and break)
# ---------------------------------------------------------------------------------------------
def _best_line(s: Series, i: int, piv, typ):
    """Best trendline through pivots of `typ` ('L' => rising support, 'H' => falling resistance)."""
    a = s.atr[i]
    pts = [p for p in piv if p[2] == typ and p[0] <= i - 3]
    pts = pts[-7:]
    best = None
    for x in range(len(pts)):
        for y in range(x + 1, len(pts)):
            p, q = pts[x], pts[y]
            if q[0] - p[0] < 10:
                continue
            slope = (q[1] - p[1]) / (q[0] - p[0])
            if (typ == "L" and slope <= 0) or (typ == "H" and slope >= 0):
                continue
            at = lambda j: p[1] + slope * (j - p[0])
            touches = sum(1 for r in pts if abs(r[1] - at(r[0])) <= 0.3 * a)
            if touches < 3:
                continue
            # the line must be intact: no close through it (by >0.3 ATR) between the first touch and the bar before i
            bad = any((s.c[j] < at(j) - 0.3 * a) if typ == "L" else (s.c[j] > at(j) + 0.3 * a) for j in range(p[0], i))
            if bad:
                continue
            key = (touches, q[0])
            if best is None or key > best[0]:
                best = (key, p, q, slope, at)
    return best


def trendline_signals(s: Series, i: int, piv=None):
    piv = piv if piv is not None else s.pivots_at(i, lookback=200)
    a = s.atr[i]
    out = []
    conf = {c["side"]: c["name"] for c in candle_signals(s, i)}
    for typ, side, name in (("L", "buy", "Rising trendline"), ("H", "sell", "Falling trendline")):
        best = _best_line(s, i, piv, typ)
        if not best:
            continue
        (touches, _), p, q, slope, at = best
        line = at(i)
        if side in conf:  # bounce: touched the line, rejected it, confirmed by a candlestick pattern
            near = (s.l[i] <= line + 0.3 * a and s.c[i] > line) if side == "buy" else (s.h[i] >= line - 0.3 * a and s.c[i] < line)
            if near:
                entry = s.c[i]
                sl = line - 0.6 * a if side == "buy" else line + 0.6 * a
                far = [x[1] for x in piv if x[2] != typ]
                tgt = (max(far) if side == "buy" else min(far)) if far else None
                tp = tgt if tgt is not None and _rr(side, entry, sl, tgt) >= MIN_RR else (entry + 2 * (entry - sl))
                if abs(entry - sl) <= 3 * a and _rr(side, entry, sl, tp) >= MIN_RR:
                    out.append({
                        "setup": "trendline_bounce", "side": side, "entry": entry, "sl": sl, "tp": tp,
                        "reasons": [f"{name} with {touches} touches held at {line:.2f}", f"Confirmed by {conf[side]}"],
                        "points": [{"i": p[0], "price": p[1], "label": "Touch"}, {"i": q[0], "price": q[1], "label": "Touch"}],
                        "level": line, "level_label": "Trendline", "line": {"p": [p[0], p[1]], "slope": slope},
                    })
    # break of the line on a strong close (momentum); the line is considered "intact" only up to bar i-1
    for typ, side, name in (("L", "sell", "Rising trendline"), ("H", "buy", "Falling trendline")):
        sub = _best_line(s, i - 1, s.pivots_at(i - 1, lookback=200), typ) if i > 20 else None
        if not sub:
            continue
        (touches, _), p, q, slope, at = sub
        line, prev_line = at(i), at(i - 1)
        body = abs(s.c[i] - s.o[i])
        broke = (s.c[i] < line - 0.3 * a and s.c[i - 1] >= prev_line) if typ == "L" else (s.c[i] > line + 0.3 * a and s.c[i - 1] <= prev_line)
        if broke and body >= 0.8 * a:
            entry = s.c[i]
            sl = line + 0.5 * a if side == "sell" else line - 0.5 * a
            tp = entry - 2 * (sl - entry) if side == "sell" else entry + 2 * (entry - sl)
            if abs(entry - sl) <= 3 * a:
                out.append({
                    "setup": "trendline_break", "side": side, "entry": entry, "sl": sl, "tp": tp,
                    "reasons": [f"{name} ({touches} touches) broken by a strong close", f"Body {body:.2f} = {body / a:.1f}× ATR"],
                    "points": [{"i": p[0], "price": p[1], "label": "Touch"}, {"i": q[0], "price": q[1], "label": "Touch"}],
                    "level": line, "level_label": "Trendline", "line": {"p": [p[0], p[1]], "slope": slope},
                })
    return out


# ---------------------------------------------------------------------------------------------
# Liquidity sweeps
# ---------------------------------------------------------------------------------------------
def liquidity_levels(s: Series, i: int, piv, extra=None):
    """Price pools where stops rest: confirmed swing highs/lows (equal highs/lows merged), plus extra (PDH/PDL/Asia)."""
    a = s.atr[i]
    lv = []
    for idx, price, typ in piv:
        if idx > i - 3:
            continue
        lv.append({"price": price, "kind": "high" if typ == "H" else "low", "label": "Swing high" if typ == "H" else "Swing low", "i": idx})
    # equal highs/lows: mark and keep the first
    for x in lv:
        x["equal"] = sum(1 for y in lv if y is not x and y["kind"] == x["kind"] and abs(y["price"] - x["price"]) <= 0.3 * a) >= 1
        if x["equal"]:
            x["label"] = "Equal " + ("highs" if x["kind"] == "high" else "lows")
    for e in (extra or []):
        lv.append({**e, "equal": False})
    return lv


def sweep_signals(s: Series, i: int, piv=None, extra=None):
    piv = piv if piv is not None else s.pivots_at(i, lookback=160)
    a = s.atr[i]
    lv = liquidity_levels(s, i, piv, extra)
    out = []
    h, l, c, o = s.h[i], s.l[i], s.c[i], s.o[i]
    rng = h - l
    if rng <= 0:
        return out
    for kind, side in (("high", "sell"), ("low", "buy")):
        pools = [x for x in lv if x["kind"] == kind]
        # --- rejection on the sweep candle itself
        for x in sorted(pools, key=lambda z: (not z["equal"], abs(z["price"] - (h if kind == "high" else l)))):
            P = x["price"]
            took = (h > P + 0.05 * a and c < P) if kind == "high" else (l < P - 0.05 * a and c > P)
            wick = (h - max(o, c)) if kind == "high" else (min(o, c) - l)
            if not took or rng < 0.7 * a or wick < 0.45 * rng:
                continue
            extreme = h if kind == "high" else l
            sl = extreme + 0.25 * a if kind == "high" else extreme - 0.25 * a
            opp = [y["price"] for y in lv if y["kind"] != kind and ((y["price"] < c) if side == "sell" else (y["price"] > c))]
            tgt = (max(opp) if side == "sell" else min(opp)) if opp else None  # nearest opposite pool
            entry = c
            tp = tgt if tgt is not None and _rr(side, entry, sl, tgt) >= MIN_RR else entry + (2 if side == "buy" else -2) * abs(entry - sl)
            if _rr(side, entry, sl, tp) >= MIN_RR and abs(entry - sl) <= 3.5 * a:
                out.append({
                    "setup": "sweep_reject", "side": side, "entry": entry, "sl": sl, "tp": tp,
                    "reasons": [f"Liquidity sweep of {x['label'].lower()} at {P:.2f} (wick to {extreme:.2f})", f"Closed back {'below' if kind == 'high' else 'above'} the level: stops taken, price rejected"],
                    "points": [{"i": x.get("i", i), "price": P, "label": x["label"]}, {"i": i, "price": extreme, "label": "Sweep"}],
                    "level": P, "level_label": x["label"], "equal": x["equal"],
                })
            break  # one rejection signal per side per bar
        # --- sweep followed (within 6 bars) by a structure shift: confirmed reversal
        for sb in range(max(1, i - 6), i):
            for x in pools:
                P = x["price"]
                took = (s.h[sb] > P + 0.05 * a and s.c[sb] < P) if kind == "high" else (s.l[sb] < P - 0.05 * a and s.c[sb] > P)
                if not took:
                    continue
                # structure shift = a decisive close beyond the sweep candle's own far side AND beyond the two bars before it
                before = [j for j in (sb - 2, sb - 1) if j >= 0]
                if kind == "high":
                    gate = min([s.l[sb]] + [s.l[j] for j in before])
                    shift = c < gate and c < o and (o - c) >= 0.5 * a
                    early = any(s.c[j] < gate for j in range(sb + 1, i))
                    extreme = max(s.h[j] for j in range(sb, i + 1))
                    sl = extreme + 0.25 * a
                else:
                    gate = max([s.h[sb]] + [s.h[j] for j in before])
                    shift = c > gate and c > o and (c - o) >= 0.5 * a
                    early = any(s.c[j] > gate for j in range(sb + 1, i))
                    extreme = min(s.l[j] for j in range(sb, i + 1))
                    sl = extreme - 0.25 * a
                if not shift or early:
                    continue  # the shift must happen on THIS bar (first close beyond structure)
                opp = [y["price"] for y in lv if y["kind"] != kind and ((y["price"] < c) if side == "sell" else (y["price"] > c))]
                tgt = (max(opp) if side == "sell" else min(opp)) if opp else None
                entry = c
                tp = tgt if tgt is not None and _rr(side, entry, sl, tgt) >= MIN_RR else entry + (2 if side == "buy" else -2) * abs(entry - sl)
                if _rr(side, entry, sl, tp) >= MIN_RR and abs(entry - sl) <= 3.5 * a:
                    out.append({
                        "setup": "sweep_mss", "side": side, "entry": entry, "sl": sl, "tp": tp,
                        "reasons": [f"Liquidity sweep of {x['label'].lower()} at {P:.2f} {i - sb} bar(s) ago", "Market structure shift: first close beyond the swing that led into the sweep", "Entry after confirmation, not on the wick"],
                        "points": [{"i": x.get("i", sb), "price": P, "label": x["label"]}, {"i": sb, "price": s.h[sb] if kind == "high" else s.l[sb], "label": "Sweep"}],
                        "level": P, "level_label": x["label"], "equal": x["equal"], "confirmed": True,
                    })
                    break
            else:
                continue
            break
    return out
