export type Side = "long" | "short";

export interface Trade {
  id: string;
  symbol: string;
  side: Side;
  openTime: string; // ISO
  closeTime: string; // ISO
  entry: number;
  exit: number;
  size: number;
  /** Net P&L in account currency (after fees). */
  pnl: number;
  /** Commission + swap etc, positive number. Already included in pnl. */
  fees: number;
  stopLoss?: number;
  takeProfit?: number;
  // journal fields
  setup?: string;
  tags: string[];
  emotion?: string;
  rating?: number; // 1-5 execution quality
  notes?: string;
  screenshot?: string; // URL
}

export interface AccountSettings {
  name: string;
  broker: string;
  currency: string;
  startingBalance: number;
}

export const DEFAULT_ACCOUNT: AccountSettings = {
  name: "Main account",
  broker: "",
  currency: "USD",
  startingBalance: 10000,
};

export const MISTAKE_TAGS = [
  "FOMO entry",
  "Revenge trade",
  "Oversized",
  "No stop loss",
  "Moved stop",
  "Closed early",
  "Held too long",
  "Broke plan",
  "Overtrading",
  "Chased price",
  "Good execution",
];

export const EMOTIONS = ["Calm", "Confident", "Anxious", "Greedy", "Angry", "Bored", "Tired", "Frustrated"];

export type Severity = "high" | "medium" | "low" | "good";

export interface Insight {
  id: string;
  severity: Severity;
  title: string;
  evidence: string;
  advice: string;
  /** Estimated P&L impact (negative = money lost to this behaviour). */
  cost?: number;
}
