"""Backtest the signal engine on real MT5 history and write data/backtest.json.

python mt5-bridge/run_backtest.py --data-dir data [--symbol XAUUSDm] [--days 400] [--limit 3000]
"""
import argparse
import json
import os
import statistics
import sys
import time

import backtest as BT
import bias as BIAS
import history as H
import patterns as P
import strategies as S


def liquidity_stats(h1_rows):
    """How often did a day take out the previous day's high/low, and which side first? (the 'draw on liquidity' claim)"""
    days = {}
    for r in h1_rows:
        days.setdefault(r[0] // 86400, []).append(r)
    keys = [d for d in sorted(days) if len(days[d]) >= 12 and (d + 4) % 7 < 5]
    rows = []
    for a, b in zip(keys, keys[1:]):
        pdh, pdl = max(x[2] for x in days[a]), min(x[3] for x in days[a])
        cur, op = days[b], days[b][0][1]
        first = None
        for x in cur:
            up, dn = x[2] > pdh, x[3] < pdl
            if up or dn:
                first = "PDH" if up and not dn else "PDL" if dn and not up else "both"
                break
        rows.append((max(x[2] for x in cur) > pdh, min(x[3] for x in cur) < pdl, first, "PDH" if abs(op - pdh) < abs(op - pdl) else "PDL"))
    n = len(rows)
    if not n:
        return {}
    one_side = [r for r in rows if r[2] in ("PDH", "PDL")]
    return {"days": n, "took_pdh_or_pdl": sum(1 for u, d, *_ in rows if u or d) / n, "took_both": sum(1 for u, d, *_ in rows if u and d) / n,
            "stayed_inside": sum(1 for u, d, *_ in rows if not (u or d)) / n,
            "nearer_side_first": (sum(1 for r in one_side if r[2] == r[3]) / len(one_side)) if one_side else 0.0}


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default="data")
    ap.add_argument("--symbol", default="XAUUSDm")
    ap.add_argument("--days", type=int, default=400)
    ap.add_argument("--limit", type=int, default=0, help="only the last N M15 bars (quick timing runs)")
    a = ap.parse_args()
    import MetaTrader5 as mt5
    if not mt5.initialize():
        print(json.dumps({"ok": False, "error": f"Cannot connect to MT5 ({mt5.last_error()})"}))
        sys.exit(1)
    try:
        now = time.time()
        m15 = H.get_rows(mt5, a.data_dir, a.symbol, "M15", a.days, now)
        h1 = H.get_rows(mt5, a.data_dir, a.symbol, "H1", a.days + 120, now)
        h4 = H.get_rows(mt5, a.data_dir, a.symbol, "H4", a.days + 300, now)
    finally:
        mt5.shutdown()
    if a.limit:
        m15 = m15[-a.limit:]
    s = P.Series(m15)
    htf = BIAS.HTF(P.Series(h1), P.Series(h4))
    ctx = S.Context(s, "M15", htf=htf)
    t0 = time.time()
    trades = BT.run(s, ctx, progress=lambda i, n: print(f"  bar {i}/{n}  {time.time() - t0:.0f}s", flush=True))
    trades += BT.run_plans(s, ctx)
    trades.sort(key=lambda t: t["t"])
    rep = BT.report(trades)
    # how much of the time was each regime? (sanity: neither 0% nor 100% ranging)
    regimes = {"trending": 0, "ranging": 0, "stand_aside": 0}
    for i in range(BT.WARMUP, s.n, 4):
        r = ctx.read(i)
        if not r["ok"]:
            continue
        regimes["stand_aside" if (r["regime"] == "trending" and r["bias"] == "neutral") else r["regime"]] += 1
    tot = sum(regimes.values()) or 1
    out = {"ok": True, "symbol": a.symbol, "generated": int(now), "spread": BT.SPREAD, "bars": s.n, "from": s.t[BT.WARMUP], "to": s.t[-1],
           "seconds": round(time.time() - t0, 1), "regime_share": {k: v / tot for k, v in regimes.items()}, "liquidity": liquidity_stats(h1), "report": rep,
           "note": "News-based setups cannot be backtested (no historical economic calendar) and are excluded."}
    os.makedirs(a.data_dir, exist_ok=True)
    with open(os.path.join(a.data_dir, "backtest.json"), "w", encoding="utf8") as f:
        json.dump(out, f)
    with open(os.path.join(a.data_dir, "backtest_trades.json"), "w", encoding="utf8") as f:
        json.dump(trades, f)
    print(json.dumps({"ok": True, "trades": rep["n_trades"], "seconds": out["seconds"]}))
    ov = rep["overall"]
    print(f"\n{a.symbol} M15 {s.n} bars | regimes: " + ", ".join(f"{k} {v * 100:.0f}%" for k, v in out["regime_share"].items()))
    print(f"overall: n={ov['n']} win={ov['win'] * 100:.0f}% avgR={ov['avg_r']:+.2f} PF={ov['pf']:.2f} | OOS: n={rep['overall_oos']['n']} avgR={rep['overall_oos']['avg_r']:+.2f}")
    for r in rep["setups"]:
        t, o = r["total"], r["out_of_sample"]
        print(f"  {r['setup']:<24} n={t['n']:>4} win={t['win'] * 100:>3.0f}% avgR={t['avg_r']:+.2f} PF={t['pf']:>5.2f} | OOS n={o['n']:>3} avgR={o['avg_r']:+.2f} | {'PASS' if r['passes'] else 'no: ' + '; '.join(r['why_not'][:2])}")


if __name__ == "__main__":
    main()
