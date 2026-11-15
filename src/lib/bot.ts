/** Trade-manager config shared by the UI and the API. Mirrors DEFAULT_CONFIG in mt5-bridge/manager_logic.py. */
export const UNITS = ["price", "pips", "points", "r"] as const;
export type Unit = (typeof UNITS)[number];
export interface Dist { value: number; unit: Unit }
export type TrailMode = "fixed" | "atr";
export const TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"] as const;

export interface BotConfig {
  enabled: boolean;
  dryRun: boolean;
  pollSeconds: number;
  scope: { manualOnly: boolean; symbols: string[] };
  breakEven: { enabled: boolean; trigger: Dist; offset: Dist };
  trailing: { enabled: boolean; mode: TrailMode; start: Dist; distance: Dist; step: Dist; atrPeriod: number; atrTimeframe: (typeof TIMEFRAMES)[number]; atrMultiplier: number };
  partials: { enabled: boolean; levels: { at: Dist; closePct: number }[] };
  autoStops: { enabled: boolean; sl: Dist; tp: Dist };
  dailyLoss: { enabled: boolean; limit: number; action: "alert" | "close_all" };
}

export const DEFAULT_BOT_CONFIG: BotConfig = {
  enabled: false,
  dryRun: true,
  pollSeconds: 1,
  scope: { manualOnly: true, symbols: [] },
  breakEven: { enabled: false, trigger: { value: 1, unit: "r" }, offset: { value: 0, unit: "price" } },
  trailing: {
    enabled: false, mode: "fixed", start: { value: 1, unit: "r" }, distance: { value: 1, unit: "r" }, step: { value: 0, unit: "price" },
    atrPeriod: 14, atrTimeframe: "M15", atrMultiplier: 2,
  },
  partials: { enabled: false, levels: [{ at: { value: 1, unit: "r" }, closePct: 50 }] },
  autoStops: { enabled: false, sl: { value: 0, unit: "price" }, tp: { value: 0, unit: "price" } },
  dailyLoss: { enabled: false, limit: 0, action: "alert" },
};

const num = (v: unknown, d: number, min = 0, max = 1e9) => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const obj = (v: unknown): any => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const dist = (v: any, d: Dist): Dist => ({ value: num(obj(v).value, d.value), unit: (UNITS as readonly string[]).includes(obj(v).unit) ? obj(v).unit : d.unit });

/** Coerce anything (hand-edited JSON, form state) into a valid config. Never throws. */
export function sanitizeBotConfig(raw: unknown): BotConfig {
  const r = obj(raw), D = DEFAULT_BOT_CONFIG;
  const be = obj(r.breakEven), tr = obj(r.trailing), pa = obj(r.partials), au = obj(r.autoStops), dl = obj(r.dailyLoss), sc = obj(r.scope);
  const levels = Array.isArray(pa.levels) ? pa.levels.slice(0, 6) : D.partials.levels;
  return {
    enabled: bool(r.enabled, D.enabled),
    dryRun: bool(r.dryRun, D.dryRun),
    pollSeconds: num(r.pollSeconds, D.pollSeconds, 0.5, 30),
    scope: {
      manualOnly: bool(sc.manualOnly, true),
      symbols: Array.isArray(sc.symbols) ? sc.symbols.filter((s: unknown) => typeof s === "string" && s.trim()).map((s: string) => s.trim().slice(0, 24)).slice(0, 50) : [],
    },
    breakEven: { enabled: bool(be.enabled, false), trigger: dist(be.trigger, D.breakEven.trigger), offset: dist(be.offset, D.breakEven.offset) },
    trailing: {
      enabled: bool(tr.enabled, false),
      mode: tr.mode === "atr" ? "atr" : "fixed",
      start: dist(tr.start, D.trailing.start), distance: dist(tr.distance, D.trailing.distance), step: dist(tr.step, D.trailing.step),
      atrPeriod: Math.round(num(tr.atrPeriod, 14, 2, 100)),
      atrTimeframe: (TIMEFRAMES as readonly string[]).includes(tr.atrTimeframe) ? tr.atrTimeframe : "M15",
      atrMultiplier: num(tr.atrMultiplier, 2, 0.1, 20),
    },
    partials: {
      enabled: bool(pa.enabled, false),
      // 1-99%: a "partial" must never be able to close the whole position
      levels: levels.map((l: any) => ({ at: dist(obj(l).at, D.partials.levels[0].at), closePct: num(obj(l).closePct, 50, 1, 99) })),
    },
    autoStops: { enabled: bool(au.enabled, false), sl: dist(au.sl, D.autoStops.sl), tp: dist(au.tp, D.autoStops.tp) },
    dailyLoss: { enabled: bool(dl.enabled, false), limit: num(dl.limit, 0), action: dl.action === "close_all" ? "close_all" : "alert" },
  };
}

export interface BotPosition { ticket: number; symbol: string; type: "buy" | "sell"; volume: number; open: number; sl: number; tp: number; profit: number; managed: boolean; next: string | null }
export interface BotStatus {
  pid: number; ts: number; connected: boolean; error: string | null; enabled: boolean; dryRun: boolean;
  account: { login: number; currency: string; balance: number; equity: number } | null;
  positions: BotPosition[]; floating: number;
  dailyLoss: { enabled: boolean; limit: number; realized: number; breached: boolean };
}
export interface BotLogEntry { t: string; ticket: number; symbol: string; action: string; reason: string; dry: boolean; ok: boolean; detail?: string; sl?: number | null; tp?: number | null; volume?: number | null }
