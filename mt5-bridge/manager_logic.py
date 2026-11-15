"""Pure rule engine for the trade manager (no MetaTrader import - fully unit-testable).

The manager NEVER opens trades. It can only:
  * modify SL/TP of an existing position (stops are only ever tightened, never widened),
  * close PART of an existing position (partial take-profit) or all of it (daily-loss flatten).
Every request it builds is tied to an existing position ticket.
"""
import copy
import math

POS_BUY, POS_SELL = 0, 1
ORDER_BUY, ORDER_SELL = 0, 1
ACTION_DEAL, ACTION_SLTP = 1, 6  # TRADE_ACTION_DEAL / TRADE_ACTION_SLTP
MAGIC = 77310

DEFAULT_CONFIG = {
    "enabled": False,          # master switch - nothing is ever touched while False
    "dryRun": True,            # validate with order_check and log, but send nothing
    "pollSeconds": 1.0,
    "scope": {"manualOnly": True, "symbols": []},   # manualOnly: only positions with magic == 0
    "breakEven": {"enabled": False, "trigger": {"value": 1.0, "unit": "r"}, "offset": {"value": 0.0, "unit": "price"}},
    "trailing": {
        "enabled": False, "mode": "fixed",           # fixed | atr
        "start": {"value": 1.0, "unit": "r"},
        "distance": {"value": 1.0, "unit": "r"},     # fixed mode
        "step": {"value": 0.0, "unit": "price"},
        "atrPeriod": 14, "atrTimeframe": "M15", "atrMultiplier": 2.0,
    },
    "partials": {"enabled": False, "levels": [{"at": {"value": 1.0, "unit": "r"}, "closePct": 50}]},
    "autoStops": {"enabled": False, "sl": {"value": 0.0, "unit": "price"}, "tp": {"value": 0.0, "unit": "price"}},
    "dailyLoss": {"enabled": False, "limit": 0.0, "action": "alert"},  # alert | close_all
}


def merge_config(user):
    """Deep-merge user config over defaults (unknown keys are ignored, bad types fall back)."""
    def merge(base, over):
        if not isinstance(over, dict):
            return copy.deepcopy(base)
        out = {}
        for k, v in base.items():
            if isinstance(v, dict):
                out[k] = merge(v, over.get(k))
            else:
                ov = over.get(k, v)
                out[k] = ov if (isinstance(ov, type(v)) or (isinstance(v, (int, float)) and isinstance(ov, (int, float)) and not isinstance(ov, bool))) else v
        return out
    cfg = merge(DEFAULT_CONFIG, user)
    levels = (user or {}).get("partials", {}).get("levels") if isinstance(user, dict) else None
    if isinstance(levels, list):
        cfg["partials"]["levels"] = [lv for lv in levels if isinstance(lv, dict) and isinstance(lv.get("at"), dict)]
    return cfg


def pip_size(info):
    return info["point"] * 10 if info["digits"] in (3, 5) else info["point"]


def to_price(spec, info, risk=None, atr=None):
    """Convert {value, unit} to a price distance. Returns None if the unit can't be resolved."""
    try:
        v, unit = float(spec["value"]), spec["unit"]
    except (KeyError, TypeError, ValueError):
        return None
    if unit == "price":
        return v
    if unit == "pips":
        return v * pip_size(info)
    if unit == "points":
        return v * info["point"]
    if unit == "r":
        return v * risk if risk else None
    if unit == "atr":
        return v * atr if atr else None
    return None


def floor_to_step(volume, step, digits=8):
    return round(math.floor(volume / step + 1e-9) * step, digits)


def observe(pos, st):
    """Record facts we need later (initial volume / initial stop). Mutates and returns st."""
    st.setdefault("initialVolume", pos["volume"])
    st.setdefault("partialsDone", [])
    if not st.get("initialSl") and pos.get("sl"):
        st["initialSl"] = pos["sl"]
    return st


def in_scope(pos, cfg):
    sc = cfg["scope"]
    if sc["manualOnly"] and pos.get("magic", 0) != 0:
        return False
    syms = [s.strip().upper() for s in sc["symbols"] if isinstance(s, str) and s.strip()]
    return not syms or pos["symbol"].upper() in syms


def plan_action(pos, info, cfg, st, atr=None):
    """Return at most ONE action dict for this position, or None.

    Priority: auto stops > partial close > stop-loss move. One change per cycle keeps things predictable.
    Action shapes:
      {"type": "modify", "sl": float|None, "tp": float|None, "reason": str}
      {"type": "partial", "volume": float, "level": int, "reason": str}
      {"type": "skip_partial", "level": int, "reason": str}
    """
    is_long = pos["type"] == POS_BUY
    d = 1 if is_long else -1
    price = info["bid"] if is_long else info["ask"]
    open_ = pos["price_open"]
    profit = (price - open_) * d
    risk = abs(open_ - st["initialSl"]) if st.get("initialSl") else None
    min_gap = info.get("trade_stops_level", 0) * info["point"]
    digits = info["digits"]
    cur_sl = pos.get("sl") or None
    cur_tp = pos.get("tp") or None
    half_point = info["point"] / 2

    # --- 1. attach missing protective stops -------------------------------------------------
    a = cfg["autoStops"]
    if a["enabled"]:
        new_sl = new_tp = None
        if cur_sl is None:
            dist = to_price(a["sl"], info, risk, atr)
            if dist and dist > 0 and (price - (open_ - d * dist)) * d >= min_gap:
                new_sl = round(open_ - d * dist, digits)
        if cur_tp is None:
            dist = to_price(a["tp"], info, risk, atr)
            if dist and dist > 0 and ((open_ + d * dist) - price) * d >= min_gap:
                new_tp = round(open_ + d * dist, digits)
        if new_sl is not None or new_tp is not None:
            return {"type": "modify", "sl": new_sl, "tp": new_tp, "reason": "auto-stops: attach missing " + "/".join(
                n for n, v in (("SL", new_sl), ("TP", new_tp)) if v is not None)}

    # --- 2. partial take-profit -------------------------------------------------------------
    p = cfg["partials"]
    if p["enabled"]:
        for idx, lv in enumerate(p["levels"]):
            if idx in st["partialsDone"]:
                continue
            at = to_price(lv.get("at"), info, risk, atr)
            if at is None or profit < at:
                continue
            pct = float(lv.get("closePct", 0))
            vol = floor_to_step(st["initialVolume"] * pct / 100.0, info["volume_step"])
            vol = min(vol, floor_to_step(pos["volume"], info["volume_step"]))
            if vol < info["volume_min"] - 1e-9:
                return {"type": "skip_partial", "level": idx, "reason": f"level {idx + 1}: {pct:g}% is below the minimum lot size"}
            if pos["volume"] - vol < info["volume_min"] - 1e-9:
                return {"type": "skip_partial", "level": idx, "reason": f"level {idx + 1}: would close the whole position; skipped"}
            return {"type": "partial", "volume": vol, "level": idx, "reason": f"partial {pct:g}% at level {idx + 1}"}

    # --- 3. break-even / trailing stop (only ever tighten) -----------------------------------
    cands = []
    be = cfg["breakEven"]
    if be["enabled"]:
        trig = to_price(be["trigger"], info, risk, atr)
        if trig is not None and profit >= trig:
            off = to_price(be["offset"], info, risk, atr) or 0.0
            cands.append(("break-even", open_ + d * off))
    tr = cfg["trailing"]
    step = 0.0
    if tr["enabled"]:
        start = to_price(tr["start"], info, risk, atr)
        if tr["mode"] == "atr":
            dist = atr * float(tr["atrMultiplier"]) if atr else None
        else:
            dist = to_price(tr["distance"], info, risk, atr)
        if start is not None and dist and dist > 0 and profit >= start:
            cands.append(("trailing", price - d * dist))
        step = to_price(tr["step"], info, risk, atr) or 0.0
    if not cands:
        return None
    reason, target = max(cands, key=lambda c: c[1] * d)
    target = round(target, digits)
    if cur_sl is not None:
        gain = (target - cur_sl) * d
        if gain <= half_point:
            return None  # never loosen, never repeat
        if reason == "trailing" and gain < step:
            return None
    if (price - target) * d < min_gap:
        return None  # too close to market for the broker
    if (price - target) * d <= 0:
        return None
    return {"type": "modify", "sl": target, "tp": None, "reason": reason}


def daily_loss_breached(cfg, realized_today, floating):
    dl = cfg["dailyLoss"]
    return bool(dl["enabled"] and dl["limit"] > 0 and (realized_today + floating) <= -abs(dl["limit"]))


def build_modify_request(pos, action):
    """SL/TP change. Keeps the existing value for whichever side the action does not set."""
    return {
        "action": ACTION_SLTP, "position": pos["ticket"], "symbol": pos["symbol"],
        "sl": action["sl"] if action.get("sl") is not None else (pos.get("sl") or 0.0),
        "tp": action["tp"] if action.get("tp") is not None else (pos.get("tp") or 0.0),
        "magic": MAGIC,
    }


def build_close_request(pos, volume, info, filling, comment="tj-bot"):
    """Market close of `volume` on an EXISTING position (opposite side, tied to the ticket)."""
    is_long = pos["type"] == POS_BUY
    volume = min(volume, pos["volume"])
    return {
        "action": ACTION_DEAL, "position": pos["ticket"], "symbol": pos["symbol"], "volume": volume,
        "type": ORDER_SELL if is_long else ORDER_BUY,
        "price": info["bid"] if is_long else info["ask"],
        "deviation": 20, "magic": MAGIC, "comment": comment,
        "type_time": 0, "type_filling": filling,  # 0 = ORDER_TIME_GTC
    }


def pick_filling(filling_mode_bits):
    """SYMBOL_FILLING_FOK=1, IOC=2 -> ORDER_FILLING_FOK=0, IOC=1, RETURN=2."""
    if filling_mode_bits & 2:
        return 1
    if filling_mode_bits & 1:
        return 0
    return 2


def atr_from_rates(highs, lows, closes, period):
    """Simple-average ATR over the last `period` bars (needs period+1 bars)."""
    if len(closes) < period + 1:
        return None
    trs = [max(highs[i] - lows[i], abs(highs[i] - closes[i - 1]), abs(lows[i] - closes[i - 1])) for i in range(len(closes) - period, len(closes))]
    return sum(trs) / period
