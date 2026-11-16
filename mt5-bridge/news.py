"""Economic calendar (high-impact USD events move gold). Fetched hourly, cached on disk, never fatal.

Source: the public weekly JSON feed used by the ForexFactory calendar. If it is unreachable the cache is used
(for up to 8 days); with no cache the service simply runs without news awareness and says so.
"""
import json
import os
import time
import urllib.request
from datetime import datetime, timezone

URLS = ("https://nfs.faireconomy.media/ff_calendar_thisweek.json", "https://nfs.faireconomy.media/ff_calendar_nextweek.json")
REFRESH = 3600
MAX_STALE = 8 * 86400


def parse(raw):
    """Feed items -> [{time (epoch UTC), title, country, impact, forecast, previous}]."""
    out = []
    for e in raw or []:
        try:
            t = int(datetime.fromisoformat(e["date"]).astimezone(timezone.utc).timestamp())
        except (KeyError, ValueError, TypeError):
            continue
        out.append({"time": t, "title": e.get("title", "?"), "country": e.get("country", ""), "impact": e.get("impact", ""),
                    "forecast": e.get("forecast", ""), "previous": e.get("previous", "")})
    return sorted(out, key=lambda x: x["time"])


def fetch(urlopen=urllib.request.urlopen):
    events, got = [], 0
    for url in URLS:
        try:
            with urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=15) as r:
                events += parse(json.loads(r.read()))
                got += 1
        except Exception:
            continue  # next week's feed is often not published yet; one good feed is enough
    return events if got else None


def load(path, now=None, fetcher=fetch):
    """-> {"ok": bool, "events": [...], "fetched_at": epoch|None, "note": str}. Refreshes the cache when it is older than REFRESH."""
    now = now if now is not None else time.time()
    cache = {}
    try:
        with open(path, encoding="utf8") as f:
            cache = json.load(f)
    except (OSError, ValueError):
        pass
    if cache.get("events") and now - cache.get("fetched_at", 0) < REFRESH:
        return {"ok": True, "events": cache["events"], "fetched_at": cache["fetched_at"], "note": "cached"}
    fresh = fetcher()
    if fresh:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf8") as f:
            json.dump({"events": fresh, "fetched_at": now}, f)
        os.replace(tmp, path)
        return {"ok": True, "events": fresh, "fetched_at": now, "note": "fresh"}
    if cache.get("events") and now - cache.get("fetched_at", 0) < MAX_STALE:
        return {"ok": True, "events": cache["events"], "fetched_at": cache["fetched_at"], "note": "stale cache (calendar unreachable)"}
    return {"ok": False, "events": [], "fetched_at": None, "note": "Economic calendar unavailable: news awareness is off"}


def upcoming(events, now, hours=36, impacts=("High",), country="USD"):
    return [e for e in events if e["impact"] in impacts and e["country"] == country and now - 30 * 60 <= e["time"] <= now + hours * 3600]
