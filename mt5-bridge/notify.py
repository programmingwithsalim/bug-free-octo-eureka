"""Alert delivery: Windows desktop toast, sound, Telegram (phone). Every channel fails independently and never raises.

python notify.py --test --config data/alerts-config.json   # sends a test alert on every enabled channel, prints JSON
"""
import argparse
import json
import os
import subprocess
import sys
import urllib.request

TOAST_PS = r"""
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$n = $t.GetElementsByTagName('text')
$n.Item(0).AppendChild($t.CreateTextNode($env:TJ_TITLE)) | Out-Null
$n.Item(1).AppendChild($t.CreateTextNode($env:TJ_BODY)) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($t)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe').Show($toast)
"""


def windows_toast(title, body):
    """Native Windows notification (works with the browser closed). Text goes via environment variables, never into the script."""
    try:
        env = {**os.environ, "TJ_TITLE": title[:120], "TJ_BODY": body[:240]}
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", TOAST_PS], env=env, capture_output=True, text=True, timeout=20, creationflags=flags)
        return (r.returncode == 0, (r.stderr or "").strip()[:200] or "shown")
    except Exception as e:  # noqa: BLE001 - channel must never crash the service
        return False, f"{type(e).__name__}: {e}"


def beep(level="signal"):
    try:
        import winsound
        pattern = [(1100, 180), (1400, 180), (1100, 180)] if level == "signal" else [(900, 250)]
        for f, d in pattern:
            winsound.Beep(f, d)
        return True, "played"
    except Exception as e:  # noqa: BLE001
        return False, f"{type(e).__name__}: {e}"


def telegram(token, chat_id, text, urlopen=urllib.request.urlopen):
    """Plain text (no markdown parsing, so level names/prices can never break the message)."""
    if not token or not chat_id:
        return False, "token or chat id missing"
    try:
        req = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage", data=json.dumps({"chat_id": str(chat_id), "text": text[:3900], "disable_web_page_preview": True}).encode(),
                                     headers={"Content-Type": "application/json"})
        with urlopen(req, timeout=15) as r:
            body = json.loads(r.read())
        return (bool(body.get("ok")), "sent" if body.get("ok") else str(body.get("description", "rejected"))[:200])
    except Exception as e:  # noqa: BLE001 - never include the token in an error message
        return False, f"{type(e).__name__}"


def send(cfg, title, body, level="signal", senders=None):
    """Dispatch to every enabled channel. -> {channel: (ok, detail)}"""
    ch = cfg.get("channels", {})
    s = senders or {"toast": windows_toast, "beep": beep, "telegram": telegram}
    out = {}
    if ch.get("desktop", True):
        out["desktop"] = s["toast"](title, body.split("\n")[0] if level != "info" else body)
    if ch.get("sound", True) and level != "info":
        out["sound"] = s["beep"](level)
    tg = ch.get("telegram", {})
    if tg.get("enabled"):
        out["telegram"] = s["telegram"](tg.get("token", ""), tg.get("chatId", ""), f"{title}\n\n{body}")
    return out


def fmt_price(x):
    return f"{x:,.2f}"


def format_signal(sig, evidence=None):
    """-> (title, body). Short first line (toast), full checklist below (Telegram / feed)."""
    side = sig["side"].upper()
    head = f"{side} XAUUSD: {sig['name']}"
    if sig.get("kind") != "plan":
        head += f" [{sig['score']}]"
    b = sig.get("bias") or {}
    lines = [f"Entry ~{fmt_price(sig['entry'])}  SL {fmt_price(sig['sl'])}  TP {fmt_price(sig['tp'])}  (R:R {sig['rr']:.1f})"]
    if b:
        lines.append(f"Bias: {b.get('bias', '?')} ({b.get('why', '')}) | mode: {sig.get('mode', 'trend')}")
    lines += [f"- {r}" for r in sig.get("reasons", [])[:3]]
    lines.append("Before you click: bias agrees? candle CLOSED? stop placed? risk <= your plan? If not, skip it.")
    if evidence:
        lines.append(evidence)
    return head, "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--test", action="store_true")
    ap.add_argument("--config", default="data/alerts-config.json")
    a = ap.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    try:
        with open(a.config, encoding="utf8") as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        cfg = {}
    res = send(cfg, "Trade Journal test alert", "If you can read this, alerts reach you.\nThis is only a test, no trade is implied.", "signal")
    print(json.dumps({"ok": any(v[0] for v in res.values()) if res else False, "channels": {k: {"ok": v[0], "detail": v[1]} for k, v in res.items()}}))


if __name__ == "__main__":
    main()
