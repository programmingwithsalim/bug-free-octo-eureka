import json

import notify as N

SIG = {"side": "sell", "name": "Liquidity sweep + structure shift", "score": 82, "entry": 4501.5, "sl": 4510.0, "tp": 4480.0, "rr": 2.5, "mode": "trend",
       "bias": {"bias": "bearish", "why": "H4 and H1 both trending down"}, "reasons": ["Swept the previous day high", "Structure shift on a closed M15 candle", "Target: previous day low"]}


def fakes():
    log = []
    return log, {"toast": lambda t, b: (log.append(("toast", t, b)), (True, "shown"))[1],
                 "beep": lambda lv: (log.append(("beep", lv)), (True, "played"))[1],
                 "telegram": lambda tok, chat, text: (log.append(("tg", tok, chat, text)), (True, "sent"))[1]}


def test_format_signal_has_a_short_headline_and_a_pre_trade_checklist():
    title, body = N.format_signal(SIG, evidence="Evidence: unproven (backtest 0.0R)")
    assert title.startswith("SELL XAUUSD") and "[82]" in title
    assert "Entry ~4,501.50" in body and "SL 4,510.00" in body and "TP 4,480.00" in body and "R:R 2.5" in body
    assert "Bias: bearish" in body and "Before you click" in body and "Evidence: unproven" in body
    plan = N.format_signal({**SIG, "kind": "plan", "name": "Daily plan"})[0]
    assert "[" not in plan                                   # plans have no score


def test_send_respects_channel_toggles_and_never_beeps_for_info():
    log, s = fakes()
    cfg = {"channels": {"desktop": True, "sound": True, "telegram": {"enabled": True, "token": "T", "chatId": "42"}}}
    r = N.send(cfg, "T", "line1\nline2", "signal", senders=s)
    assert set(r) == {"desktop", "sound", "telegram"} and all(v[0] for v in r.values())
    assert ("toast", "T", "line1") in log                    # toast gets only the first line
    assert any(x[0] == "tg" and x[2] == "42" and x[3].startswith("T\n\nline1") for x in log)
    log.clear()
    r = N.send(cfg, "Morning read", "bias...", "info", senders=s)
    assert "sound" not in r and not any(x[0] == "beep" for x in log)
    log.clear()
    off = N.send({"channels": {"desktop": False, "sound": False}}, "x", "y", senders=s)
    assert off == {} and log == []


def test_telegram_failures_are_reported_without_leaking_the_token():
    ok, detail = N.telegram("", "1", "hi")
    assert not ok and "missing" in detail
    def boom(req, timeout=0):
        raise OSError("https://api.telegram.org/botSECRET123/sendMessage unreachable")
    ok, detail = N.telegram("SECRET123", "1", "hi", urlopen=boom)
    assert not ok and "SECRET123" not in detail
    class R:
        def __init__(self, b): self.b = b
        def read(self): return self.b
        def __enter__(self): return self
        def __exit__(self, *a): return False
    assert N.telegram("T", "1", "hi", urlopen=lambda req, timeout=0: R(json.dumps({"ok": True}).encode())) == (True, "sent")
    assert N.telegram("T", "1", "hi", urlopen=lambda req, timeout=0: R(json.dumps({"ok": False, "description": "chat not found"}).encode())) == (False, "chat not found")
