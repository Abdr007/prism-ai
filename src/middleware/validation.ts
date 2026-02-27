/**
 * Phase 5 — Data Validation Middleware
 *
 * Reusable validation layer that validates exchange data BEFORE it enters
 * the aggregation pipeline.
 *
 * Rules:
 *   - markPrice within ±5% of indexPrice
 *   - fundingRate within -5% to +5%
 *   - openInterest > 0 when volume > 0
 *   - timestamp < 15 seconds old
 *   - All numeric fields finite
 *
 * On failure:
 *   - Log structured JSON error
 *   - Emit anomaly event
 *   - Do NOT crash
 */

import { EventEmitter } from 'events';
import { logger as rootLogger } from '../lib/logger.js';
import type { ExchangeData, OpenInterest, FundingRate, MarkPrice } from '../exchanges/types.js';

const log = rootLogger.child({ component: 'data-validator' });

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ValidationConfig {
  /** Max allowed deviation: |markPrice - indexPrice| / indexPrice. Default: 0.05 (5%) */
  maxPriceDeviation: number;
  /** Max absolute funding rate (decimal). Default: 0.05 (5%) */
  maxFundingRate: number;
  /** Max staleness of timestamp in ms. Default: 15000 (15s) */
  maxStalenessMs: number;
}

const DEFAULT_VALIDATION_CONFIG: ValidationConfig = {
  maxPriceDeviation: 0.05,
  maxFundingRate: 0.05,
  maxStalenessMs: 15_000,
};

// ---------------------------------------------------------------------------
// Anomaly Event
// ---------------------------------------------------------------------------

export interface AnomalyEvent {
  exchange: string;
  symbol: string;
  field: string;
  value: unknown;
  rule: string;
  detail: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

export class DataValidator extends EventEmitter {
  private readonly cfg: ValidationConfig;

  constructor(config?: Partial<ValidationConfig>) {
    super();
    this.cfg = { ...DEFAULT_VALIDATION_CONFIG, ...config };
  }

  /**
   * Validate and filter an ExchangeData object.
   * Returns a cleaned copy with invalid entries removed.
   * Never throws — logs and emits anomaly events.
   */
  validate(data: ExchangeData): ExchangeData {
    const now = Date.now();

    return {
      exchange: data.exchange,
      openInterest: data.openInterest.filter((oi) => this.validateOI(oi, now)),
      fundingRates: data.fundingRates.filter((fr) => this.validateFunding(fr, now)),
      markPrices: data.markPrices.filter((mp) => this.validateMarkPrice(mp, now)),
      timestamp: data.timestamp,
    };
  }

  /**
   * Validate a batch of ExchangeData.
   * Exchanges with no surviving data after validation are excluded entirely.
   */
  validateBatch(dataArr: ExchangeData[]): ExchangeData[] {
    const validated: ExchangeData[] = [];

    for (const d of dataArr) {
      const clean = this.validate(d);
      const hasData =
        clean.openInterest.length > 0 ||
        clean.fundingRates.length > 0 ||
        clean.markPrices.length > 0;

      if (hasData) {
        validated.push(clean);
      } else {
        log.warn(
          { exchange: d.exchange, originalOI: d.openInterest.length, originalFR: d.fundingRates.length, originalMP: d.markPrices.length },
          'Exchange excluded — all data failed validation',
        );
      }
    }

    return validated;
  }

  // -----------------------------------------------------------------------
  // Field validators
  // -----------------------------------------------------------------------

  private validateOI(oi: OpenInterest, now: number): boolean {
    // All numeric fields must be finite
    if (!this.isFinite(oi.openInterest, oi.exchange, oi.symbol, 'openInterest')) return false;
    if (!this.isFinite(oi.openInterestValue, oi.exchange, oi.symbol, 'openInterestValue')) return false;

    // Staleness check
    if (!this.isFresh(oi.timestamp, now, oi.exchange, oi.symbol, 'openInterest.timestamp')) return false;

    return true;
  }

  private validateFunding(fr: FundingRate, now: number): boolean {
    if (!this.isFinite(fr.fundingRate, fr.exchange, fr.symbol, 'fundingRate')) return false;

    // Funding rate within bounds
    if (Math.abs(fr.fundingRate) > this.cfg.maxFundingRate) {
      this.reportAnomaly(fr.exchange, fr.symbol, 'fundingRate', fr.fundingRate,
        'FUNDING_OUT_OF_RANGE',
        `|${fr.fundingRate}| > ${this.cfg.maxFundingRate} (${(this.cfg.maxFundingRate * 100).toFixed(0)}%)`,
      );
      return false;
    }

    if (!this.isFresh(fr.timestamp, now, fr.exchange, fr.symbol, 'fundingRate.timestamp')) return false;

    return true;
  }

  private validateMarkPrice(mp: MarkPrice, now: number): boolean {
    if (!this.isFinite(mp.markPrice, mp.exchange, mp.symbol, 'markPrice')) return false;
    if (!this.isFinite(mp.indexPrice, mp.exchange, mp.symbol, 'indexPrice')) return false;

    // markPrice within ±5% of indexPrice
    if (mp.markPrice > 0 && mp.indexPrice > 0) {
      const deviation = Math.abs(mp.markPrice - mp.indexPrice) / mp.indexPrice;
      if (deviation > this.cfg.maxPriceDeviation) {
        this.reportAnomaly(mp.exchange, mp.symbol, 'markPrice', mp.markPrice,
          'MARK_INDEX_DEVIATION',
          `Deviation ${(deviation * 100).toFixed(2)}% exceeds ${(this.cfg.maxPriceDeviation * 100).toFixed(0)}% (mark=${mp.markPrice}, index=${mp.indexPrice})`,
        );
        return false;
      }
    }

    if (!this.isFresh(mp.timestamp, now, mp.exchange, mp.symbol, 'markPrice.timestamp')) return false;

    return true;
  }

  // -----------------------------------------------------------------------
  // Check helpers
  // -----------------------------------------------------------------------

  private isFinite(value: number, exchange: string, symbol: string, field: string): boolean {
    if (value === null || value === undefined || !Number.isFinite(value)) {
      this.reportAnomaly(exchange, symbol, field, value, 'NOT_FINITE', `Value is not a finite number: ${value}`);
      return false;
    }
    return true;
  }

  private isFresh(timestamp: number, now: number, exchange: string, symbol: string, field: string): boolean {
    if (!Number.isFinite(timestamp)) {
      this.reportAnomaly(exchange, symbol, field, timestamp, 'INVALID_TIMESTAMP', 'Timestamp is not finite');
      return false;
    }
    const age = now - timestamp;
    if (age > this.cfg.maxStalenessMs) {
      this.reportAnomaly(exchange, symbol, field, timestamp, 'STALE_DATA',
        `Data is ${(age / 1000).toFixed(1)}s old (max: ${(this.cfg.maxStalenessMs / 1000).toFixed(0)}s)`,
      );
      return false;
    }
    return true;
  }

  // -----------------------------------------------------------------------
  // Anomaly reporting
  // -----------------------------------------------------------------------

  private reportAnomaly(
    exchange: string,
    symbol: string,
    field: string,
    value: unknown,
    rule: string,
    detail: string,
  ): void {
    const event: AnomalyEvent = {
      exchange,
      symbol,
      field,
      value,
      rule,
      detail,
      timestamp: Date.now(),
    };

    log.warn({ anomaly: event }, `Validation failed: ${rule}`);
    this.emit('anomaly', event);
  }
}
