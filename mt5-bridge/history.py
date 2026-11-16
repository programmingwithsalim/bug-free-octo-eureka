"""Candle history from MT5 with an incremental local cache (data/history/<symbol>_<tf>.json).

Rows are [time, open, high, low, close] with time = bar OPEN (epoch s, broker time = UTC on Exness).
`closed_only` drops the still-forming last bar so detectors only ever see closed candles.
"""
import json
import os
import time
from datetime import datetime, timedelta, timezone

TF_SEC = {"M5": 300, "M15": 900, "H1": 3600, "H4": 14400, "D1": 86400}


def _path(data_dir, symbol, tf):
    return os.path.join(data_dir, "history", f"{symbol}_{tf}.json")


def _read(path):
    try:
        with open(path, encoding="utf8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return []


def _write(path, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf8") as f:
        json.dump(rows, f)
    os.replace(tmp, path)


def fetch_range(mt5, symbol, tf, t0, t1):
    mt5.symbol_select(symbol, True)
    r = mt5.copy_rates_range(symbol, getattr(mt5, "TIMEFRAME_" + tf), datetime.fromtimestamp(t0, tz=timezone.utc), datetime.fromtimestamp(t1, tz=timezone.utc))
    return [[int(x["time"]), float(x["open"]), float(x["high"]), float(x["low"]), float(x["close"])] for x in r] if r is not None else []


def merge(old, new):
    by = {r[0]: r for r in old}
    by.update({r[0]: r for r in new})
    return [by[k] for k in sorted(by)]


def get_rows(mt5, data_dir, symbol, tf, days, now=None, closed_only=True):
    """Cached + incrementally refreshed candles for the last `days` days."""
    now = now if now is not None else time.time()
    path = _path(data_dir, symbol, tf)
    rows = _read(path)
    start = now - days * 86400
    # refetch from a few bars before the newest cached bar (the last cached bar may have been unfinished)
    t0 = start if not rows else max(start, rows[-1][0] - 5 * TF_SEC[tf])
    if not rows or rows[0][0] > start + 7 * 86400:
        t0 = start                                         # cache doesn't reach back far enough: refill
    fresh = fetch_range(mt5, symbol, tf, int(t0), int(now) + 3600)
    if fresh:
        rows = merge(rows, fresh)
        _write(path, rows)
    rows = [r for r in rows if r[0] >= start]
    if closed_only:
        rows = [r for r in rows if r[0] + TF_SEC[tf] <= now]
    return rows
