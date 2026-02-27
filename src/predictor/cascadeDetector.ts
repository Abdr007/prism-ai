/**
 * Liquidation Cascade Detector
 *
 * Detects statistically significant liquidation cascade events from
 * real exchange price and liquidation data streams.
 *
 * A cascade is defined as a time window where BOTH:
 *   1. Price displacement exceeds k × σ × √W  (volatility-adjusted)
 *   2. Liquidation volume exceeds the 95th percentile of recent history
 *      (or an absolute floor), with directional dominance ≥ 65%.
 *
 * Does NOT fabricate or estimate liquidation volumes.
 * Requires real liquidation feed data (e.g., Binance forceOrder, Bybit liquidation).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PricePoint {
  timestamp: number; // ms epoch
  markPrice: number;
}

export interface LiquidationEvent {
  timestamp: number; // ms epoch
  side: 'LONG' | 'SHORT';
  sizeUSD: number;
}

export interface CascadeEvent {
  symbol: string;
  direction: 'LONG_SQUEEZE' | 'SHORT_SQUEEZE';
  startTime: number; // ms epoch
  endTime: number;   // ms epoch
  priceChangePct: number;
  liquidationVolumeUSD: number;
}

export interface DetectorConfig {
  /** Detection window in minutes. Default 5. */
  windowMinutes: number;
  /** Lookback for vol & percentile estimation in minutes. Default 1440 (24h). */
  volLookbackMinutes: number;
  /** Sigma multiplier for price threshold. Default 3.0. */
  sigmaMultiplier: number;
  /** Percentile for liquidation threshold (0–1). Default 0.95. */
  liqPercentile: number;
  /** Absolute floor for liquidation threshold in USD. Default 100_000. */
  minLiqUSD: number;
  /** Minimum ratio of dominant-side liquidations. Default 0.65. */
  dominanceRatio: number;
  /** Sliding step in minutes. Default 1. */
  stepMinutes: number;
}

const DEFAULT_CONFIG: DetectorConfig = {
  windowMinutes: 5,
  volLookbackMinutes: 1440,
  sigmaMultiplier: 3.0,
  liqPercentile: 0.95,
  minLiqUSD: 100_000,
  dominanceRatio: 0.65,
  stepMinutes: 1,
};

const MINUTES_PER_YEAR = 525_960; // 365.25 × 24 × 60
const MS_PER_MIN = 60_000;

// ---------------------------------------------------------------------------
// Core detection
// ---------------------------------------------------------------------------

export function detectCascades(
  symbol: string,
  priceSeries: PricePoint[],
  liquidationSeries: LiquidationEvent[],
  configOverrides: Partial<DetectorConfig> = {},
): CascadeEvent[] {
  const cfg = { ...DEFAULT_CONFIG, ...configOverrides };

  if (priceSeries.length < 2) return [];

  // Sort inputs by timestamp (defensive — callers should pre-sort)
  const prices = [...priceSeries].sort((a, b) => a.timestamp - b.timestamp);
  const liqs = [...liquidationSeries].sort((a, b) => a.timestamp - b.timestamp);

  const windowMs = cfg.windowMinutes * MS_PER_MIN;
  const stepMs = cfg.stepMinutes * MS_PER_MIN;
  const lookbackMs = cfg.volLookbackMinutes * MS_PER_MIN;

  const tMin = prices[0].timestamp;
  const tMax = prices[prices.length - 1].timestamp;

  // Pre-compute log returns for volatility estimation
  const logReturns = computeLogReturns(prices);

  // Sliding window detection
  const candidates: RawCandidate[] = [];

  for (let t = tMin; t + windowMs <= tMax; t += stepMs) {
    const tEnd = t + windowMs;

    // --- Price displacement ---
    const pStart = interpolatePrice(prices, t);
    const pEnd = interpolatePrice(prices, tEnd);
    if (pStart === null || pEnd === null || pStart === 0) continue;

    const deltaP = (pEnd - pStart) / pStart; // fractional change

    // --- Realized volatility (trailing lookback, annualized) ---
    const sigma = computeTrailingVol(logReturns, t, lookbackMs);
    if (sigma === 0) continue;

    // Convert annualized vol to per-minute, scale by √W
    const sigmaPerMin = sigma / Math.sqrt(MINUTES_PER_YEAR);
    const priceThreshold = cfg.sigmaMultiplier * sigmaPerMin * Math.sqrt(cfg.windowMinutes);

    if (Math.abs(deltaP) < priceThreshold) continue;

    // --- Liquidation volume in window ---
    const { longVol, shortVol } = sumLiquidationsInWindow(liqs, t, tEnd);
    const totalLiq = longVol + shortVol;

    // --- Liquidation percentile threshold ---
    const liqThreshold = computeLiqThreshold(
      liqs, t, lookbackMs, windowMs, cfg.liqPercentile, cfg.minLiqUSD,
    );

    if (totalLiq < liqThreshold) continue;

    // --- Directional dominance ---
    const dominantVol = Math.max(longVol, shortVol);
    if (totalLiq > 0 && dominantVol / totalLiq < cfg.dominanceRatio) continue;

    const direction: CascadeEvent['direction'] =
      longVol > shortVol ? 'LONG_SQUEEZE' : 'SHORT_SQUEEZE';

    candidates.push({
      startTime: t,
      endTime: tEnd,
      priceChangePct: deltaP * 100,
      liquidationVolumeUSD: totalLiq,
      direction,
    });
  }

  // Merge overlapping / adjacent candidates
  const merged = mergeCandidates(candidates, prices, liqs);

  return merged.map((c) => ({
    symbol,
    direction: c.direction,
    startTime: c.startTime,
    endTime: c.endTime,
    priceChangePct: c.priceChangePct,
    liquidationVolumeUSD: c.liquidationVolumeUSD,
  }));
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface RawCandidate {
  startTime: number;
  endTime: number;
  priceChangePct: number;
  liquidationVolumeUSD: number;
  direction: CascadeEvent['direction'];
}

interface LogReturn {
  timestamp: number;
  value: number;
}

/**
 * Compute log returns from consecutive price points.
 */
function computeLogReturns(prices: PricePoint[]): LogReturn[] {
  const returns: LogReturn[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1].markPrice > 0) {
      returns.push({
        timestamp: prices[i].timestamp,
        value: Math.log(prices[i].markPrice / prices[i - 1].markPrice),
      });
    }
  }
  return returns;
}

/**
 * Trailing realized volatility (annualized) ending at time `t`.
 * Uses close-to-close estimator: σ = √(1/N · Σ rᵢ²) × √(minutes_per_year).
 */
function computeTrailingVol(
  logReturns: LogReturn[],
  t: number,
  lookbackMs: number,
): number {
  const tStart = t - lookbackMs;
  let sumSq = 0;
  let count = 0;

  // Binary search for start position
  let lo = 0;
  let hi = logReturns.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (logReturns[mid].timestamp < tStart) lo = mid + 1;
    else hi = mid;
  }

  for (let i = lo; i < logReturns.length; i++) {
    if (logReturns[i].timestamp > t) break;
    sumSq += logReturns[i].value * logReturns[i].value;
    count++;
  }

  if (count < 30) return 0; // insufficient data for reliable estimate

  const variancePerInterval = sumSq / count;
  // Annualize: multiply by √(minutes_per_year)
  return Math.sqrt(variancePerInterval) * Math.sqrt(MINUTES_PER_YEAR);
}

/**
 * Linear interpolation of price at an arbitrary timestamp.
 */
function interpolatePrice(prices: PricePoint[], t: number): number | null {
  if (prices.length === 0) return null;
  if (t <= prices[0].timestamp) return prices[0].markPrice;
  if (t >= prices[prices.length - 1].timestamp) return prices[prices.length - 1].markPrice;

  // Binary search for the interval containing t
  let lo = 0;
  let hi = prices.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >>> 1;
    if (prices[mid].timestamp <= t) lo = mid;
    else hi = mid;
  }

  const p0 = prices[lo];
  const p1 = prices[hi];
  const dt = p1.timestamp - p0.timestamp;
  if (dt === 0) return p0.markPrice;

  const frac = (t - p0.timestamp) / dt;
  return p0.markPrice + frac * (p1.markPrice - p0.markPrice);
}

/**
 * Sum liquidation volumes (by side) within [tStart, tEnd).
 */
function sumLiquidationsInWindow(
  liqs: LiquidationEvent[],
  tStart: number,
  tEnd: number,
): { longVol: number; shortVol: number } {
  let longVol = 0;
  let shortVol = 0;

  // Binary search for start position
  let lo = 0;
  let hi = liqs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (liqs[mid].timestamp < tStart) lo = mid + 1;
    else hi = mid;
  }

  for (let i = lo; i < liqs.length; i++) {
    if (liqs[i].timestamp >= tEnd) break;
    if (liqs[i].side === 'LONG') longVol += liqs[i].sizeUSD;
    else shortVol += liqs[i].sizeUSD;
  }

  return { longVol, shortVol };
}

/**
 * Compute the liquidation volume threshold: 95th percentile of
 * trailing W-minute buckets over the lookback period, floored at minUSD.
 */
function computeLiqThreshold(
  liqs: LiquidationEvent[],
  t: number,
  lookbackMs: number,
  windowMs: number,
  percentile: number,
  minUSD: number,
): number {
  const tLookbackStart = t - lookbackMs;

  // Bucket liquidation volumes into non-overlapping windows
  const buckets: number[] = [];
  for (let bucketStart = tLookbackStart; bucketStart + windowMs <= t; bucketStart += windowMs) {
    const { longVol, shortVol } = sumLiquidationsInWindow(liqs, bucketStart, bucketStart + windowMs);
    buckets.push(longVol + shortVol);
  }

  if (buckets.length < 10) {
    // Not enough history — use absolute floor only
    return minUSD;
  }

  const p = quantile(buckets, percentile);
  return Math.max(p, minUSD);
}

/**
 * Compute the q-th quantile of a numeric array (linear interpolation).
 */
function quantile(arr: number[], q: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const frac = pos - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/**
 * Merge overlapping or adjacent raw candidates into consolidated events.
 * Recalculates price change and liquidation volume over the merged span.
 */
function mergeCandidates(
  candidates: RawCandidate[],
  prices: PricePoint[],
  liqs: LiquidationEvent[],
): RawCandidate[] {
  if (candidates.length === 0) return [];

  // Sort by startTime
  const sorted = [...candidates].sort((a, b) => a.startTime - b.startTime);

  const merged: RawCandidate[] = [];
  let current = { ...sorted[0] };

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];

    // Merge if overlapping or adjacent AND same direction
    if (next.startTime <= current.endTime && next.direction === current.direction) {
      current.endTime = Math.max(current.endTime, next.endTime);
    } else {
      merged.push(current);
      current = { ...next };
    }
  }
  merged.push(current);

  // Recalculate metrics over the full merged span
  for (const event of merged) {
    const pStart = interpolatePrice(prices, event.startTime);
    const pEnd = interpolatePrice(prices, event.endTime);
    if (pStart && pEnd && pStart !== 0) {
      event.priceChangePct = ((pEnd - pStart) / pStart) * 100;
    }

    const { longVol, shortVol } = sumLiquidationsInWindow(liqs, event.startTime, event.endTime);
    event.liquidationVolumeUSD = longVol + shortVol;
  }

  return merged;
}
