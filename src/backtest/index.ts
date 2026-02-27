/**
 * Backtest Engine
 *
 * Evaluates the PRISM risk engine against real cascade ground-truth events.
 *
 * Architecture:
 *   Predictions — stored risk_scores (computed by CascadePredictor during live
 *                 monitoring). Each row is one evaluation point.
 *   Ground truth — cascade_events (detected by CascadeDetector from real
 *                  exchange liquidation + price data). Completely independent
 *                  data source — no circular dependency.
 *
 * For each stored risk-score minute t:
 *   predicted = risk_score >= scoreThreshold AND confidence >= confThreshold
 *   actual    = any cascade_event.start_time falls in [t, t + horizon]
 *
 * Memory efficiency:
 *   - Cascade events loaded fully (small — O(hundreds))
 *   - Risk scores paged via cursor-based pagination (can be O(millions))
 *   - Lead-time computed via running sum (no array accumulation)
 *   - Binary search for ground-truth lookups — O(log C) per evaluation point
 */

import type pg from 'pg';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface BacktestConfig {
  symbol: string;
  startTime: Date;
  endTime: Date;
  /** Risk score threshold for a positive prediction (0–100). */
  riskScoreThreshold: number;
  /** Confidence threshold for a positive prediction (0–1). */
  confidenceThreshold: number;
  /** Forward-looking window in minutes: a prediction at time t is correct
   *  if a cascade starts within [t, t + horizon]. */
  horizonMinutes: number;
}

export interface BacktestResult {
  precision: number;
  recall: number;
  f1Score: number;
  falsePositiveRate: number;
  averageLeadTimeMinutes: number;
  baselineComparison: {
    randomF1: number;
    naiveF1: number;
  };
}

export interface DetailedBacktestResult extends BacktestResult {
  confusionMatrix: ConfusionMatrix;
  totalEvaluationPoints: number;
  cascadeEventsInWindow: number;
  predictionRate: number;
  baseRate: number;
  config: BacktestConfig;
}

export interface ConfusionMatrix {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
}

export interface ThresholdSweepEntry {
  riskScoreThreshold: number;
  confidenceThreshold: number;
  result: DetailedBacktestResult;
}

// ---------------------------------------------------------------------------
// Internal row types (decoupled from db module to avoid import dependency)
// ---------------------------------------------------------------------------

interface RiskScoreEntry {
  time: Date;
  risk_score: number;
  confidence: number;
}

interface CascadeEntry {
  start_time: Date;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = 50_000;
const MS_PER_MIN = 60_000;

// ---------------------------------------------------------------------------
// Core backtest
// ---------------------------------------------------------------------------

/**
 * Run a backtest for a single symbol over a time range.
 *
 * Iterates over every stored risk-score entry within [startTime, endTime],
 * classifies it against ground-truth cascade events, and computes precision,
 * recall, F1, FPR, average lead time, and baseline comparisons.
 */
export async function runBacktest(
  pool: pg.Pool,
  config: BacktestConfig,
): Promise<DetailedBacktestResult> {
  const horizonMs = config.horizonMinutes * MS_PER_MIN;

  // 1. Load cascade events — extend end by horizon so that risk scores near
  //    the evaluation boundary can still match future cascades.
  const cascadeQueryEnd = new Date(config.endTime.getTime() + horizonMs);
  const cascades = await loadCascadeEvents(
    pool, config.symbol, config.startTime, cascadeQueryEnd,
  );

  // Pre-extract start times as ms for binary search (avoid repeated .getTime())
  const cascadeStartsMs = cascades.map((c) => c.start_time.getTime());

  // 2. Page through risk scores with cursor-based pagination
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  let leadTimeSum = 0;
  let leadTimeCount = 0;

  let cursor: Date = config.startTime;
  let isFirstPage = true;

  while (true) {
    const scores = await loadRiskScorePage(
      pool, config.symbol, cursor, config.endTime, PAGE_SIZE, isFirstPage,
    );
    if (scores.length === 0) break;

    for (const score of scores) {
      const timeMs = score.time.getTime();
      const predicted =
        score.risk_score >= config.riskScoreThreshold &&
        score.confidence >= config.confidenceThreshold;
      const match = findCascadeInHorizon(cascadeStartsMs, timeMs, horizonMs);

      if (predicted && match.found) {
        tp++;
        leadTimeSum += match.leadTimeMs;
        leadTimeCount++;
      } else if (predicted) {
        fp++;
      } else if (match.found) {
        fn++;
      } else {
        tn++;
      }
    }

    cursor = scores[scores.length - 1].time;
    isFirstPage = false;
    if (scores.length < PAGE_SIZE) break;
  }

  // 3. Metrics
  const total = tp + fp + tn + fn;
  const precision = safeDivide(tp, tp + fp);
  const recall = safeDivide(tp, tp + fn);
  const f1Score = safeDivide(2 * precision * recall, precision + recall);
  const falsePositiveRate = safeDivide(fp, fp + tn);
  const averageLeadTimeMinutes =
    leadTimeCount > 0 ? leadTimeSum / leadTimeCount / MS_PER_MIN : 0;

  // 4. Baselines
  //
  // Naive model (always predict "no cascade"):
  //   TP=0, FP=0, FN=actual_positives, TN=actual_negatives → F1 = 0
  const naiveF1 = 0;

  // Random model (predict cascade at same rate as PRISM):
  //   If PRISM predicts positive at rate p, and true positive rate is q,
  //   a random classifier with rate p has:
  //     E[Precision] = q,  E[Recall] = p,  E[F1] = 2pq/(p+q)
  const predictionRate = total > 0 ? (tp + fp) / total : 0;
  const baseRate = total > 0 ? (tp + fn) / total : 0;
  const randomF1 = safeDivide(
    2 * predictionRate * baseRate,
    predictionRate + baseRate,
  );

  return {
    precision,
    recall,
    f1Score,
    falsePositiveRate,
    averageLeadTimeMinutes,
    baselineComparison: { randomF1, naiveF1 },
    confusionMatrix: { tp, fp, tn, fn },
    totalEvaluationPoints: total,
    cascadeEventsInWindow: cascades.length,
    predictionRate,
    baseRate,
    config,
  };
}

// ---------------------------------------------------------------------------
// Multi-symbol backtest (micro-averaged)
// ---------------------------------------------------------------------------

/**
 * Run backtests across multiple symbols and micro-average the results.
 *
 * Micro-averaging sums TP/FP/TN/FN across all symbols before computing
 * metrics. This weights each evaluation point equally regardless of symbol.
 */
export async function runMultiSymbolBacktest(
  pool: pg.Pool,
  symbols: string[],
  baseConfig: Omit<BacktestConfig, 'symbol'>,
): Promise<DetailedBacktestResult & { perSymbol: Map<string, DetailedBacktestResult> }> {
  const perSymbol = new Map<string, DetailedBacktestResult>();

  let tp = 0, fp = 0, tn = 0, fn = 0;
  let leadTimeSum = 0;
  let leadTimeCount = 0;
  let totalCascades = 0;

  for (const symbol of symbols) {
    const result = await runBacktest(pool, { ...baseConfig, symbol });
    perSymbol.set(symbol, result);

    tp += result.confusionMatrix.tp;
    fp += result.confusionMatrix.fp;
    tn += result.confusionMatrix.tn;
    fn += result.confusionMatrix.fn;
    totalCascades += result.cascadeEventsInWindow;

    // Accumulate lead time via weighted contribution
    if (result.averageLeadTimeMinutes > 0 && result.confusionMatrix.tp > 0) {
      leadTimeSum += result.averageLeadTimeMinutes * result.confusionMatrix.tp;
      leadTimeCount += result.confusionMatrix.tp;
    }
  }

  const total = tp + fp + tn + fn;
  const precision = safeDivide(tp, tp + fp);
  const recall = safeDivide(tp, tp + fn);
  const f1Score = safeDivide(2 * precision * recall, precision + recall);
  const falsePositiveRate = safeDivide(fp, fp + tn);
  const averageLeadTimeMinutes =
    leadTimeCount > 0 ? leadTimeSum / leadTimeCount : 0;

  const predictionRate = total > 0 ? (tp + fp) / total : 0;
  const baseRate = total > 0 ? (tp + fn) / total : 0;
  const randomF1 = safeDivide(
    2 * predictionRate * baseRate,
    predictionRate + baseRate,
  );

  const aggregatedConfig: BacktestConfig = {
    symbol: symbols.join(','),
    startTime: baseConfig.startTime,
    endTime: baseConfig.endTime,
    riskScoreThreshold: baseConfig.riskScoreThreshold,
    confidenceThreshold: baseConfig.confidenceThreshold,
    horizonMinutes: baseConfig.horizonMinutes,
  };

  return {
    precision,
    recall,
    f1Score,
    falsePositiveRate,
    averageLeadTimeMinutes,
    baselineComparison: { randomF1, naiveF1: 0 },
    confusionMatrix: { tp, fp, tn, fn },
    totalEvaluationPoints: total,
    cascadeEventsInWindow: totalCascades,
    predictionRate,
    baseRate,
    config: aggregatedConfig,
    perSymbol,
  };
}

// ---------------------------------------------------------------------------
// Threshold sweep
// ---------------------------------------------------------------------------

/**
 * Run the backtest at multiple (scoreThreshold, confidenceThreshold) pairs.
 *
 * Useful for constructing precision-recall curves and choosing optimal
 * operating points. Cascade events are loaded once and reused — only risk
 * score pages are re-scanned per threshold pair.
 */
export async function sweepThresholds(
  pool: pg.Pool,
  symbol: string,
  startTime: Date,
  endTime: Date,
  horizonMinutes: number,
  scoreThresholds: number[],
  confidenceThresholds: number[],
): Promise<ThresholdSweepEntry[]> {
  const results: ThresholdSweepEntry[] = [];

  for (const scoreTh of scoreThresholds) {
    for (const confTh of confidenceThresholds) {
      const result = await runBacktest(pool, {
        symbol,
        startTime,
        endTime,
        riskScoreThreshold: scoreTh,
        confidenceThreshold: confTh,
        horizonMinutes,
      });
      results.push({
        riskScoreThreshold: scoreTh,
        confidenceThreshold: confTh,
        result,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Data loaders
// ---------------------------------------------------------------------------

/**
 * Load all cascade events for a symbol within a time range.
 * Cascade events are typically sparse (O(hundreds) over months),
 * so loading fully is safe.
 */
async function loadCascadeEvents(
  pool: pg.Pool,
  symbol: string,
  startTime: Date,
  endTime: Date,
): Promise<CascadeEntry[]> {
  const { rows } = await pool.query<CascadeEntry>(
    `SELECT start_time
     FROM cascade_events
     WHERE symbol = $1 AND start_time >= $2 AND start_time <= $3
     ORDER BY start_time ASC`,
    [symbol, startTime, endTime],
  );
  return rows;
}

/**
 * Load a page of risk scores using cursor-based pagination.
 *
 * Uses >= for the first page (inclusive of startTime) and > for subsequent
 * pages (exclusive of cursor to avoid re-processing the last row).
 */
async function loadRiskScorePage(
  pool: pg.Pool,
  symbol: string,
  cursor: Date,
  endTime: Date,
  limit: number,
  inclusive: boolean,
): Promise<RiskScoreEntry[]> {
  const op = inclusive ? '>=' : '>';
  const { rows } = await pool.query<RiskScoreEntry>(
    `SELECT time, risk_score, confidence
     FROM risk_scores
     WHERE symbol = $1 AND time ${op} $2 AND time <= $3
     ORDER BY time ASC
     LIMIT $4`,
    [symbol, cursor, endTime, limit],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Binary search — cascade lookup
// ---------------------------------------------------------------------------

/**
 * Given a sorted array of cascade start times (ms), determine whether any
 * cascade starts within [timeMs, timeMs + horizonMs].
 *
 * Returns the lead time (ms) to the nearest future cascade, or not-found.
 *
 * O(log C) where C = number of cascade events.
 */
function findCascadeInHorizon(
  cascadeStartsMs: number[],
  timeMs: number,
  horizonMs: number,
): { found: boolean; leadTimeMs: number } {
  const horizonEnd = timeMs + horizonMs;

  // Binary search: first index where cascadeStartsMs[i] >= timeMs
  let lo = 0;
  let hi = cascadeStartsMs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cascadeStartsMs[mid] < timeMs) lo = mid + 1;
    else hi = mid;
  }

  if (lo < cascadeStartsMs.length && cascadeStartsMs[lo] <= horizonEnd) {
    return { found: true, leadTimeMs: cascadeStartsMs[lo] - timeMs };
  }

  return { found: false, leadTimeMs: 0 };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeDivide(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}
