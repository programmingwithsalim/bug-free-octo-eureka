/** Signal-alert types + validation. Mirrors DEFAULT_CFG in mt5-bridge/signal_service.py. */
export type SetupPref = "auto" | "on" | "off";

export interface AlertsConfig {
  enabled: boolean;
  symbol: string;
  channels: { desktop: boolean; sound: boolean; telegram: { enabled: boolean; token: string; chatId: string } };
  minScore: number;
  maxPerDay: number;
  plans: { "07": boolean; "12": boolean };
  briefing: boolean;
  biasChange: boolean;
  news: { enabled: boolean; minutes: number[] };
  setups: Record<string, SetupPref>;
  scalps: boolean;
  quiet: { enabled: boolean; start: number; end: number };
}

export const DEFAULT_ALERTS: AlertsConfig = {
  enabled: true,
  symbol: "XAUUSDm",
  channels: { desktop: true, sound: true, telegram: { enabled: false, token: "", chatId: "" } },
  minScore: 70,
  maxPerDay: 6,
  plans: { "07": false, "12": true },
  briefing: true,
  biasChange: true,
  news: { enabled: true, minutes: [30, 10] },
  setups: {},
  scalps: true,
  quiet: { enabled: false, start: 22, end: 6 },
};

export const SETUP_KEYS = [
  "sweep_mss", "sweep_reject", "news_sweep", "double_top", "double_bottom", "head_shoulders", "inverse_head_shoulders", "trendline_bounce", "trendline_break", "range_scalp",
] as const;

const num = (v: unknown, d: number, min: number, max: number) => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : d;
};
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const obj = (v: unknown): any => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

/** Coerce anything into a valid config. `keepToken` is the stored Telegram token, used when the UI sends the "set" placeholder. */
export function sanitizeAlerts(raw: unknown, keepToken = ""): AlertsConfig {
  const r = obj(raw), D = DEFAULT_ALERTS, ch = obj(r.channels), tg = obj(ch.telegram), pl = obj(r.plans), nw = obj(r.news), q = obj(r.quiet), su = obj(r.setups);
  const tokenIn = typeof tg.token === "string" ? tg.token.trim() : "";
  const setups: Record<string, SetupPref> = {};
  for (const k of SETUP_KEYS) if (su[k] === "on" || su[k] === "off" || su[k] === "auto") setups[k] = su[k];
  return {
    enabled: bool(r.enabled, D.enabled),
    symbol: typeof r.symbol === "string" && /^[A-Za-z0-9._#-]{1,24}$/.test(r.symbol) ? r.symbol : D.symbol,
    channels: {
      desktop: bool(ch.desktop, true), sound: bool(ch.sound, true),
      telegram: {
        enabled: bool(tg.enabled, false),
        token: tokenIn === "set" ? keepToken : /^[0-9]{5,15}:[A-Za-z0-9_-]{20,60}$/.test(tokenIn) ? tokenIn : "",
        chatId: typeof tg.chatId === "string" && /^-?[0-9]{3,20}$/.test(tg.chatId.trim()) ? tg.chatId.trim() : "",
      },
    },
    minScore: num(r.minScore, D.minScore, 40, 100),
    maxPerDay: num(r.maxPerDay, D.maxPerDay, 1, 30),
    plans: { "07": bool(pl["07"], false), "12": bool(pl["12"], true) },
    briefing: bool(r.briefing, true),
    biasChange: bool(r.biasChange, true),
    news: { enabled: bool(nw.enabled, true), minutes: Array.isArray(nw.minutes) ? [...new Set(nw.minutes.map(Number).filter((m: number) => isFinite(m) && m >= 1).map((m: number) => Math.min(240, Math.round(m))))].slice(0, 4) as number[] : D.news.minutes },
    setups,
    scalps: bool(r.scalps, true),
    quiet: { enabled: bool(q.enabled, false), start: num(q.start, 22, 0, 23), end: num(q.end, 6, 0, 23) },
  };
}

/** What the UI may show: the Telegram token is replaced by a placeholder. */
export const maskAlerts = (c: AlertsConfig): AlertsConfig => ({ ...c, channels: { ...c.channels, telegram: { ...c.channels.telegram, token: c.channels.telegram.token ? "set" : "" } } });

// ---- data shapes read from the service ----
export interface SignalRec {
  id: string; symbol: string; setup: string; side: "buy" | "sell"; name: string; kind?: string; time: number; close_time: number; tf: string; mode: string;
  entry: number; sl: number; tp: number; rr: number; score: number; level?: number; level_label?: string;
  reasons: string[]; score_parts?: { points: number; reason: string }[]; points: { t: number; price: number; label: string }[];
  bias?: { bias: string; strength?: string; regime?: string; why?: string; h4?: string; h1?: string; agrees?: boolean };
  targets?: { price: number; label: string }[]; target_label?: string; event?: string;
  status: "open" | "tp" | "sl" | "time" | "skipped"; r?: number; at?: number; delivery?: Record<string, boolean>;
}
export interface InfoRec { t: number; kind: string; title: string; body: string }
export interface Snapshot {
  price: number; time: number; bias: string; strength: string; regime: string; mode: string; why: string; action: string; atr: number;
  h4: { trend: string; structure: string; er: number } | null; h1: { trend: string; structure: string; er: number; hi: number; lo: number } | null;
  levels: { price: number; kind: string; label: string }[]; draw: { label: string; price: number; distance: number } | null;
}
export interface SignalStatus {
  pid: number; ts: number; connected: boolean; error: string | null; enabled: boolean; symbol: string; bar_time: number | null; snapshot: Snapshot | null;
  news: { ok: boolean; note: string; upcoming: { time: number; title: string; impact: string; forecast?: string; previous?: string }[] };
  today: number; forward: Record<string, { n: number; wins: number; sum_r: number }>; open: number; config: AlertsConfig;
}
export interface BtStats { n: number; win: number; avg_r: number; pf: number; max_dd: number; total_r: number; t: number }
export interface BtSetup { setup: string; name: string; total: BtStats; in_sample: BtStats; out_of_sample: BtStats; score70: BtStats; passes: boolean; why_not: string[] }
export interface Backtest {
  ok: boolean; symbol: string; generated: number; spread: number; bars: number; from: number; to: number; seconds: number; note: string;
  regime_share: Record<string, number>; liquidity: { days?: number; took_pdh_or_pdl?: number; took_both?: number; stayed_inside?: number; nearer_side_first?: number };
  report: { gate: Record<string, number>; setups: BtSetup[]; overall: BtStats; overall_oos: BtStats; n_trades: number };
}
