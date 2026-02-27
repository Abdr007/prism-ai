/**
 * Historical data pipeline — database access layer.
 *
 * Owns the 4 historical tables (mark_prices, liquidations,
 * funding_rates, open_interest). Provides batch upsert, schema
 * bootstrap, and statistics queries.
 *
 * All writes are idempotent via ON CONFLICT DO NOTHING.
 */

import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { logger as rootLogger } from '../lib/logger.js';
import type {
  MarkPriceRow,
  LiquidationRow,
  FundingRateRow,
  OpenInterestRow,
  TableStats,
  DistributionStats,
} from './types.js';

const log = rootLogger.child({ component: 'historical-db' });

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL || 'postgresql://prism:prism@localhost:5432/prism';
    pool = new pg.Pool({
      connectionString: url,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    pool.on('error', (err) => log.error({ err: err.message }, 'Pool error'));
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// ---------------------------------------------------------------------------
// Schema bootstrap
// ---------------------------------------------------------------------------

export async function ensureHistoricalSchema(): Promise<void> {
  const schemaPath = join(__dirname, 'schema.sql');
  let sql: string;
  try {
    sql = readFileSync(schemaPath, 'utf-8');
  } catch {
    // In compiled dist/ the .sql is one level up from the .js
    sql = readFileSync(join(__dirname, '..', 'historical', 'schema.sql'), 'utf-8');
  }
  const p = getPool();
  await p.query(sql);
  log.info('Historical schema ensured');
}

// ---------------------------------------------------------------------------
// Batch inserts
// ---------------------------------------------------------------------------

/**
 * Insert mark prices in batches. ON CONFLICT DO NOTHING.
 */
export async function insertMarkPrices(
  rows: Array<{ symbol: string; timestamp: Date; markPrice: number }>,
  batchSize = 1000,
): Promise<number> {
  if (rows.length === 0) return 0;
  const p = getPool();
  let inserted = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const values: unknown[] = [];
    const placeholders: string[] = [];

    for (let j = 0; j < batch.length; j++) {
      const offset = j * 3;
      placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3})`);
      values.push(batch[j].symbol, batch[j].timestamp.toISOString(), batch[j].markPrice);
    }

    const res = await p.query(
      `INSERT INTO mark_prices (symbol, timestamp, mark_price)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT DO NOTHING`,
      values,
    );
    inserted += res.rowCount ?? 0;
  }

  log.info({ total: rows.length, inserted }, 'Inserted mark prices');
  return inserted;
}

/**
 * Insert liquidations in batches. ON CONFLICT DO NOTHING.
 */
export async function insertLiquidations(
  rows: LiquidationRow[],
  batchSize = 1000,
): Promise<number> {
  if (rows.length === 0) return 0;
  const p = getPool();
  let inserted = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const values: unknown[] = [];
    const placeholders: string[] = [];

    for (let j = 0; j < batch.length; j++) {
      const r = batch[j];
      const offset = j * 7;
      placeholders.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`,
      );
      values.push(r.id, r.symbol, r.side, r.price, r.quantity, r.usd_value, r.timestamp.toISOString());
    }

    const res = await p.query(
      `INSERT INTO liquidations (id, symbol, side, price, quantity, usd_value, timestamp)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT DO NOTHING`,
      values,
    );
    inserted += res.rowCount ?? 0;
  }

  log.info({ total: rows.length, inserted }, 'Inserted liquidations');
  return inserted;
}

/**
 * Insert funding rates in batches. ON CONFLICT DO NOTHING.
 */
export async function insertFundingRates(
  rows: Array<{ symbol: string; fundingTime: Date; fundingRate: number }>,
  batchSize = 1000,
): Promise<number> {
  if (rows.length === 0) return 0;
  const p = getPool();
  let inserted = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const values: unknown[] = [];
    const placeholders: string[] = [];

    for (let j = 0; j < batch.length; j++) {
      const offset = j * 3;
      placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3})`);
      values.push(batch[j].symbol, batch[j].fundingTime.toISOString(), batch[j].fundingRate);
    }

    const res = await p.query(
      `INSERT INTO funding_rates (symbol, funding_time, funding_rate)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT DO NOTHING`,
      values,
    );
    inserted += res.rowCount ?? 0;
  }

  log.info({ total: rows.length, inserted }, 'Inserted funding rates');
  return inserted;
}

/**
 * Insert open interest in batches. ON CONFLICT DO NOTHING.
 */
export async function insertOpenInterest(
  rows: Array<{ symbol: string; timestamp: Date; openInterestUsd: number }>,
  batchSize = 1000,
): Promise<number> {
  if (rows.length === 0) return 0;
  const p = getPool();
  let inserted = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const values: unknown[] = [];
    const placeholders: string[] = [];

    for (let j = 0; j < batch.length; j++) {
      const offset = j * 3;
      placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3})`);
      values.push(batch[j].symbol, batch[j].timestamp.toISOString(), batch[j].openInterestUsd);
    }

    const res = await p.query(
      `INSERT INTO open_interest (symbol, timestamp, open_interest_usd)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT DO NOTHING`,
      values,
    );
    inserted += res.rowCount ?? 0;
  }

  log.info({ total: rows.length, inserted }, 'Inserted open interest');
  return inserted;
}

// ---------------------------------------------------------------------------
// Single-row insert (used by live ingestion)
// ---------------------------------------------------------------------------

export async function insertOneMarkPrice(
  symbol: string,
  timestamp: Date,
  markPrice: number,
): Promise<void> {
  const p = getPool();
  await p.query(
    `INSERT INTO mark_prices (symbol, timestamp, mark_price)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [symbol, timestamp.toISOString(), markPrice],
  );
}

export async function insertOneLiquidation(row: LiquidationRow): Promise<void> {
  const p = getPool();
  await p.query(
    `INSERT INTO liquidations (id, symbol, side, price, quantity, usd_value, timestamp)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
    [row.id, row.symbol, row.side, row.price, row.quantity, row.usd_value, row.timestamp.toISOString()],
  );
}

export async function insertOneFundingRate(
  symbol: string,
  fundingTime: Date,
  fundingRate: number,
): Promise<void> {
  const p = getPool();
  await p.query(
    `INSERT INTO funding_rates (symbol, funding_time, funding_rate)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [symbol, fundingTime.toISOString(), fundingRate],
  );
}

export async function insertOneOpenInterest(
  symbol: string,
  timestamp: Date,
  openInterestUsd: number,
): Promise<void> {
  const p = getPool();
  await p.query(
    `INSERT INTO open_interest (symbol, timestamp, open_interest_usd)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [symbol, timestamp.toISOString(), openInterestUsd],
  );
}

// ---------------------------------------------------------------------------
// Statistics queries (for report)
// ---------------------------------------------------------------------------

export async function getTableStats(
  table: string,
  symbol: string,
  timeCol: string,
  startDate: Date,
  endDate: Date,
): Promise<TableStats> {
  const p = getPool();
  const res = await p.query<{ total_rows: string; earliest: string | null; latest: string | null }>(
    `SELECT
       COUNT(*)::TEXT                        AS total_rows,
       MIN(${timeCol})::TEXT                 AS earliest,
       MAX(${timeCol})::TEXT                 AS latest
     FROM ${table}
     WHERE symbol = $1 AND ${timeCol} >= $2 AND ${timeCol} < $3`,
    [symbol, startDate.toISOString(), endDate.toISOString()],
  );
  const row = res.rows[0];
  return {
    total_rows: Number(row.total_rows),
    earliest: row.earliest,
    latest: row.latest,
  };
}

export async function getDistribution(
  table: string,
  column: string,
  symbol: string,
  timeCol: string,
  startDate: Date,
  endDate: Date,
): Promise<DistributionStats> {
  const p = getPool();
  const res = await p.query<{
    cnt: string;
    avg_val: string | null;
    std_val: string | null;
    min_val: string | null;
    p25_val: string | null;
    median_val: string | null;
    p75_val: string | null;
    max_val: string | null;
  }>(
    `SELECT
       COUNT(*)::TEXT                                              AS cnt,
       AVG(${column})::TEXT                                        AS avg_val,
       STDDEV(${column})::TEXT                                     AS std_val,
       MIN(${column})::TEXT                                        AS min_val,
       PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY ${column})::TEXT AS p25_val,
       PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY ${column})::TEXT AS median_val,
       PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY ${column})::TEXT AS p75_val,
       MAX(${column})::TEXT                                        AS max_val
     FROM ${table}
     WHERE symbol = $1 AND ${timeCol} >= $2 AND ${timeCol} < $3`,
    [symbol, startDate.toISOString(), endDate.toISOString()],
  );
  const r = res.rows[0];
  const toNum = (v: string | null) => (v === null ? 0 : Number(v));
  return {
    count: Number(r.cnt),
    mean: toNum(r.avg_val),
    std: toNum(r.std_val),
    min: toNum(r.min_val),
    p25: toNum(r.p25_val),
    median: toNum(r.median_val),
    p75: toNum(r.p75_val),
    max: toNum(r.max_val),
  };
}

export async function getMarkPriceGaps(
  symbol: string,
  startDate: Date,
  endDate: Date,
): Promise<{ totalMissing: number; ranges: Array<{ start: string; end: string; missing: number }> }> {
  const p = getPool();

  // Generate expected 1-minute time series and left-join to find gaps
  const res = await p.query<{ gap_start: string; gap_end: string; missing: string }>(
    `WITH expected AS (
       SELECT generate_series($2::timestamptz, $3::timestamptz - interval '1 minute', interval '1 minute') AS ts
     ),
     present AS (
       SELECT timestamp AS ts
       FROM mark_prices
       WHERE symbol = $1 AND timestamp >= $2 AND timestamp < $3
     ),
     missing AS (
       SELECT e.ts
       FROM expected e
       LEFT JOIN present p ON p.ts = e.ts
       WHERE p.ts IS NULL
     ),
     gaps AS (
       SELECT ts,
              ts - (ROW_NUMBER() OVER (ORDER BY ts)) * interval '1 minute' AS grp
       FROM missing
     )
     SELECT
       MIN(ts)::TEXT AS gap_start,
       MAX(ts)::TEXT AS gap_end,
       COUNT(*)::TEXT AS missing
     FROM gaps
     GROUP BY grp
     ORDER BY MIN(ts)
     LIMIT 100`,
    [symbol, startDate.toISOString(), endDate.toISOString()],
  );

  const ranges = res.rows.map((r) => ({
    start: r.gap_start,
    end: r.gap_end,
    missing: Number(r.missing),
  }));
  const totalMissing = ranges.reduce((sum, r) => sum + r.missing, 0);

  return { totalMissing, ranges };
}

/**
 * Get 1-minute return distribution for mark prices.
 * Returns log-returns (ln(p_t / p_{t-1})) stats.
 */
export async function getMarkPriceReturnDistribution(
  symbol: string,
  startDate: Date,
  endDate: Date,
): Promise<DistributionStats> {
  const p = getPool();
  const res = await p.query<{
    cnt: string;
    avg_val: string | null;
    std_val: string | null;
    min_val: string | null;
    p25_val: string | null;
    median_val: string | null;
    p75_val: string | null;
    max_val: string | null;
  }>(
    `WITH ordered AS (
       SELECT mark_price,
              LAG(mark_price) OVER (ORDER BY timestamp) AS prev_price
       FROM mark_prices
       WHERE symbol = $1 AND timestamp >= $2 AND timestamp < $3
     ),
     returns AS (
       SELECT LN(mark_price / prev_price) AS ret
       FROM ordered
       WHERE prev_price IS NOT NULL AND prev_price > 0 AND mark_price > 0
     )
     SELECT
       COUNT(*)::TEXT AS cnt,
       AVG(ret)::TEXT AS avg_val,
       STDDEV(ret)::TEXT AS std_val,
       MIN(ret)::TEXT AS min_val,
       PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY ret)::TEXT AS p25_val,
       PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY ret)::TEXT AS median_val,
       PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY ret)::TEXT AS p75_val,
       MAX(ret)::TEXT AS max_val
     FROM returns`,
    [symbol, startDate.toISOString(), endDate.toISOString()],
  );
  const r = res.rows[0];
  const toNum = (v: string | null) => (v === null ? 0 : Number(v));
  return {
    count: Number(r.cnt),
    mean: toNum(r.avg_val),
    std: toNum(r.std_val),
    min: toNum(r.min_val),
    p25: toNum(r.p25_val),
    median: toNum(r.median_val),
    p75: toNum(r.p75_val),
    max: toNum(r.max_val),
  };
}
