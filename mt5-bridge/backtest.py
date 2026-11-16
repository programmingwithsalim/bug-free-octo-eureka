"""Honest backtester for the signal engine.

Uses the SAME scan() as the live service (bias first, then M15 setups). Rules:
  * the alert fires when a candle CLOSES; the trade is entered at the NEXT candle's open (when you could act on it)
  * spread is paid (default $0.25 per round trip); if a candle touches both stop and target, the stop is assumed first
  * a trade that gaps past its stop or target at the entry is skipped (not filled at a price you couldn't get)
  * one trade at a time per setup+side; max hold 24h (trend) / 8h (scalp), then exit at the close
  * results are split chronologically: first 70% = in-sample, last 30% = out-of-sample (never tuned on)
News-based setups cannot be backtested (no historical calendar), so they are excluded and flagged.
"""
import math

import bias as BIAS
import patterns as P
import strategies as S

SPREAD = 0.25
MAX_HOLD = {"trend": 96, "scalp": 32}
WARMUP = 320
NEWS_ONLY = {"news_sweep"}


def simulate(s, sig, spread=SPREAD):
    """Trade one signal on the bars after its close. Returns dict or None when it could not be filled."""
    i = sig["i"]
    if i + 1 >= s.n:
        return None
    side = sig["side"]
    d = 1 if side == "buy" else -1
    entry = s.o[i + 1]
    sl, tp = sig["sl"], sig["tp"]
    risk = (entry - sl) * d
    if risk <= 0.1 * s.atr[i] or (tp - entry) * d <= 0:
        return None                                   # already beyond stop/target at the open: not a fill you could get
    end = min(s.n - 1, i + MAX_HOLD[sig["mode"]])
    exit_px, why, j_exit = s.c[end], "time", end
    for j in range(i + 1, end + 1):
        hit_sl = (s.l[j] <= sl) if d > 0 else (s.h[j] >= sl)
        hit_tp = (s.h[j] >= tp) if d > 0 else (s.l[j] <= tp)
        if hit_sl:                                    # stop first when both are touched in one candle
            exit_px, why, j_exit = sl, "stop", j
            break
        if hit_tp:
            exit_px, why, j_exit = tp, "target", j
            break
    r = ((exit_px - entry) * d - spread) / risk
    return {"i": i, "t": s.t[i], "setup": sig["setup"], "side": side, "mode": sig["mode"], "score": sig["score"], "r": r,
            "why": why, "bars": j_exit - i, "rr_plan": sig["rr"], "bias": sig["bias"]["bias"], "entry": entry}


def run(s: P.Series, ctx: S.Context, setups=None, progress=None, spread=SPREAD):
    """Scan every bar; returns the list of simulated trades."""
    trades, busy_until = [], {}
    for i in range(WARMUP, s.n - 1):
        if progress and i % 2000 == 0:
            progress(i, s.n)
        for sig in S.scan(ctx, i, setups):
            if sig["setup"] in NEWS_ONLY:
                continue
            key = (sig["setup"], sig["side"])
            if busy_until.get(key, -1) >= i:
                continue
            t = simulate(s, sig, spread)
            if t:
                trades.append(t)
                busy_until[key] = i + t["bars"]
    return trades


def run_plans(s: P.Series, ctx: S.Context, spread=SPREAD):
    """The two daily draw-on-liquidity plans (one trade per day per plan)."""
    out = []
    for i in range(WARMUP, s.n - 1):
        sig = S.draw_plan(ctx, i)
        if sig:
            t = simulate(s, sig, spread)
            if t:
                out.append(t)
    return out


def stats(trades):
    n = len(trades)
    if not n:
        return {"n": 0, "win": 0.0, "avg_r": 0.0, "pf": 0.0, "max_dd": 0.0, "total_r": 0.0, "t": 0.0}
    rs = [t["r"] for t in trades]
    wins = [r for r in rs if r > 0]
    losses = [-r for r in rs if r <= 0]
    avg = sum(rs) / n
    sd = math.sqrt(sum((r - avg) ** 2 for r in rs) / (n - 1)) if n > 1 else 0.0
    peak = dd = cum = 0.0
    for r in rs:
        cum += r
        peak = max(peak, cum)
        dd = max(dd, peak - cum)
    return {"n": n, "win": len(wins) / n, "avg_r": avg, "pf": (sum(wins) / sum(losses)) if losses and sum(losses) > 0 else (999.0 if wins else 0.0),
            "max_dd": dd, "total_r": sum(rs), "t": (avg / (sd / math.sqrt(n))) if sd > 0 else 0.0}


def split(trades, frac=0.7):
    """Chronological in-sample / out-of-sample split over the whole test period (not per setup)."""
    if not trades:
        return [], []
    ts = sorted(t["t"] for t in trades)
    cut = ts[int(len(ts) * frac)] if len(ts) > 1 else ts[0]
    return [t for t in trades if t["t"] < cut], [t for t in trades if t["t"] >= cut]


GATE = {"min_n": 30, "min_oos_n": 12, "min_avg_r": 0.10, "min_oos_avg_r": 0.0, "min_pf": 1.15}


def passes(total, oos):
    why = []
    if total["n"] < GATE["min_n"]:
        why.append(f"only {total['n']} trades (need {GATE['min_n']}+)")
    if oos["n"] < GATE["min_oos_n"]:
        why.append(f"only {oos['n']} out-of-sample trades (need {GATE['min_oos_n']}+)")
    if total["avg_r"] < GATE["min_avg_r"]:
        why.append(f"average {total['avg_r']:+.2f}R (need >= {GATE['min_avg_r']:+.2f}R)")
    if oos["n"] and oos["avg_r"] <= GATE["min_oos_avg_r"]:
        why.append(f"out-of-sample average {oos['avg_r']:+.2f}R (must be positive)")
    if total["pf"] < GATE["min_pf"]:
        why.append(f"profit factor {total['pf']:.2f} (need >= {GATE['min_pf']})")
    return (not why), why


def report(trades):
    """Per-setup and overall statistics with the quality gate applied."""
    ins, oos = split(trades)
    in_ids, oos_ids = {id(t) for t in ins}, {id(t) for t in oos}
    setups = sorted({t["setup"] for t in trades})
    rows = []
    for name in setups:
        mine = [t for t in trades if t["setup"] == name]
        tot = stats(mine)
        i_s, o_s = stats([t for t in mine if id(t) in in_ids]), stats([t for t in mine if id(t) in oos_ids])
        ok, why = passes(tot, o_s)
        hi = stats([t for t in mine if t["score"] >= 70])
        rows.append({"setup": name, "name": S.SETUPS[name]["name"], "total": tot, "in_sample": i_s, "out_of_sample": o_s, "score70": hi,
                     "scalp": stats([t for t in mine if t["mode"] == "scalp"]), "trend": stats([t for t in mine if t["mode"] == "trend"]),
                     "passes": ok, "why_not": why})
    return {"gate": GATE, "setups": rows, "overall": stats(trades), "overall_oos": stats(oos), "n_trades": len(trades)}
