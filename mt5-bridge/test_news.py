import json
import os
import tempfile

import news as N

RAW = [
    {"title": "CPI m/m", "country": "USD", "date": "2026-11-17T08:30:00-05:00", "impact": "High", "forecast": "0.3%", "previous": "0.2%"},
    {"title": "Retail Sales", "country": "USD", "date": "2026-11-17T10:00:00-05:00", "impact": "Medium"},
    {"title": "ECB Speaks", "country": "EUR", "date": "2026-11-17T09:00:00+01:00", "impact": "High"},
    {"title": "broken", "country": "USD", "date": "not a date", "impact": "High"},
]


def test_parse_converts_to_utc_and_skips_bad_rows():
    ev = N.parse(RAW)
    assert len(ev) == 3 and ev[0]["title"] == "ECB Speaks"            # sorted by UTC time (08:00Z, before 13:30Z)
    cpi = next(e for e in ev if e["title"] == "CPI m/m")
    assert cpi["time"] == 1_794_000_000 - 1_794_000_000 % 1 + (cpi["time"] - 1_794_000_000) and cpi["impact"] == "High"
    from datetime import datetime, timezone
    assert datetime.fromtimestamp(cpi["time"], timezone.utc).strftime("%Y-%m-%d %H:%M") == "2026-11-17 13:30"   # 08:30 EST = 13:30 UTC


def test_load_uses_a_fresh_cache_then_refreshes_then_falls_back():
    d = tempfile.mkdtemp()
    p = os.path.join(d, "news.json")
    calls = []
    ok = lambda: (calls.append(1), N.parse(RAW))[1]
    r = N.load(p, now=1000.0, fetcher=ok)
    assert r["ok"] and r["note"] == "fresh" and len(calls) == 1
    assert N.load(p, now=1000.0 + 60, fetcher=ok)["note"] == "cached" and len(calls) == 1           # within an hour: no refetch
    down = lambda: None
    stale = N.load(p, now=1000.0 + 2 * 3600, fetcher=down)
    assert stale["ok"] and "stale" in stale["note"]                                                 # network down: use the cache
    gone = N.load(p, now=1000.0 + 20 * 86400, fetcher=down)
    assert not gone["ok"] and gone["events"] == [] and "unavailable" in gone["note"]                 # too old: say so, don't guess
    assert not N.load(os.path.join(d, "none.json"), now=1.0, fetcher=down)["ok"]


def test_fetch_survives_one_dead_feed_and_total_failure():
    class R:
        def __init__(self, b): self.b = b
        def read(self): return self.b
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def one_good(req, timeout=0):
        if "nextweek" in req.full_url:
            raise OSError("404")
        return R(json.dumps(RAW).encode())
    assert len(N.fetch(one_good)) == 3
    def dead(req, timeout=0):
        raise OSError("offline")
    assert N.fetch(dead) is None


def test_upcoming_filters_to_high_impact_usd_in_the_window():
    ev = N.parse(RAW)
    now = next(e for e in ev if e["title"] == "CPI m/m")["time"] - 3600
    up = N.upcoming(ev, now)
    assert [e["title"] for e in up] == ["CPI m/m"]
    assert N.upcoming(ev, now + 20 * 3600) == []
