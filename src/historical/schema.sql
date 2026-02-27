-- ==========================================================================
-- PRISM Historical Market Data Schema
-- ==========================================================================
--
-- Designed for time-series analytics on perpetual futures data.
-- All tables use TIMESTAMPTZ, composite primary keys, and support
-- idempotent inserts via ON CONFLICT DO NOTHING.
--
-- Optional: Enable TimescaleDB for automatic partitioning & compression.
-- CREATE EXTENSION IF NOT EXISTS timescaledb;
-- ==========================================================================


-- --------------------------------------------------------------------------
-- 1. Mark Prices (1-minute resolution from kline close)
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mark_prices (
  symbol      TEXT             NOT NULL,
  timestamp   TIMESTAMPTZ      NOT NULL,
  mark_price  DOUBLE PRECISION NOT NULL,

  PRIMARY KEY (symbol, timestamp)
);

CREATE INDEX IF NOT EXISTS idx_mark_prices_symbol_time
  ON mark_prices (symbol, timestamp DESC);

-- TimescaleDB (optional):
-- SELECT create_hypertable('mark_prices', 'timestamp',
--   partitioning_column => 'symbol',
--   number_partitions   => 4,
--   if_not_exists       => TRUE
-- );


-- --------------------------------------------------------------------------
-- 2. Liquidations (event-level, from forceOrder stream)
-- --------------------------------------------------------------------------
-- id = deterministic: symbol:side:tradeTimeMs to avoid duplicates
-- from WebSocket reconnects or replayed events.

CREATE TABLE IF NOT EXISTS liquidations (
  id          TEXT             PRIMARY KEY,
  symbol      TEXT             NOT NULL,
  side        TEXT             NOT NULL CHECK (side IN ('BUY', 'SELL')),
  price       DOUBLE PRECISION NOT NULL,
  quantity    DOUBLE PRECISION NOT NULL,
  usd_value   DOUBLE PRECISION NOT NULL,
  timestamp   TIMESTAMPTZ      NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_liquidations_symbol_time
  ON liquidations (symbol, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_liquidations_time
  ON liquidations (timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_liquidations_side
  ON liquidations (symbol, side, timestamp DESC);


-- --------------------------------------------------------------------------
-- 3. Funding Rates (8-hour intervals from Binance Futures)
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS funding_rates (
  symbol        TEXT             NOT NULL,
  funding_time  TIMESTAMPTZ      NOT NULL,
  funding_rate  DOUBLE PRECISION NOT NULL,

  PRIMARY KEY (symbol, funding_time)
);

CREATE INDEX IF NOT EXISTS idx_funding_rates_symbol_time
  ON funding_rates (symbol, funding_time DESC);


-- --------------------------------------------------------------------------
-- 4. Open Interest (1-minute or 5-minute from historical API)
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS open_interest (
  symbol            TEXT             NOT NULL,
  timestamp         TIMESTAMPTZ      NOT NULL,
  open_interest_usd DOUBLE PRECISION NOT NULL,

  PRIMARY KEY (symbol, timestamp)
);

CREATE INDEX IF NOT EXISTS idx_open_interest_symbol_time
  ON open_interest (symbol, timestamp DESC);


-- --------------------------------------------------------------------------
-- Optional: Monthly partitioning for tables exceeding 10M rows.
--
-- Native PostgreSQL range partitioning example (manual):
--
-- CREATE TABLE mark_prices_2025_01 PARTITION OF mark_prices
--   FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
--
-- With TimescaleDB, partitioning is automatic via create_hypertable.
-- --------------------------------------------------------------------------
