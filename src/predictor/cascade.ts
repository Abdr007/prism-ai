/**
 * PRISM Stress Engine — Signal-First Stress Detection
 *
 * Replaces the 5-feature weighted model with a single-signal engine
 * built around the validated price-deviation signal, with dynamic
 * percentile-based thresholds and volatility regime conditioning.
 *
 * Architecture:
 *   1. Percentile-rank scoring — empirical CDF of price deviation → [0, 100]
 *   2. Dynamic thresholds — rolling quantiles × vol multiplier → risk level
 *   3. Volatility regime conditioning — tercile classification of stress volatility
 *   4. Confidence calibration — logistic (sigmoid) scaling, probability 0–1
 *
 * Consumer API is preserved: CascadeRisk, CascadeFactor, CascadePrediction,
 * RiskPrediction, CascadePredictor.analyze(), CascadePredictor.toPredictions()
 */

import type { AggregatedData } from '../aggregator/index.js';
import {
  calibrateProbability,
  DEFAULT_CALIBRATION,
  type CalibrationParams,
} from './calibration.js';

// ---------------------------------------------------------------------------
// Utility types
// ---------------------------------------------------------------------------

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

// ---------------------------------------------------------------------------
// Existing exports — preserved exactly
// ---------------------------------------------------------------------------

export interface CascadeRisk {
  symbol: string;
  riskScore: number;
  riskLevel: 'low' | 'moderate' | 'elevated' | 'high' | 'critical';
  /** Calibrated P(cascade | riskScore), fitted from historical data. */
  confidence: number;
  factors: CascadeFactor[];
  prediction: CascadePrediction | null;
  timestamp: number;
}

export interface CascadeFactor {
  name: string;
  score: number;
  weight: number;
  value: number;
  threshold: number;
  description: string;
}

export interface CascadePrediction {
  direction: 'long_squeeze' | 'short_squeeze';
  probability: number;
  estimatedImpact: number;
  timeWindow: string;
  triggerPrice: number;
  triggerDistance: number;
}

// ---------------------------------------------------------------------------
// RiskPrediction output interface
// ---------------------------------------------------------------------------

export interface RiskPrediction {
  symbol: string;
  riskScore: number;
  confidence: number;
  direction: 'LONG_SQUEEZE' | 'SHORT_SQUEEZE';
  triggerPrice: number;
  estimatedImpactUSD: number;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Feature Plugin Protocol
// ---------------------------------------------------------------------------

export interface FeaturePlugin {
  readonly name: string;
  readonly weight: number;
  extract(metrics: AggregatedData['metrics'][string]): number;
  score(value: number): number;
  update(value: number): void;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface StressEngineConfig {
  /** Rolling history length in minutes (30 days × 1440 min/day) */
  historyLength: number;
  /** Minimum observations before dynamic thresholds activate */
  minHistoryLength: number;
  /** Raw priceDeviation % values for cold-start scoring */
  coldStartThresholds: {
    elevated: number;
    high: number;
    critical: number;
  };
  /** Dynamic thresholds from rolling history percentiles */
  thresholdPercentiles: {
    elevated: number;
    high: number;
    critical: number;
  };
  /** Tercile boundaries for vol regime classification */
  volRegimePercentiles: {
    lowHigh: number;
    highLow: number;
  };
  /** Threshold scaling per volatility regime */
  volMultipliers: {
    low: number;
    medium: number;
    high: number;
  };
  /** Lookback window for regime detection (minutes) */
  volLookback: number;
  /** Experimental liquidity adjustment (off by default) */
  enableLiquidityAdjustment: boolean;
  /** Logistic regression calibration parameters */
  calibration: CalibrationParams;
  /** Z-score to risk-score scaling: riskScore = zScore × zScoreScaling */
  zScoreScaling: number;
  /** Minimum risk score for prediction generation */
  predictionMinScore: number;
  /** Feature plugins (empty by default) */
  plugins: FeaturePlugin[];
}

/** Backward-compatibility alias */
export type RiskEngineConfig = StressEngineConfig;

export const DEFAULT_CONFIG: StressEngineConfig = {
  historyLength: 43200,       // 30 days × 1440 min/day
  minHistoryLength: 1440,     // 24h
  coldStartThresholds: {
    elevated: 0.15,           // 0.15%
    high: 0.30,               // 0.30%
    critical: 0.60,           // 0.60%
  },
  thresholdPercentiles: {
    elevated: 0.90,
    high: 0.95,
    critical: 0.99,
  },
  volRegimePercentiles: {
    lowHigh: 0.33,
    highLow: 0.67,
  },
  volMultipliers: {
    low: 0.75,
    medium: 1.0,
    high: 1.5,
  },
  volLookback: 4320,          // 3 days
  enableLiquidityAdjustment: false,
  calibration: { intercept: -7, coefficient: 0.1 },  // P(0)≈0.1%, P(70)=50%
  zScoreScaling: 20,          // z=2→40, z=3→60, z=4→80, z=5→100
  predictionMinScore: 40,
  plugins: [],
};

// ---------------------------------------------------------------------------
// SortedRollingBuffer — O(log n) percentile rank and quantile
// ---------------------------------------------------------------------------

/**
 * Maintains a FIFO ring buffer alongside a sorted copy for efficient
 * order-statistic queries. push() is O(n) worst-case due to splice,
 * but empirically ~O(log n) for the binary search portion.
 */
class SortedRollingBuffer {
  private readonly ring: number[] = [];
  private readonly sorted: number[] = [];
  private readonly maxLen: number;
  private sum = 0;
  private sumSq = 0;

  constructor(maxLen: number) {
    this.maxLen = maxLen;
  }

  get length(): number {
    return this.ring.length;
  }

  push(value: number): void {
    // If at capacity, remove oldest
    if (this.ring.length >= this.maxLen) {
      const removed = this.ring.shift()!;
      this.sum -= removed;
      this.sumSq -= removed * removed;
      // Remove from sorted via binary search
      const idx = this.bsearchExact(removed);
      if (idx >= 0) this.sorted.splice(idx, 1);
    }

    this.ring.push(value);
    this.sum += value;
    this.sumSq += value * value;

    // Insert into sorted position
    const insertIdx = this.bsearchInsert(value);
    this.sorted.splice(insertIdx, 0, value);
  }

  mean(): number {
    return this.ring.length > 0 ? this.sum / this.ring.length : 0;
  }

  /** Population std dev via running sum/sumSq. */
  stddev(): number {
    const n = this.ring.length;
    if (n < 2) return 0;
    const mean = this.sum / n;
    const variance = this.sumSq / n - mean * mean;
    return Math.sqrt(Math.max(0, variance));
  }

  /** Empirical CDF × 100: fraction of values ≤ value. O(log n). */
  percentileRank(value: number): number {
    if (this.sorted.length === 0) return 0;
    // Find first index where sorted[i] > value
    let lo = 0, hi = this.sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.sorted[mid] <= value) lo = mid + 1;
      else hi = mid;
    }
    return (lo / this.sorted.length) * 100;
  }

  /** Quantile with linear interpolation. O(1). */
  quantile(q: number): number {
    if (this.sorted.length === 0) return 0;
    const pos = q * (this.sorted.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return this.sorted[lo];
    const frac = pos - lo;
    return this.sorted[lo] * (1 - frac) + this.sorted[hi] * frac;
  }

  /** Get last n elements from the ring buffer. */
  tail(n: number): number[] {
    if (n >= this.ring.length) return this.ring.slice();
    return this.ring.slice(-n);
  }

  private bsearchInsert(value: number): number {
    let lo = 0, hi = this.sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.sorted[mid] < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private bsearchExact(value: number): number {
    let lo = 0, hi = this.sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.sorted[mid] < value) lo = mid + 1;
      else hi = mid;
    }
    if (lo < this.sorted.length && this.sorted[lo] === value) return lo;
    return -1;
  }
}

// ---------------------------------------------------------------------------
// Internal state types
// ---------------------------------------------------------------------------

interface SymbolState {
  spreadBuf: SortedRollingBuffer;
  zScoreBuf: SortedRollingBuffer;
  oiBuf: SortedRollingBuffer;
}

type VolatilityRegime = 'LOW' | 'MEDIUM' | 'HIGH';

// ---------------------------------------------------------------------------
// Pure statistical functions (for small arrays like vol lookback slices)
// ---------------------------------------------------------------------------

function sampleMean(arr: number[]): number {
  if (arr.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i];
  return sum / arr.length;
}

/** Population standard deviation (N denominator), two-pass algorithm. */
function sampleStdDev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const mean = sampleMean(arr);
  let sumSq = 0;
  for (let i = 0; i < arr.length; i++) {
    const d = arr[i] - mean;
    sumSq += d * d;
  }
  return Math.sqrt(sumSq / arr.length);
}

function quantileSmall(arr: number[], q: number): number {
  if (arr.length === 0) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const frac = pos - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

// ---------------------------------------------------------------------------
// Linear interpolation for cold-start scoring
// ---------------------------------------------------------------------------

/** Linear interpolation between score bands (cold-start thresholds). */
function interpolateScore(
  value: number,
  thresholds: { elevated: number; high: number; critical: number },
): number {
  if (value <= 0) return 0;
  if (value >= thresholds.critical) return Math.min(100, 80 + (value / thresholds.critical - 1) * 20);
  if (value >= thresholds.high) return 60 + ((value - thresholds.high) / (thresholds.critical - thresholds.high)) * 20;
  if (value >= thresholds.elevated) return 40 + ((value - thresholds.elevated) / (thresholds.high - thresholds.elevated)) * 20;
  return (value / thresholds.elevated) * 40;
}

// ---------------------------------------------------------------------------
// Deep merge helper
// ---------------------------------------------------------------------------

function deepMergeConfig(
  base: StressEngineConfig,
  overrides: DeepPartial<StressEngineConfig>,
): StressEngineConfig {
  const result = { ...base } as Record<string, unknown>;
  for (const key of Object.keys(overrides) as Array<keyof StressEngineConfig>) {
    const val = overrides[key];
    if (val !== undefined && val !== null && typeof val === 'object' && !Array.isArray(val)) {
      result[key] = { ...(base[key] as Record<string, unknown>), ...(val as Record<string, unknown>) };
    } else if (val !== undefined) {
      result[key] = val;
    }
  }
  return result as unknown as StressEngineConfig;
}

// ---------------------------------------------------------------------------
// CascadePredictor — stress engine
// ---------------------------------------------------------------------------

export class CascadePredictor {
  private readonly state: Map<string, SymbolState> = new Map();
  private readonly cfg: StressEngineConfig;

  constructor(config?: DeepPartial<StressEngineConfig>) {
    this.cfg = config ? deepMergeConfig(DEFAULT_CONFIG, config) : { ...DEFAULT_CONFIG };
  }

  /** Analyze aggregated data, returning risk assessments per symbol. */
  analyze(data: AggregatedData): CascadeRisk[] {
    const risks: CascadeRisk[] = [];

    for (const symbol of data.symbols) {
      const m = data.metrics[symbol];
      if (!m) continue;

      // --- 1. Extract ---
      const rawSpread = m.priceDeviation || 0;

      // --- 2. Update history ---
      let st = this.state.get(symbol);
      if (!st) {
        st = {
          spreadBuf: new SortedRollingBuffer(this.cfg.historyLength),
          zScoreBuf: new SortedRollingBuffer(this.cfg.historyLength),
          oiBuf: new SortedRollingBuffer(this.cfg.historyLength),
        };
        this.state.set(symbol, st);
      }

      st.spreadBuf.push(rawSpread);

      if (this.cfg.enableLiquidityAdjustment && m.totalOpenInterestValue > 0) {
        st.oiBuf.push(m.totalOpenInterestValue);
      }

      const isWarm = st.spreadBuf.length >= this.cfg.minHistoryLength;

      // --- 3. Z-score ---
      let stressZ = 0;
      if (st.spreadBuf.length >= 2) {
        const mean = st.spreadBuf.mean();
        const std = st.spreadBuf.stddev();
        stressZ = std > 0 ? (rawSpread - mean) / std : 0;
        st.zScoreBuf.push(stressZ);
      }

      // --- 4. Risk score ---
      let riskScore: number;
      if (isWarm) {
        // Z-score based: naturally right-skewed, only extreme deviations score high
        riskScore = stressZ * this.cfg.zScoreScaling;
      } else {
        riskScore = interpolateScore(rawSpread, this.cfg.coldStartThresholds);
      }

      // --- 5. Vol regime ---
      const volLookbackSlice = st.zScoreBuf.tail(this.cfg.volLookback);
      const volOfStress = sampleStdDev(volLookbackSlice);
      let regime: VolatilityRegime = 'MEDIUM';
      if (st.zScoreBuf.length >= 60) {
        const lowThreshold = st.zScoreBuf.quantile(this.cfg.volRegimePercentiles.lowHigh);
        const highThreshold = st.zScoreBuf.quantile(this.cfg.volRegimePercentiles.highLow);
        // These are quantiles of z-scores; we compare volOfStress (std of recent z-scores)
        // against quantiles of the full z-score history for regime classification
        const volHistQuantileLow = quantileSmall(volLookbackSlice.length >= 60 ? volLookbackSlice : [], this.cfg.volRegimePercentiles.lowHigh);
        const volHistQuantileHigh = quantileSmall(volLookbackSlice.length >= 60 ? volLookbackSlice : [], this.cfg.volRegimePercentiles.highLow);
        // Use z-score buffer terciles on the volOfStress value
        // volOfStress is the std of recent z-scores; classify against terciles of z-score distribution
        if (volOfStress < lowThreshold) regime = 'LOW';
        else if (volOfStress > highThreshold) regime = 'HIGH';
        void volHistQuantileLow;
        void volHistQuantileHigh;
      }

      const volMultiplier = regime === 'LOW'
        ? this.cfg.volMultipliers.low
        : regime === 'HIGH'
          ? this.cfg.volMultipliers.high
          : this.cfg.volMultipliers.medium;

      // --- 6. Dynamic thresholds ---
      let elevatedThreshold: number;
      let highThreshold: number;
      let criticalThreshold: number;

      if (isWarm) {
        elevatedThreshold = st.spreadBuf.quantile(this.cfg.thresholdPercentiles.elevated) * volMultiplier;
        highThreshold = st.spreadBuf.quantile(this.cfg.thresholdPercentiles.high) * volMultiplier;
        criticalThreshold = st.spreadBuf.quantile(this.cfg.thresholdPercentiles.critical) * volMultiplier;
      } else {
        elevatedThreshold = this.cfg.coldStartThresholds.elevated;
        highThreshold = this.cfg.coldStartThresholds.high;
        criticalThreshold = this.cfg.coldStartThresholds.critical;
      }

      // --- 7. Risk level (from raw spread vs vol-adjusted thresholds) ---
      let riskLevel: CascadeRisk['riskLevel'];
      if (rawSpread >= criticalThreshold) {
        riskLevel = 'critical';
      } else if (rawSpread >= highThreshold) {
        riskLevel = 'high';
      } else if (rawSpread >= elevatedThreshold) {
        riskLevel = 'elevated';
      } else if (riskScore >= 20) {
        riskLevel = 'moderate';
      } else {
        riskLevel = 'low';
      }

      // --- 8. Optional liquidity adjustment ---
      if (this.cfg.enableLiquidityAdjustment && st.oiBuf.length >= 60) {
        const medianOI = st.oiBuf.quantile(0.5);
        if (medianOI > 0 && m.totalOpenInterestValue > 0) {
          riskScore = riskScore * Math.sqrt(m.totalOpenInterestValue / medianOI);
        }
      }

      riskScore = Math.min(100, Math.max(0, Math.round(riskScore)));

      // --- 9. Confidence ---
      const confidence = calibrateProbability(riskScore, this.cfg.calibration);

      // --- 10. Factors (3 entries for backward compat) ---
      const pctRank = st.spreadBuf.percentileRank(rawSpread);
      const factors: CascadeFactor[] = [
        {
          name: 'Price Stress',
          score: riskScore,
          weight: 1.0,
          value: stressZ,
          threshold: criticalThreshold,
          description: `z=${stressZ.toFixed(2)}, pctile=${pctRank.toFixed(1)}, spread=${rawSpread.toFixed(4)}%`,
        },
        {
          name: 'Volatility Regime',
          score: 0,
          weight: 0.0,
          value: volOfStress,
          threshold: 0,
          description: `Regime: ${regime}, vol-of-stress=${volOfStress.toFixed(4)}`,
        },
        {
          name: 'Dynamic Threshold',
          score: 0,
          weight: 0.0,
          value: criticalThreshold,
          threshold: criticalThreshold,
          description: `Critical threshold: ${criticalThreshold.toFixed(4)}% (vol-adjusted, ${regime})`,
        },
      ];

      // --- 11. Prediction ---
      const prediction = riskScore >= this.cfg.predictionMinScore
        ? this.generatePrediction(m, riskScore, stressZ)
        : null;

      risks.push({ symbol, riskScore, riskLevel, confidence, factors, prediction, timestamp: data.timestamp });
    }

    return risks;
  }

  /** Produce quant-grade RiskPrediction from CascadeRisk array. */
  toPredictions(risks: CascadeRisk[]): RiskPrediction[] {
    return risks
      .filter((r) => r.prediction !== null)
      .map((r) => ({
        symbol: r.symbol,
        riskScore: r.riskScore,
        confidence: r.confidence,
        direction: r.prediction!.direction === 'long_squeeze' ? 'LONG_SQUEEZE' as const : 'SHORT_SQUEEZE' as const,
        triggerPrice: r.prediction!.triggerPrice,
        estimatedImpactUSD: r.prediction!.estimatedImpact,
        timestamp: r.timestamp,
      }));
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private generatePrediction(
    metrics: AggregatedData['metrics'][string],
    riskScore: number,
    stressZ: number,
  ): CascadePrediction {
    const direction: CascadePrediction['direction'] =
      metrics.avgFundingRate > 0 ? 'long_squeeze' : 'short_squeeze';

    const probability = Math.min(0.95, Math.max(0.05,
      calibrateProbability(riskScore, this.cfg.calibration),
    ));

    const severity = riskScore / 100;

    const totalOI = Math.max(0, metrics.totalOpenInterestValue || 0);
    const liquidationPct = 0.03 + severity * 0.07;
    const estimatedImpact = Number.isFinite(totalOI) ? totalOI * liquidationPct : 0;

    const triggerDistance = Math.max(2, 6 - severity * 4);

    const basePrice = metrics.oraclePrice || metrics.avgMarkPrice || 0;
    if (!Number.isFinite(basePrice) || basePrice <= 0) {
      return { direction, probability, estimatedImpact: 0, timeWindow: '12-24 hours', triggerPrice: 0, triggerDistance };
    }

    const multiplier = direction === 'long_squeeze'
      ? 1 - triggerDistance / 100
      : 1 + triggerDistance / 100;
    const triggerPrice = basePrice * multiplier;

    const absZ = Math.abs(stressZ);
    const timeWindow = absZ >= 3 ? '1-4 hours' : absZ >= 2 ? '4-12 hours' : '12-24 hours';

    return {
      direction,
      probability: Number.isFinite(probability) ? probability : 0.5,
      estimatedImpact: Number.isFinite(estimatedImpact) ? estimatedImpact : 0,
      timeWindow,
      triggerPrice: Number.isFinite(triggerPrice) ? triggerPrice : 0,
      triggerDistance: Number.isFinite(triggerDistance) ? triggerDistance : 4,
    };
  }
}
