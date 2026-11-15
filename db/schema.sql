-- Trade journal schema. Idempotent: safe to run on every start.
CREATE TABLE IF NOT EXISTS account (
  id         int PRIMARY KEY DEFAULT 1 CHECK (id = 1),   -- single account row
  data       jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trades (
  id         text PRIMARY KEY,
  symbol     text NOT NULL,
  side       text NOT NULL,
  open_time  timestamptz NOT NULL,
  close_time timestamptz NOT NULL,
  entry      double precision,
  exit       double precision,
  size       double precision,
  pnl        double precision NOT NULL,
  fees       double precision NOT NULL DEFAULT 0,
  data       jsonb NOT NULL,                              -- the full trade object (journal fields included)
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trades_close_idx ON trades (close_time);
CREATE INDEX IF NOT EXISTS trades_symbol_idx ON trades (symbol);

-- MT5 candles for closed windows never change, so they are cached here.
CREATE TABLE IF NOT EXISTS candles_cache (
  key        text PRIMARY KEY,
  candles    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Hindsight analysis per trade (see src/lib/analysis.ts). `version` lets us recompute when the engine changes.
CREATE TABLE IF NOT EXISTS trade_analysis (
  trade_id   text PRIMARY KEY REFERENCES trades(id) ON DELETE CASCADE,
  version    int NOT NULL,
  analysis   jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
