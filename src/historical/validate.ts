/**
 * Phase 5 — Data Validation Layer
 *
 * Pre-insert validation for all historical data types.
 * Rejects anomalous rows and logs reasons. Never throws —
 * returns ValidationResult with pass/fail + reason.
 *
 * Rules:
 *  - Mark price: reject >20% jump within 1 minute
 *  - Open interest: reject negative values
 *  - Funding rate: reject outside [-5%, +5%] (i.e. -0.05 to 0.05)
 *  - Timestamp: reject future timestamps, enforce ordering
 *  - All numerics: reject NaN, Infinity
 */

import { logger as rootLogger } from '../lib/logger.js';
import type { ValidationResult } from './types.js';

const log = rootLogger.child({ component: 'data-validation' });

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Maximum allowed 1-minute mark price change (20%). */
const MAX_MARK_PRICE_CHANGE_PCT = 0.20;

/** Minimum funding rate (-5%). */
const MIN_FUNDING_RATE = -0.05;

/** Maximum funding rate (+5%). */
const MAX_FUNDING_RATE = 0.05;

/** Maximum allowed future timestamp offset (5 minutes tolerance for clock skew). */
const MAX_FUTURE_OFFSET_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Numeric guards
// ---------------------------------------------------------------------------

function isFinitePositive(val: number): boolean {
  return Number.isFinite(val) && val > 0;
}

function isFiniteNonNegative(val: number): boolean {
  return Number.isFinite(val) && val >= 0;
}

function isFiniteNumber(val: number): boolean {
  return Number.isFinite(val);
}

// ---------------------------------------------------------------------------
// Mark Price Validation
// ---------------------------------------------------------------------------

export function validateMarkPrice(
  markPrice: number,
  timestamp: Date,
  prevMarkPrice: number | null,
): ValidationResult {
  if (!isFinitePositive(markPrice)) {
    return { valid: false, reason: `mark_price not finite-positive: ${markPrice}` };
  }

  if (timestamp.getTime() > Date.now() + MAX_FUTURE_OFFSET_MS) {
    return { valid: false, reason: `timestamp in future: ${timestamp.toISOString()}` };
  }

  if (prevMarkPrice !== null && prevMarkPrice > 0) {
    const changePct = Math.abs(markPrice - prevMarkPrice) / prevMarkPrice;
    if (changePct > MAX_MARK_PRICE_CHANGE_PCT) {
      return {
        valid: false,
        reason: `mark_price jump ${(changePct * 100).toFixed(2)}% exceeds ${MAX_MARK_PRICE_CHANGE_PCT * 100}% threshold (${prevMarkPrice} → ${markPrice})`,
      };
    }
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Liquidation Validation
// ---------------------------------------------------------------------------

export function validateLiquidation(
  price: number,
  quantity: number,
  usdValue: number,
  side: string,
  timestamp: Date,
): ValidationResult {
  if (!isFinitePositive(price)) {
    return { valid: false, reason: `liquidation price not finite-positive: ${price}` };
  }

  if (!isFinitePositive(quantity)) {
    return { valid: false, reason: `liquidation quantity not finite-positive: ${quantity}` };
  }

  if (!isFinitePositive(usdValue)) {
    return { valid: false, reason: `liquidation usd_value not finite-positive: ${usdValue}` };
  }

  if (side !== 'BUY' && side !== 'SELL') {
    return { valid: false, reason: `liquidation side invalid: ${side}` };
  }

  if (timestamp.getTime() > Date.now() + MAX_FUTURE_OFFSET_MS) {
    return { valid: false, reason: `liquidation timestamp in future: ${timestamp.toISOString()}` };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Funding Rate Validation
// ---------------------------------------------------------------------------

export function validateFundingRate(
  fundingRate: number,
  fundingTime: Date,
): ValidationResult {
  if (!isFiniteNumber(fundingRate)) {
    return { valid: false, reason: `funding_rate not finite: ${fundingRate}` };
  }

  if (fundingRate < MIN_FUNDING_RATE || fundingRate > MAX_FUNDING_RATE) {
    return {
      valid: false,
      reason: `funding_rate ${fundingRate} outside [${MIN_FUNDING_RATE}, ${MAX_FUNDING_RATE}]`,
    };
  }

  if (fundingTime.getTime() > Date.now() + MAX_FUTURE_OFFSET_MS) {
    return { valid: false, reason: `funding_time in future: ${fundingTime.toISOString()}` };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Open Interest Validation
// ---------------------------------------------------------------------------

export function validateOpenInterest(
  openInterestUsd: number,
  timestamp: Date,
): ValidationResult {
  if (!isFiniteNonNegative(openInterestUsd)) {
    return { valid: false, reason: `open_interest_usd not finite-non-negative: ${openInterestUsd}` };
  }

  if (openInterestUsd < 0) {
    return { valid: false, reason: `open_interest_usd negative: ${openInterestUsd}` };
  }

  if (timestamp.getTime() > Date.now() + MAX_FUTURE_OFFSET_MS) {
    return { valid: false, reason: `OI timestamp in future: ${timestamp.toISOString()}` };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Batch validation with logging
// ---------------------------------------------------------------------------

/**
 * Validate and filter an array of mark prices. Returns only valid rows.
 * Logs each rejected row as a warning.
 */
export function validateMarkPriceBatch(
  rows: Array<{ symbol: string; timestamp: Date; markPrice: number }>,
): Array<{ symbol: string; timestamp: Date; markPrice: number }> {
  const valid: typeof rows = [];
  let prevPrice: number | null = null;
  let rejected = 0;

  // Sort by timestamp to enable sequential price-jump detection
  const sorted = [...rows].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  for (const row of sorted) {
    const result = validateMarkPrice(row.markPrice, row.timestamp, prevPrice);
    if (result.valid) {
      valid.push(row);
      prevPrice = row.markPrice;
    } else {
      rejected++;
      log.warn({ symbol: row.symbol, ts: row.timestamp.toISOString(), reason: result.reason }, 'Mark price rejected');
      // Do NOT update prevPrice on rejection — next row compares against last valid
    }
  }

  if (rejected > 0) {
    log.info({ total: rows.length, valid: valid.length, rejected }, 'Mark price batch validation');
  }
  return valid;
}

/**
 * Validate and filter funding rates. Returns only valid rows.
 */
export function validateFundingRateBatch(
  rows: Array<{ symbol: string; fundingTime: Date; fundingRate: number }>,
): Array<{ symbol: string; fundingTime: Date; fundingRate: number }> {
  const valid: typeof rows = [];
  let rejected = 0;

  for (const row of rows) {
    const result = validateFundingRate(row.fundingRate, row.fundingTime);
    if (result.valid) {
      valid.push(row);
    } else {
      rejected++;
      log.warn({ symbol: row.symbol, ts: row.fundingTime.toISOString(), reason: result.reason }, 'Funding rate rejected');
    }
  }

  if (rejected > 0) {
    log.info({ total: rows.length, valid: valid.length, rejected }, 'Funding rate batch validation');
  }
  return valid;
}

/**
 * Validate and filter open interest rows. Returns only valid rows.
 */
export function validateOpenInterestBatch(
  rows: Array<{ symbol: string; timestamp: Date; openInterestUsd: number }>,
): Array<{ symbol: string; timestamp: Date; openInterestUsd: number }> {
  const valid: typeof rows = [];
  let rejected = 0;

  for (const row of rows) {
    const result = validateOpenInterest(row.openInterestUsd, row.timestamp);
    if (result.valid) {
      valid.push(row);
    } else {
      rejected++;
      log.warn({ symbol: row.symbol, ts: row.timestamp.toISOString(), reason: result.reason }, 'OI rejected');
    }
  }

  if (rejected > 0) {
    log.info({ total: rows.length, valid: valid.length, rejected }, 'OI batch validation');
  }
  return valid;
}
