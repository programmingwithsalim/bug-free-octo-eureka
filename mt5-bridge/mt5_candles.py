"""Export OHLC candles for one symbol/time window from the running MT5 terminal as JSON (read-only).

python mt5_candles.py --symbol XAUUSDm --from 1789376400 --to 1789390000 --tf M5
Prints {"ok": true, "candles": [[time, open, high, low, close], ...]} or {"ok": false, "error": "..."}.
Times are epoch seconds in broker/server time, which is UTC on Exness (same assumption as mt5_export.py).
"""
import argparse
import json
import sys
from datetime import datetime, timezone

TIMEFRAMES = ("M1", "M5", "M15", "M30", "H1", "H4", "D1")


def rates_to_rows(rates):
    """numpy structured array / list of mappings -> compact [[t, o, h, l, c], ...] sorted by time."""
    rows = [[int(r["time"]), float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"])] for r in rates]
    rows.sort(key=lambda r: r[0])
    return rows


def _fail(msg):
    print(json.dumps({"ok": False, "error": msg}))
    sys.exit(1)


def fetch(mt5, symbol, t0, t1, tf_name):
    """Candles for one window as rows, or None when MT5 has nothing."""
    mt5.symbol_select(symbol, True)  # make sure the symbol is in Market Watch so history can load
    rates = mt5.copy_rates_range(symbol, getattr(mt5, "TIMEFRAME_" + tf_name), datetime.fromtimestamp(t0, tz=timezone.utc), datetime.fromtimestamp(t1, tz=timezone.utc))
    return rates_to_rows(rates) if rates is not None and len(rates) else None


def batch_main():
    """--batch: read [{"symbol":..,"from":..,"to":..}, ...] from stdin, answer {"ok":true,"results":[rows|null, ...]} (M1)."""
    try:
        windows = json.load(sys.stdin)
        import MetaTrader5 as mt5
    except ImportError:
        _fail("Python package 'MetaTrader5' is missing. Run: pip install MetaTrader5")
    except ValueError:
        _fail("Bad batch input")
    if not mt5.initialize():
        _fail(f"Could not connect to MT5 ({mt5.last_error()}). Open the MetaTrader 5 terminal and log in.")
    try:
        print(json.dumps({"ok": True, "results": [fetch(mt5, w["symbol"], int(w["from"]), int(w["to"]), "M1") for w in windows]}))
    finally:
        mt5.shutdown()


def main():
    if "--batch" in sys.argv:
        return batch_main()
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol", required=True)
    ap.add_argument("--from", dest="t0", type=int, required=True)
    ap.add_argument("--to", dest="t1", type=int, required=True)
    ap.add_argument("--tf", default="M5", choices=TIMEFRAMES)
    a = ap.parse_args()

    try:
        import MetaTrader5 as mt5
    except ImportError:
        _fail("Python package 'MetaTrader5' is missing. Run: pip install MetaTrader5")
    if not mt5.initialize():
        _fail(f"Could not connect to MT5 ({mt5.last_error()}). Open the MetaTrader 5 terminal and log in.")
    try:
        mt5.symbol_select(a.symbol, True)  # make sure the symbol is in Market Watch so history can load
        tf = getattr(mt5, "TIMEFRAME_" + a.tf)
        rates = mt5.copy_rates_range(a.symbol, tf, datetime.fromtimestamp(a.t0, tz=timezone.utc), datetime.fromtimestamp(a.t1, tz=timezone.utc))
        if rates is None or len(rates) == 0:
            _fail(f"MT5 has no {a.tf} candles for {a.symbol} in that window ({mt5.last_error()}).")
        print(json.dumps({"ok": True, "candles": rates_to_rows(rates)}))
    finally:
        mt5.shutdown()


if __name__ == "__main__":
    main()
