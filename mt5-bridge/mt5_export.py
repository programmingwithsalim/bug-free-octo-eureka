"""Export closed trades from a locally running MetaTrader 5 terminal as JSON.

Uses the terminal's existing login (e.g. your Exness account) - no password is read or stored.
Prints one JSON document to stdout: {"ok": true, "account": {...}, "trades": [...]}.
On failure prints {"ok": false, "error": "..."} and exits with code 1.
"""
import argparse
import json
import sys
from datetime import datetime, timedelta, timezone

DEAL_BUY, DEAL_SELL = 0, 1
ENTRY_IN, ENTRY_OUT, ENTRY_INOUT, ENTRY_OUT_BY = 0, 1, 2, 3
EPS = 1e-9


def _iso(epoch, tz_offset_hours):
    return datetime.fromtimestamp(epoch - tz_offset_hours * 3600, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _vwap(deals):
    vol = sum(d["volume"] for d in deals)
    return sum(d["price"] * d["volume"] for d in deals) / vol if vol else 0.0


def build_trades(deals, sl_tp_by_order=None, tz_offset_hours=0.0):
    """Collapse MT5 deals (dicts) into one trade per fully closed position."""
    sl_tp_by_order = sl_tp_by_order or {}
    by_pos = {}
    for d in deals:
        if d["type"] not in (DEAL_BUY, DEAL_SELL) or not d.get("position_id"):
            continue  # balance / credit / charge rows
        by_pos.setdefault(d["position_id"], []).append(d)

    trades = []
    for pos_id, ds in by_pos.items():
        ds.sort(key=lambda d: (d["time"], d["ticket"]))
        ins = [d for d in ds if d["entry"] == ENTRY_IN]
        outs = [d for d in ds if d["entry"] in (ENTRY_OUT, ENTRY_OUT_BY)]
        if not ins or not outs:
            continue  # still open, or opened before the exported window
        vol_in, vol_out = sum(d["volume"] for d in ins), sum(d["volume"] for d in outs)
        if vol_out < vol_in - EPS:
            continue  # partially closed - wait until fully closed
        side = "long" if ins[0]["type"] == DEAL_BUY else "short"
        gross = sum(d["profit"] for d in ds)
        costs = sum(d["commission"] + d["swap"] + d.get("fee", 0.0) for d in ds)  # negative = cost
        sl, tp = sl_tp_by_order.get(ins[0].get("order"), (0.0, 0.0))
        trades.append({
            "id": f"mt5-{pos_id}",
            "symbol": ins[0]["symbol"],
            "side": side,
            "openTime": _iso(ins[0]["time"], tz_offset_hours),
            "closeTime": _iso(outs[-1]["time"], tz_offset_hours),
            "entry": round(_vwap(ins), 8),
            "exit": round(_vwap(outs), 8),
            "size": round(vol_in, 8),
            "pnl": round(gross + costs, 2),
            "fees": round(-costs if costs < 0 else 0.0, 2),
            "stopLoss": sl or None,
            "takeProfit": tp or None,
            "tags": [],
        })
    trades.sort(key=lambda t: t["closeTime"])
    return trades


def _fail(msg):
    print(json.dumps({"ok": False, "error": msg}))
    sys.exit(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=90, help="how far back to read history")
    ap.add_argument("--path", help="full path to terminal64.exe (only if auto-detect fails)")
    ap.add_argument("--tz-offset", type=float, default=0.0, help="broker server UTC offset in hours (Exness = 0)")
    args = ap.parse_args()

    try:
        import MetaTrader5 as mt5
    except ImportError:
        _fail("Python package 'MetaTrader5' is missing. Run: pip install MetaTrader5")

    ok = mt5.initialize(args.path) if args.path else mt5.initialize()
    if not ok:
        _fail(f"Could not connect to MT5 ({mt5.last_error()}). Open the MetaTrader 5 terminal and log in to your "
              "Exness account (tick 'Save password'), then try again.")
    try:
        acc = mt5.account_info()
        if acc is None:
            _fail("MT5 is open but not logged in to an account.")
        end = datetime.now(timezone.utc) + timedelta(days=2)  # slack for server clock ahead of UTC
        start = end - timedelta(days=args.days)
        raw = mt5.history_deals_get(start, end)
        if raw is None:
            _fail(f"history_deals_get failed: {mt5.last_error()}")
        deals = [d._asdict() for d in raw]

        # Positions opened before the window but closed inside it: fetch their opening deals.
        have_in = {d["position_id"] for d in deals if d["entry"] == ENTRY_IN}
        known = {d["ticket"] for d in deals}
        for pid in {d["position_id"] for d in deals if d["entry"] in (ENTRY_OUT, ENTRY_OUT_BY)} - have_in:
            for d in mt5.history_deals_get(position=pid) or []:
                if d.ticket not in known:
                    deals.append(d._asdict())

        orders = mt5.history_orders_get(start - timedelta(days=30), end) or []
        sl_tp = {o.ticket: (o.sl, o.tp) for o in orders}

        print(json.dumps({
            "ok": True,
            "account": {"login": acc.login, "server": acc.server, "company": acc.company,
                        "currency": acc.currency, "balance": acc.balance, "leverage": acc.leverage},
            # deposits (+) and withdrawals (-) inside the window, so the app can derive the starting balance
            "firstDeposit": next((d["profit"] for d in sorted(deals, key=lambda d: d["time"]) if d["type"] == 2 and d["profit"] > 0), 0.0),
            "netDeposits": round(sum(d["profit"] for d in deals if d["type"] == 2), 2),
            "trades": build_trades(deals, sl_tp, args.tz_offset),
        }))
    finally:
        mt5.shutdown()


if __name__ == "__main__":
    main()
