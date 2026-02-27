/**
 * Historical data pipeline — shared types.
 *
 * Every type maps 1:1 to a database row. No synthetic fields.
 */

// ---------------------------------------------------------------------------
// Database row types
// ---------------------------------------------------------------------------

export interface MarkPriceRow {
  symbol: string;
  timestamp: Date;
  mark_price: number;
}

export interface LiquidationRow {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  usd_value: number;
  timestamp: Date;
}

export interface FundingRateRow {
  symbol: string;
  funding_time: Date;
  funding_rate: number;
}

export interface OpenInterestRow {
  symbol: string;
  timestamp: Date;
  open_interest_usd: number;
}

// ---------------------------------------------------------------------------
// Binance API response types
// ---------------------------------------------------------------------------

/** GET /fapi/v1/klines — mark price kline */
export interface BinanceKline {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  closeTime: number;
  quoteAssetVolume: string;
  numberOfTrades: number;
  takerBuyBaseVolume: string;
  takerBuyQuoteVolume: string;
}

/** GET /fapi/v1/markPriceKlines */
export interface BinanceMarkPriceKline {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  closeTime: number;
}

/** GET /fapi/v1/fundingRate */
export interface BinanceFundingRate {
  symbol: string;
  fundingTime: number;
  fundingRate: string;
  markPrice: string;
}

/** GET /futures/data/openInterestHist */
export interface BinanceOpenInterestHist {
  symbol: string;
  sumOpenInterest: string;
  sumOpenInterestValue: string;
  timestamp: number;
}

/** WebSocket forceOrder stream */
export interface BinanceForceOrder {
  e: 'forceOrder';
  E: number;
  o: {
    s: string;   // symbol
    S: string;   // side: BUY | SELL
    o: string;   // order type
    f: string;   // time in force
    q: string;   // quantity
    p: string;   // price
    ap: string;  // average price
    X: string;   // order status
    l: string;   // last filled quantity
    z: string;   // cumulative filled quantity
    T: number;   // trade time
  };
}

/** WebSocket markPrice stream */
export interface BinanceMarkPriceWs {
  e: 'markPriceUpdate';
  E: number;    // event time
  s: string;    // symbol
  p: string;    // mark price
  i: string;    // index price  (unused here but present)
  P: string;    // estimated settle price
  r: string;    // funding rate
  T: number;    // next funding time
}

// ---------------------------------------------------------------------------
// Backfill options
// ---------------------------------------------------------------------------

export interface BackfillOptions {
  symbol: string;
  startDate: Date;
  endDate: Date;
  /** Batch size for DB inserts. Default 1000. */
  batchSize?: number;
}

// ---------------------------------------------------------------------------
// Live ingestion config
// ---------------------------------------------------------------------------

export interface IngestionConfig {
  /** Symbols to ingest. Default: ['BTCUSDT','ETHUSDT','SOLUSDT'] */
  symbols: string[];
  /** OI polling interval in ms. Default: 60_000 */
  oiIntervalMs: number;
  /** Funding rate polling interval in ms. Default: 60_000 */
  fundingIntervalMs: number;
  /** WebSocket reconnect base delay in ms. Default: 1_000 */
  wsReconnectBaseMs: number;
  /** WebSocket reconnect max delay in ms. Default: 60_000 */
  wsReconnectMaxMs: number;
  /** WebSocket heartbeat interval in ms. Default: 30_000 */
  wsHeartbeatMs: number;
}

export const DEFAULT_INGESTION_CONFIG: IngestionConfig = {
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  oiIntervalMs: 60_000,
  fundingIntervalMs: 60_000,
  wsReconnectBaseMs: 1_000,
  wsReconnectMaxMs: 60_000,
  wsHeartbeatMs: 30_000,
};

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Data report
// ---------------------------------------------------------------------------

export interface DataReport {
  symbol: string;
  period: { start: string; end: string; days: number };
  tables: {
    mark_prices: TableStats;
    liquidations: TableStats;
    funding_rates: TableStats;
    open_interest: TableStats;
  };
  gaps: {
    mark_price_missing_minutes: number;
    mark_price_gap_ranges: Array<{ start: string; end: string; missing: number }>;
  };
  distributions: {
    liquidation_volume: DistributionStats;
    mark_price_returns: DistributionStats;
    funding_rate: DistributionStats;
    open_interest_usd: DistributionStats;
  };
}

export interface TableStats {
  total_rows: number;
  earliest: string | null;
  latest: string | null;
}

export interface DistributionStats {
  count: number;
  mean: number;
  std: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
}
