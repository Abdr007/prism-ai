-- Prism PostgreSQL Schema
--
-- 5 tables with TIMESTAMPTZ time columns, composite primary keys,
-- idempotent ON CONFLICT support, and optional TimescaleDB hypertables.

-- Enable TimescaleDB if available (optional but recommended)
-- CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ============================================================================
-- Core market data (per-exchange, 1-minute granularity)
-- ============================================================================

CREATE TABLE IF NOT EXISTS perp_market_data (
  time              TIMESTAMPTZ      NOT NULL,
  symbol            TEXT             NOT NULL,
  exchange          TEXT             NOT NULL,

  mark_price        DOUBLE PRECISION NOT NULL,
  index_price       DOUBLE PRECISION NOT NULL,
  funding_rate      DOUBLE PRECISION NOT NULL,
  open_interest     DOUBLE PRECISION NOT NULL,
  open_interest_usd DOUBLE PRECISION NOT NULL,

  PRIMARY KEY (time, symbol, exchange)
);

CREATE INDEX IF NOT EXISTS idx_perp_symbol_time
  ON perp_market_data (symbol, time DESC);

CREATE INDEX IF NOT EXISTS idx_perp_exchange_time
  ON perp_market_data (exchange, time DESC);

-- SELECT create_hypertable('perp_market_data', 'time', if_not_exists => TRUE);

-- ============================================================================
-- Aggregated snapshots (cross-exchange, 1-minute)
-- ============================================================================

CREATE TABLE IF NOT EXISTS aggregated_snapshots (
  time               TIMESTAMPTZ      NOT NULL,
  symbol             TEXT             NOT NULL,

  avg_mark_price     DOUBLE PRECISION NOT NULL,
  avg_funding_rate   DOUBLE PRECISION NOT NULL,
  total_oi_usd       DOUBLE PRECISION NOT NULL,
  price_spread_pct   DOUBLE PRECISION NOT NULL,
  funding_spread_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
  funding_z_score    DOUBLE PRECISION NOT NULL DEFAULT 0,
  oi_z_score         DOUBLE PRECISION NOT NULL DEFAULT 0,
  exchange_count     INTEGER          NOT NULL DEFAULT 0,

  PRIMARY KEY (time, symbol)
);

CREATE INDEX IF NOT EXISTS idx_agg_symbol_time
  ON aggregated_snapshots (symbol, time DESC);

-- SELECT create_hypertable('aggregated_snapshots', 'time', if_not_exists => TRUE);

-- ============================================================================
-- Risk scores (1-minute)
-- ============================================================================

CREATE TABLE IF NOT EXISTS risk_scores (
  time                      TIMESTAMPTZ      NOT NULL,
  symbol                    TEXT             NOT NULL,

  risk_score                INTEGER          NOT NULL,
  risk_level                TEXT             NOT NULL,
  confidence                DOUBLE PRECISION NOT NULL DEFAULT 0,
  prediction_direction      TEXT,
  prediction_probability    DOUBLE PRECISION,
  prediction_impact_usd     DOUBLE PRECISION,
  prediction_trigger_price  DOUBLE PRECISION,

  PRIMARY KEY (time, symbol)
);

CREATE INDEX IF NOT EXISTS idx_risk_symbol_time
  ON risk_scores (symbol, time DESC);

CREATE INDEX IF NOT EXISTS idx_risk_level_time
  ON risk_scores (risk_level, time DESC);

CREATE INDEX IF NOT EXISTS idx_risk_score_covering
  ON risk_scores (risk_score DESC, time DESC) INCLUDE (symbol, risk_level);

-- SELECT create_hypertable('risk_scores', 'time', if_not_exists => TRUE);

-- ============================================================================
-- Alerts / anomalies
-- ============================================================================

CREATE TABLE IF NOT EXISTS alerts (
  id           BIGSERIAL    PRIMARY KEY,
  time         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  symbol       TEXT         NOT NULL,
  alert_type   TEXT         NOT NULL,
  severity     TEXT         NOT NULL,
  message      TEXT,
  data         JSONB,

  CONSTRAINT chk_severity CHECK (severity IN ('low', 'medium', 'high', 'critical'))
);

CREATE INDEX IF NOT EXISTS idx_alerts_time
  ON alerts (time DESC);

CREATE INDEX IF NOT EXISTS idx_alerts_severity_time
  ON alerts (severity, time DESC);

-- ============================================================================
-- Cascade events (backtest ground truth)
-- ============================================================================
--
-- Deterministic TEXT id = 'symbol:direction:start_epoch_ms' ensures idempotent
-- inserts via ON CONFLICT (id) DO NOTHING — re-running detection on the same
-- data produces the same rows with no duplicates.

CREATE TABLE IF NOT EXISTS cascade_events (
  id                     TEXT             PRIMARY KEY,
  symbol                 TEXT             NOT NULL,
  direction              TEXT             NOT NULL,
  start_time             TIMESTAMPTZ      NOT NULL,
  end_time               TIMESTAMPTZ      NOT NULL,
  price_change_pct       DOUBLE PRECISION NOT NULL,
  liquidation_volume_usd DOUBLE PRECISION NOT NULL,

  CONSTRAINT chk_direction CHECK (direction IN ('LONG_SQUEEZE', 'SHORT_SQUEEZE')),
  CONSTRAINT uq_cascade_natural_key UNIQUE (symbol, direction, start_time)
);

CREATE INDEX IF NOT EXISTS idx_cascade_symbol_start
  ON cascade_events (symbol, start_time DESC);

CREATE INDEX IF NOT EXISTS idx_cascade_symbol_direction
  ON cascade_events (symbol, direction);

CREATE INDEX IF NOT EXISTS idx_cascade_symbol_range
  ON cascade_events (symbol, start_time, end_time);
