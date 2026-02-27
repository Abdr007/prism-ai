/**
 * Phase 3 — Historical Backfill
 *
 * Pulls real historical data from Binance Futures REST API and inserts
 * into PostgreSQL. All inserts are idempotent (ON CONFLICT DO NOTHING).
 *
 * Functions:
 *   backfillMarkPrice(symbol, startDate, endDate)
 *   backfillFunding(symbol, startDate, endDate)
 *   backfillOpenInterest(symbol, startDate, endDate)
 *
 * Liquidation limitation documented at bottom.
 */

import { BinanceHistoricalClient } from './client.js';
import {
  ensureHistoricalSchema,
  insertMarkPrices,
  insertFundingRates,
  insertOpenInterest,
  closePool,
} from './db.js';
import { logger as rootLogger } from '../lib/logger.js';
import type { BackfillOptions } from './types.js';

const log = rootLogger.child({ component: 'backfill' });

const client = new BinanceHistoricalClient();

// ---------------------------------------------------------------------------
// Mark Price Backfill
// ---------------------------------------------------------------------------

/**
 * Backfill mark_prices from Binance markPriceKlines endpoint.
 * Uses 1-minute kline close price.
 * Idempotent — safe to re-run for the same time range.
 */
export async function backfillMarkPrice(opts: BackfillOptions): Promise<number> {
  const { symbol, startDate, endDate, batchSize = 1000 } = opts;
  log.info({ symbol, start: startDate.toISOString(), end: endDate.toISOString() }, 'Starting mark price backfill');

  const klines = await client.fetchMarkPriceKlines(
    symbol,
    startDate.getTime(),
    endDate.getTime(),
  );

  const rows = klines.map((k) => ({
    symbol,
    timestamp: k.timestamp,
    markPrice: k.markPrice,
  }));

  const inserted = await insertMarkPrices(rows, batchSize);
  log.info({ symbol, fetched: rows.length, inserted }, 'Mark price backfill complete');
  return inserted;
}

// ---------------------------------------------------------------------------
// Funding Rate Backfill
// ---------------------------------------------------------------------------

/**
 * Backfill funding_rates from Binance fundingRate endpoint.
 * Binance publishes funding every 8 hours.
 * Idempotent — safe to re-run.
 */
export async function backfillFunding(opts: BackfillOptions): Promise<number> {
  const { symbol, startDate, endDate, batchSize = 1000 } = opts;
  log.info({ symbol, start: startDate.toISOString(), end: endDate.toISOString() }, 'Starting funding rate backfill');

  const rates = await client.fetchFundingRates(
    symbol,
    startDate.getTime(),
    endDate.getTime(),
  );

  const rows = rates.map((r) => ({
    symbol,
    fundingTime: r.fundingTime,
    fundingRate: r.fundingRate,
  }));

  const inserted = await insertFundingRates(rows, batchSize);
  log.info({ symbol, fetched: rows.length, inserted }, 'Funding rate backfill complete');
  return inserted;
}

// ---------------------------------------------------------------------------
// Open Interest Backfill
// ---------------------------------------------------------------------------

/**
 * Backfill open_interest from Binance openInterestHist endpoint.
 *
 * NOTE: Binance historical OI endpoint minimum granularity is 5 minutes.
 * The 1-minute granularity is only available via live polling (Phase 4).
 * For backfill, 5m is used — this is real exchange data, not interpolated.
 */
export async function backfillOpenInterest(
  opts: BackfillOptions,
  period: '5m' | '15m' | '30m' | '1h' | '4h' | '1d' = '5m',
): Promise<number> {
  const { symbol, startDate, endDate, batchSize = 1000 } = opts;
  log.info({ symbol, period, start: startDate.toISOString(), end: endDate.toISOString() }, 'Starting OI backfill');

  const hist = await client.fetchOpenInterestHistory(
    symbol,
    startDate.getTime(),
    endDate.getTime(),
    period,
  );

  const rows = hist.map((h) => ({
    symbol,
    timestamp: h.timestamp,
    openInterestUsd: h.openInterestUsd,
  }));

  const inserted = await insertOpenInterest(rows, batchSize);
  log.info({ symbol, fetched: rows.length, inserted }, 'OI backfill complete');
  return inserted;
}

// ---------------------------------------------------------------------------
// Liquidation Backfill — LIMITATION
// ---------------------------------------------------------------------------

/**
 * HISTORICAL LIQUIDATION BACKFILL IS NOT POSSIBLE VIA BINANCE REST API.
 *
 * Binance does not provide a historical liquidation endpoint.
 * The /fapi/v1/allForceOrders endpoint only returns recent liquidations
 * (last ~1 hour, no startTime/endTime support for historical queries).
 *
 * Workarounds:
 *
 * 1. FORWARD COLLECTION (recommended):
 *    Use the live WebSocket ingestion (Phase 4) to collect liquidation
 *    events going forward. The stream is: wss://fstream.binance.com/ws/!forceOrder@arr
 *    This is the primary approach implemented in ingest.ts.
 *
 * 2. THIRD-PARTY ARCHIVAL SOURCES:
 *    - Coinalyze (coinalyze.net) — historical liquidation data, paid API
 *    - Laevitas (laevitas.ch) — derivatives analytics with liquidation history
 *    - CoinGlass (coinglass.com) — liquidation data API, freemium
 *    - Tardis.dev — raw exchange WebSocket data replay (most comprehensive)
 *
 *    Tardis.dev is the institutional-grade option: it replays the raw
 *    Binance WebSocket feed for any historical date, including forceOrder.
 *    Integration would involve their replay API or downloadable datasets.
 *
 * 3. INFERRED LIQUIDATIONS (not recommended):
 *    Some approaches attempt to infer liquidations from large market orders
 *    on the tape. This produces estimates, not real data. We do not implement
 *    this because the objective explicitly forbids approximations.
 *
 * The schema and insert functions for liquidations are ready in db.ts.
 * Once a data source is connected, use insertLiquidations() or
 * insertOneLiquidation() to persist.
 */

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const symbol = args[0] || 'BTCUSDT';
  const daysBack = Number(args[1]) || 30;

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - daysBack * 24 * 60 * 60 * 1000);

  log.info({ symbol, daysBack, start: startDate.toISOString(), end: endDate.toISOString() }, 'Backfill starting');

  await ensureHistoricalSchema();

  const opts: BackfillOptions = { symbol, startDate, endDate };

  // Run sequentially to respect rate limits
  await backfillMarkPrice(opts);
  await backfillFunding(opts);
  await backfillOpenInterest(opts);

  log.info('Backfill complete for all datasets');
  await closePool();
}

// Run if executed directly
const isMain = process.argv[1]?.includes('backfill');
if (isMain) {
  main().catch((err) => {
    log.error({ err: err instanceof Error ? err.message : err }, 'Backfill failed');
    process.exit(1);
  });
}
