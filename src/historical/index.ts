/**
 * Historical data pipeline — public API.
 *
 * Re-exports everything consumers need.
 */

// Schema & DB
export {
  ensureHistoricalSchema,
  insertMarkPrices,
  insertLiquidations,
  insertFundingRates,
  insertOpenInterest,
  insertOneMarkPrice,
  insertOneLiquidation,
  insertOneFundingRate,
  insertOneOpenInterest,
  closePool,
} from './db.js';

// Binance historical client
export { BinanceHistoricalClient } from './client.js';

// Backfill
export {
  backfillMarkPrice,
  backfillFunding,
  backfillOpenInterest,
} from './backfill.js';

// Live ingestion
export { LiveIngestionEngine } from './ingest.js';

// Validation
export {
  validateMarkPrice,
  validateLiquidation,
  validateFundingRate,
  validateOpenInterest,
  validateMarkPriceBatch,
  validateFundingRateBatch,
  validateOpenInterestBatch,
} from './validate.js';

// Report
export { generateDataReport, printReport } from './report.js';

// Types
export type {
  MarkPriceRow,
  LiquidationRow,
  FundingRateRow,
  OpenInterestRow,
  BackfillOptions,
  IngestionConfig,
  ValidationResult,
  DataReport,
  TableStats,
  DistributionStats,
} from './types.js';
