/**
 * Probability Calibration & Uncertainty Estimation
 *
 * Replaces the arbitrary sigmoid(score, midpoint=50, steepness=0.1) with
 * logistic regression parameters fitted from historical data.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CALIBRATION MODEL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Model:
 *   P(cascade within horizon | riskScore = s) = σ(a + b·s)
 *   where σ(z) = 1 / (1 + exp(−z))
 *
 * Parameters:
 *   a = intercept  — log-odds of cascade when score = 0
 *   b = coefficient — marginal change in log-odds per score point
 *
 * Fitting method: IRLS (Iteratively Reweighted Least Squares)
 *   - Equivalent to Newton-Raphson on the log-likelihood
 *   - L2 regularization prevents divergence under perfect separation
 *   - Operates on binned counts (101 bins for scores 0–100), O(1) memory
 *   - Converges in 5–15 iterations for this 1D problem
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * UNCERTAINTY ESTIMATION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two methods provided:
 *
 * 1. Wald interval on logistic scale (primary):
 *    - Uses the covariance matrix Cov(a,b) = −H⁻¹ from the IRLS fit
 *    - Var(a + b·s) = Var(a) + 2·s·Cov(a,b) + s²·Var(b)
 *    - CI on log-odds: (a + b·s) ± z_α/2 · SE
 *    - CI on probability: σ(lower_logit), σ(upper_logit)
 *    - Deterministic, asymptotically exact, standard for GLMs
 *
 * 2. Wilson score interval (alternative):
 *    - Direct binomial interval on empirical P(cascade | score = s)
 *    - Uses per-bin counts, no model assumption
 *    - Better for small samples, handles p ≈ 0 or p ≈ 1 correctly
 *    - Requires stored bin data
 *
 * Statistical assumptions:
 *   - Risk scores are computed from market features (Layer 1–2 of cascade.ts)
 *   - Cascade events are detected independently from liquidation + price data
 *   - Adjacent minutes are serially correlated, so the effective sample size
 *     is smaller than N. Confidence intervals should be interpreted as
 *     approximate. For rigorous inference, use block bootstrap (not yet impl).
 *   - The logistic link is assumed correct (monotone S-curve relationship
 *     between score and cascade probability). This is validated by checking
 *     that the fitted coefficient b > 0.
 *
 * No circular dependency:
 *   risk_scores ← market microstructure features
 *   cascade_events ← real liquidation streams + price data
 *   calibration learns the empirical mapping between the two.
 */

import type pg from 'pg';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CalibrationParams {
  /** Logistic regression intercept: log-odds when riskScore = 0. */
  intercept: number;
  /** Logistic regression coefficient: change in log-odds per score point. */
  coefficient: number;
  /**
   * Packed upper-triangle of the 2×2 covariance matrix of [a, b].
   * Format: [Var(a), Cov(a,b), Var(b)].
   * Computed from the inverse Fisher information matrix at the MLE.
   * undefined when using uncalibrated defaults (no data available).
   */
  covariance?: [number, number, number];
}

export interface CalibratedPrediction {
  /** Point estimate: P(cascade | riskScore). */
  probability: number;
  /** Lower bound of 95% confidence interval. */
  lowerBound: number;
  /** Upper bound of 95% confidence interval. */
  upperBound: number;
}

export interface CalibrationBin {
  /** Number of positive (cascade-followed) observations at this score. */
  positive: number;
  /** Total observations at this score. */
  total: number;
}

export interface CalibrationFitConfig {
  symbols: string[];
  startTime: Date;
  endTime: Date;
  /** Forward-looking horizon in minutes (same as backtest). */
  horizonMinutes: number;
  /** L2 regularization strength. Default 0.001. */
  regularization?: number;
  /** Max IRLS iterations. Default 25. */
  maxIterations?: number;
}

export interface CalibrationReport {
  params: CalibrationParams;
  totalSamples: number;
  positiveSamples: number;
  /** Empirical base rate = positiveSamples / totalSamples. */
  baseRate: number;
  /** IRLS iterations to convergence. */
  iterations: number;
  /** Final penalized log-likelihood. */
  logLikelihood: number;
  converged: boolean;
  /**
   * Per-score bin counts. Can be stored for Wilson interval computation
   * or diagnostic plots (calibration curve).
   */
  bins: CalibrationBin[];
}

// ---------------------------------------------------------------------------
// Default calibration (backward-compatible with prior arbitrary sigmoid)
// ---------------------------------------------------------------------------

/**
 * Prior defaults map to: sigmoid(score, midpoint=50, steepness=0.1)
 *   = 1/(1+exp(-0.1·(score−50)))
 *   = 1/(1+exp(−(−5 + 0.1·score)))
 *
 * intercept = −5, coefficient = 0.1, no covariance (not data-fitted).
 *
 * Replace these with fitCalibrationFromDB() output once historical data
 * is available. The defaults are used only during cold-start.
 */
export const DEFAULT_CALIBRATION: CalibrationParams = {
  intercept: -5.0,
  coefficient: 0.1,
};

// ---------------------------------------------------------------------------
// Core calibration functions
// ---------------------------------------------------------------------------

/**
 * Point estimate: P(cascade | riskScore).
 *
 *   P = 1 / (1 + exp(−(a + b · riskScore)))
 *
 * Pure, deterministic, no side effects.
 */
export function calibrateProbability(
  riskScore: number,
  params: CalibrationParams,
): number {
  const z = params.intercept + params.coefficient * riskScore;
  return logistic(z);
}

/**
 * Point estimate + 95% confidence interval via the Wald method.
 *
 * Requires covariance matrix from a fitted model. If covariance is not
 * available (uncalibrated defaults), returns a degenerate interval
 * [probability, probability].
 *
 * Method:
 *   1. Linear predictor: z = a + b·s
 *   2. Variance of z: Var(z) = Var(a) + 2·s·Cov(a,b) + s²·Var(b)
 *   3. CI on z: z ± z_α/2 · √Var(z)
 *   4. Transform to probability: σ(z_lower), σ(z_upper)
 *
 * The logistic transform preserves CI ordering and maps (-∞,+∞) → (0,1),
 * so the resulting probability interval is always valid.
 *
 * @param zAlpha — z-score for desired confidence level. Default 1.96 (95%).
 */
export function calibrateWithInterval(
  riskScore: number,
  params: CalibrationParams,
  zAlpha: number = 1.96,
): CalibratedPrediction {
  const z = params.intercept + params.coefficient * riskScore;
  const probability = logistic(z);

  if (!params.covariance) {
    return { probability, lowerBound: probability, upperBound: probability };
  }

  const [varA, covAB, varB] = params.covariance;

  // Var(a + b·s) via the quadratic form [1, s] · Σ · [1, s]ᵀ
  const varZ = varA + 2 * covAB * riskScore + varB * riskScore * riskScore;
  const seZ = Math.sqrt(Math.max(0, varZ));

  // CI on log-odds, then transform through logistic
  const lowerBound = logistic(z - zAlpha * seZ);
  const upperBound = logistic(z + zAlpha * seZ);

  return { probability, lowerBound, upperBound };
}

/**
 * Wilson score interval for a binomial proportion.
 *
 * Unlike the Wald method above (which uses the logistic regression model),
 * Wilson operates directly on the empirical count data at a specific score.
 * Better for small samples and handles p ≈ 0 or p ≈ 1 without collapsing.
 *
 * Formula:
 *   center = (y + z²/2) / (n + z²)
 *   margin = z · √(y·(n−y)/n + z²/4) / (n + z²)
 *   CI = [center − margin, center + margin]
 *
 * @param positives — number of cascade-followed observations at this score
 * @param total — total observations at this score
 * @param zAlpha — z-score for confidence level. Default 1.96 (95%).
 */
export function wilsonInterval(
  positives: number,
  total: number,
  zAlpha: number = 1.96,
): { lower: number; upper: number; point: number } {
  if (total === 0) {
    return { lower: 0, upper: 1, point: 0 };
  }

  const p = positives / total;
  const z2 = zAlpha * zAlpha;
  const denom = total + z2;
  const center = (positives + z2 / 2) / denom;
  const margin =
    (zAlpha * Math.sqrt((positives * (total - positives)) / total + z2 / 4)) /
    denom;

  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
    point: p,
  };
}

// ---------------------------------------------------------------------------
// IRLS logistic regression solver
// ---------------------------------------------------------------------------

const NUM_BINS = 101; // scores 0..100

/**
 * Fit logistic regression P(y=1|s) = σ(a + b·s) on binned count data.
 *
 * Uses Newton-Raphson / IRLS. At each iteration:
 *
 *   For each bin s with n_s observations and y_s positives:
 *     p_s = σ(a + b·s)                        — predicted probability
 *     r_s = y_s − n_s · p_s                    — residual
 *     w_s = n_s · p_s · (1 − p_s)              — Fisher weight
 *
 *   Gradient:     g = [Σ r_s,  Σ r_s·s]
 *   Fisher info:  J = [[Σ w_s, Σ w_s·s], [Σ w_s·s, Σ w_s·s²]]
 *   Update:       [a,b] += J⁻¹ · g
 *
 * L2 regularization adds λ·I to J and subtracts λ·[a,b] from g.
 *
 * Returns parameters and the covariance matrix Cov(a,b) = J⁻¹ evaluated
 * at the converged solution.
 */
export function fitLogisticRegression(
  bins: CalibrationBin[],
  regularization: number = 0.001,
  maxIterations: number = 25,
  convergenceThreshold: number = 1e-8,
): CalibrationReport {
  let totalSamples = 0;
  let positiveSamples = 0;
  for (const bin of bins) {
    totalSamples += bin.total;
    positiveSamples += bin.positive;
  }

  if (totalSamples === 0 || positiveSamples === 0) {
    return {
      params: { ...DEFAULT_CALIBRATION },
      totalSamples,
      positiveSamples,
      baseRate: 0,
      iterations: 0,
      logLikelihood: 0,
      converged: false,
      bins: bins.map((b) => ({ ...b })),
    };
  }

  const baseRate = positiveSamples / totalSamples;

  // Initialize at base-rate intercept (maximum entropy starting point)
  let a = Math.log(baseRate / (1 - baseRate));
  let b = 0;

  let iterations = 0;
  let converged = false;
  let logLik = 0;

  // Final Fisher information (stored for covariance computation)
  let J00 = 0, J01 = 0, J11 = 0;

  for (let iter = 0; iter < maxIterations; iter++) {
    iterations = iter + 1;

    let g0 = 0, g1 = 0;
    J00 = 0; J01 = 0; J11 = 0;
    logLik = 0;

    for (let s = 0; s < bins.length; s++) {
      const n = bins[s].total;
      if (n === 0) continue;

      const y = bins[s].positive;
      const z = a + b * s;
      const p = logistic(z);
      const pSafe = Math.max(1e-15, Math.min(1 - 1e-15, p));

      logLik += y * Math.log(pSafe) + (n - y) * Math.log(1 - pSafe);

      const r = y - n * p;
      const w = n * p * (1 - p);

      g0 += r;
      g1 += r * s;
      J00 += w;
      J01 += w * s;
      J11 += w * s * s;
    }

    // L2 regularization
    logLik -= (regularization / 2) * (a * a + b * b);
    g0 -= regularization * a;
    g1 -= regularization * b;
    J00 += regularization;
    J11 += regularization;

    // Solve 2×2 system J·δ = g
    const det = J00 * J11 - J01 * J01;
    if (Math.abs(det) < 1e-30) break;

    const da = (J11 * g0 - J01 * g1) / det;
    const db = (-J01 * g0 + J00 * g1) / det;

    a += da;
    b += db;

    if (Math.abs(da) < convergenceThreshold && Math.abs(db) < convergenceThreshold) {
      converged = true;
      break;
    }
  }

  // Covariance = J⁻¹ (inverse Fisher information at the MLE)
  const det = J00 * J11 - J01 * J01;
  let covariance: [number, number, number] | undefined;
  if (Math.abs(det) > 1e-30) {
    covariance = [
      J11 / det,     // Var(a)
      -J01 / det,    // Cov(a, b)
      J00 / det,     // Var(b)
    ];
  }

  return {
    params: { intercept: a, coefficient: b, covariance },
    totalSamples,
    positiveSamples,
    baseRate,
    iterations,
    logLikelihood: logLik,
    converged,
    bins: bins.map((bin) => ({ ...bin })),
  };
}

// ---------------------------------------------------------------------------
// Database-aware fitting
// ---------------------------------------------------------------------------

const PAGE_SIZE = 50_000;
const MS_PER_MIN = 60_000;

interface RiskScoreEntry {
  time: Date;
  risk_score: number;
}

interface CascadeEntry {
  start_time: Date;
}

/**
 * Fit calibration from historical DB data.
 *
 * Streams risk scores (paginated), labels each minute against ground-truth
 * cascade events, bins by integer score (O(1) memory), and runs IRLS.
 */
export async function fitCalibrationFromDB(
  pool: pg.Pool,
  config: CalibrationFitConfig,
): Promise<CalibrationReport> {
  const horizonMs = config.horizonMinutes * MS_PER_MIN;
  const lambda = config.regularization ?? 0.001;
  const maxIter = config.maxIterations ?? 25;

  // 1. Load cascade events (extend end by horizon for boundary matching)
  const cascadeEnd = new Date(config.endTime.getTime() + horizonMs);
  const allCascadeStartsMs: number[] = [];

  for (const symbol of config.symbols) {
    const { rows } = await pool.query<CascadeEntry>(
      `SELECT start_time FROM cascade_events
       WHERE symbol = $1 AND start_time >= $2 AND start_time <= $3
       ORDER BY start_time ASC`,
      [symbol, config.startTime, cascadeEnd],
    );
    for (const row of rows) {
      allCascadeStartsMs.push(row.start_time.getTime());
    }
  }

  allCascadeStartsMs.sort((a, b) => a - b);

  // 2. Initialize bins
  const bins: CalibrationBin[] = [];
  for (let i = 0; i < NUM_BINS; i++) {
    bins.push({ positive: 0, total: 0 });
  }

  // 3. Stream risk scores, label and bin
  for (const symbol of config.symbols) {
    let cursor = config.startTime;
    let isFirst = true;

    while (true) {
      const op = isFirst ? '>=' : '>';
      const { rows } = await pool.query<RiskScoreEntry>(
        `SELECT time, risk_score FROM risk_scores
         WHERE symbol = $1 AND time ${op} $2 AND time <= $3
         ORDER BY time ASC LIMIT $4`,
        [symbol, cursor, config.endTime, PAGE_SIZE],
      );
      if (rows.length === 0) break;

      for (const row of rows) {
        const score = Math.max(0, Math.min(100, Math.round(row.risk_score)));
        const timeMs = row.time.getTime();
        const hasCascade = cascadeInHorizon(allCascadeStartsMs, timeMs, horizonMs);

        bins[score].total++;
        if (hasCascade) bins[score].positive++;
      }

      cursor = rows[rows.length - 1].time;
      isFirst = false;
      if (rows.length < PAGE_SIZE) break;
    }
  }

  // 4. Fit
  return fitLogisticRegression(bins, lambda, maxIter);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function logistic(z: number): number {
  if (z > 500) return 1;
  if (z < -500) return 0;
  return 1 / (1 + Math.exp(-z));
}

function cascadeInHorizon(
  sortedStartsMs: number[],
  timeMs: number,
  horizonMs: number,
): boolean {
  const end = timeMs + horizonMs;
  let lo = 0;
  let hi = sortedStartsMs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedStartsMs[mid] < timeMs) lo = mid + 1;
    else hi = mid;
  }
  return lo < sortedStartsMs.length && sortedStartsMs[lo] <= end;
}
