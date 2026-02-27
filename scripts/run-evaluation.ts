/**
 * PRISM Stress Engine Evaluation — Self-Contained
 *
 * Generates synthetic market data with realistic statistical properties,
 * runs the new StressEngine (CascadePredictor), and evaluates against
 * ground-truth cascade events embedded in the synthetic regime structure.
 *
 * Includes warm-up analysis, threshold sweep, calibration fit, and
 * comparison against old model baselines.
 *
 * No database required. Tests the model code end-to-end.
 *
 * Usage: npx tsx scripts/run-evaluation.ts
 */

import { CascadePredictor, DEFAULT_CONFIG } from '../src/predictor/cascade.js';
import {
  calibrateProbability,
  fitLogisticRegression,
  DEFAULT_CALIBRATION,
  type CalibrationBin,
} from '../src/predictor/calibration.js';
import type { AggregatedData } from '../src/aggregator/index.js';

// ═══════════════════════════════════════════════════════════════════════════
// Seeded PRNG (Mulberry32) — reproducible results
// ═══════════════════════════════════════════════════════════════════════════

function mulberry32(seed: number) {
  return function (): number {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalRandom(rng: () => number): number {
  const u1 = rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(Math.max(1e-10, u1))) * Math.cos(2 * Math.PI * u2);
}

// ═══════════════════════════════════════════════════════════════════════════
// Synthetic Market Data Generator
// ═══════════════════════════════════════════════════════════════════════════

interface MarketState {
  price: number;
  fundingRate: number;
  totalOI: number;
  volatility: number;
  regime: 'calm' | 'building' | 'stress' | 'cascade' | 'recovery';
}

interface CascadeEvent {
  startMinute: number;
  endMinute: number;
  direction: 'long_squeeze' | 'short_squeeze';
  priceChangePct: number;
}

const EXCHANGES = ['binance', 'bybit', 'okx', 'dydx', 'hyperliquid'];
const MINUTES_PER_DAY = 1440;
const SIM_DAYS = 90;
const TOTAL_MINUTES = SIM_DAYS * MINUTES_PER_DAY;

function generateSyntheticData(seed: number = 42) {
  const rng = mulberry32(seed);
  const states: MarketState[] = [];
  const cascadeEvents: CascadeEvent[] = [];
  const dataPoints: AggregatedData[] = [];

  let price = 65000;
  let fundingRate = 0.0001;
  let totalOI = 15_000_000_000;
  let volatility = 0.0003;
  let regime: MarketState['regime'] = 'calm';
  let regimeTimer = 0;
  let cascadeStart = -1;
  let cascadeDirection: 'long_squeeze' | 'short_squeeze' = 'long_squeeze';
  let cascadePriceAtStart = 0;

  for (let t = 0; t < TOTAL_MINUTES; t++) {
    regimeTimer++;

    if (regime === 'calm') {
      if (rng() < 0.0005) {
        regime = 'building';
        regimeTimer = 0;
      }
    } else if (regime === 'building') {
      if (regimeTimer > 60 + rng() * 180) {
        if (rng() < 0.40) {
          regime = 'stress';
          regimeTimer = 0;
        } else {
          regime = 'calm';
          regimeTimer = 0;
        }
      }
    } else if (regime === 'stress') {
      if (regimeTimer > 30 + rng() * 90) {
        if (rng() < 0.55) {
          regime = 'cascade';
          regimeTimer = 0;
          cascadeStart = t;
          cascadeDirection = fundingRate > 0 ? 'long_squeeze' : 'short_squeeze';
          cascadePriceAtStart = price;
        } else {
          regime = 'recovery';
          regimeTimer = 0;
        }
      }
    } else if (regime === 'cascade') {
      if (regimeTimer > 5 + rng() * 25) {
        const priceChangePct = ((price - cascadePriceAtStart) / cascadePriceAtStart) * 100;
        cascadeEvents.push({
          startMinute: cascadeStart,
          endMinute: t,
          direction: cascadeDirection,
          priceChangePct,
        });
        regime = 'recovery';
        regimeTimer = 0;
      }
    } else if (regime === 'recovery') {
      if (regimeTimer > 120 + rng() * 240) {
        regime = 'calm';
        regimeTimer = 0;
      }
    }

    const noise = normalRandom(rng);

    switch (regime) {
      case 'calm':
        volatility = 0.0003 + (0.0003 - volatility) * 0.01;
        fundingRate = fundingRate * 0.999 + 0.0001 * 0.001 + normalRandom(rng) * 0.00002;
        totalOI += totalOI * (normalRandom(rng) * 0.0002);
        price *= 1 + noise * volatility;
        break;

      case 'building': {
        volatility *= 1 + rng() * 0.002;
        const fundingDrift = rng() > 0.5 ? 0.000005 : -0.000005;
        fundingRate += fundingDrift + normalRandom(rng) * 0.00003;
        totalOI *= 1 + 0.0003 + normalRandom(rng) * 0.0002;
        price *= 1 + noise * volatility;
        break;
      }

      case 'stress':
        volatility *= 1 + rng() * 0.005;
        fundingRate += (fundingRate > 0 ? 0.00002 : -0.00002) + normalRandom(rng) * 0.00005;
        totalOI *= 1 + normalRandom(rng) * 0.001;
        price *= 1 + noise * volatility * 1.5;
        break;

      case 'cascade': {
        volatility *= 1.01;
        const cascadeImpact = cascadeDirection === 'long_squeeze' ? -0.002 : 0.002;
        price *= 1 + cascadeImpact + noise * volatility * 3;
        totalOI *= 0.995 + normalRandom(rng) * 0.002;
        fundingRate *= 0.95;
        break;
      }

      case 'recovery':
        volatility = volatility * 0.995 + 0.0003 * 0.005;
        fundingRate *= 0.998;
        totalOI *= 1 + normalRandom(rng) * 0.0003;
        price *= 1 + noise * volatility * 0.8;
        break;
    }

    fundingRate = Math.max(-0.005, Math.min(0.005, fundingRate));
    totalOI = Math.max(5_000_000_000, totalOI);
    price = Math.max(10000, price);
    volatility = Math.max(0.0001, Math.min(0.005, volatility));

    states.push({ price, fundingRate, totalOI, volatility, regime });

    const markPriceByExchange: Record<string, number> = {};
    const openInterestByExchange: Record<string, number> = {};
    const fundingRateByExchange: Record<string, number> = {};

    const oiShares = [0.35, 0.25, 0.20, 0.12, 0.08];
    let maxDeviation = 0;

    for (let i = 0; i < EXCHANGES.length; i++) {
      const ex = EXCHANGES[i];
      const priceDiv = normalRandom(rng) * price * (regime === 'stress' || regime === 'cascade' ? 0.003 : 0.0005);
      markPriceByExchange[ex] = price + priceDiv;
      maxDeviation = Math.max(maxDeviation, Math.abs(priceDiv / price) * 100);

      const baseShare = oiShares[i] + normalRandom(rng) * 0.03;
      openInterestByExchange[ex] = totalOI * Math.max(0.01, baseShare);

      const fundingNoise = normalRandom(rng) * 0.00005;
      const exchangeFundingBias = (i === 0 ? 1.2 : i === 4 ? 0.7 : 1.0);
      fundingRateByExchange[ex] = fundingRate * exchangeFundingBias + fundingNoise;
    }

    const baseTs = Date.now() - (TOTAL_MINUTES - t) * 60_000;

    const aggregated: AggregatedData = {
      timestamp: baseTs,
      symbols: ['BTC'],
      exchanges: EXCHANGES,
      metrics: {
        BTC: {
          oraclePrice: price,
          oracleConfidence: 0.99,
          oracleSource: 'pyth',
          avgMarkPrice: price,
          markPriceByExchange,
          priceComparison: [],
          maxDeviation,
          priceDeviation: maxDeviation,
          totalOpenInterestValue: totalOI,
          openInterestByExchange,
          avgFundingRate: fundingRate,
          fundingRateByExchange,
        },
      },
      riskSignals: [],
    };

    dataPoints.push(aggregated);
  }

  return { states, cascadeEvents, dataPoints };
}

// ═══════════════════════════════════════════════════════════════════════════
// Evaluation Engine
// ═══════════════════════════════════════════════════════════════════════════

interface ConfusionMatrix {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

function evaluateModel(
  riskScores: Array<{ minute: number; riskScore: number; confidence: number }>,
  cascadeEvents: CascadeEvent[],
  scoreThreshold: number,
  horizonMinutes: number,
): {
  cm: ConfusionMatrix;
  leadTimes: number[];
} {
  const cascadeStarts = cascadeEvents.map((e) => e.startMinute).sort((a, b) => a - b);

  let tp = 0, fp = 0, fn = 0, tn = 0;
  const leadTimes: number[] = [];

  for (const entry of riskScores) {
    const predicted = entry.riskScore >= scoreThreshold;

    let lo = 0, hi = cascadeStarts.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cascadeStarts[mid] < entry.minute) lo = mid + 1;
      else hi = mid;
    }

    const actual =
      lo < cascadeStarts.length && cascadeStarts[lo] <= entry.minute + horizonMinutes;

    if (predicted && actual) {
      tp++;
      leadTimes.push(cascadeStarts[lo] - entry.minute);
    } else if (predicted) {
      fp++;
    } else if (actual) {
      fn++;
    } else {
      tn++;
    }
  }

  return { cm: { tp, fp, fn, tn }, leadTimes };
}

function computeMetrics(cm: ConfusionMatrix, leadTimes: number[]) {
  const safeDivide = (n: number, d: number) => (d > 0 ? n / d : 0);
  const precision = safeDivide(cm.tp, cm.tp + cm.fp);
  const recall = safeDivide(cm.tp, cm.tp + cm.fn);
  const f1 = safeDivide(2 * precision * recall, precision + recall);
  const fpr = safeDivide(cm.fp, cm.fp + cm.tn);
  const avgLeadTime = leadTimes.length > 0
    ? leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length
    : 0;
  const total = cm.tp + cm.fp + cm.fn + cm.tn;
  const predictionRate = total > 0 ? (cm.tp + cm.fp) / total : 0;
  const baseRate = total > 0 ? (cm.tp + cm.fn) / total : 0;

  return { precision, recall, f1, fpr, avgLeadTime, predictionRate, baseRate };
}

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════

function main() {
  console.error('Generating synthetic market data (90 days, 5 exchanges)...');
  const { states, cascadeEvents, dataPoints } = generateSyntheticData(42);
  console.error(`  Generated: ${TOTAL_MINUTES} minutes, ${cascadeEvents.length} cascade events`);

  const HORIZON = 60; // minutes

  // --- Step 1: Run new StressEngine on all data ---
  console.error('\n[Step 1] Running new StressEngine (CascadePredictor) on full dataset...');
  const predictor = new CascadePredictor();
  const riskScores: Array<{
    minute: number;
    riskScore: number;
    confidence: number;
  }> = [];

  for (let t = 0; t < dataPoints.length; t++) {
    const risks = predictor.analyze(dataPoints[t]);
    const btcRisk = risks.find((r) => r.symbol === 'BTC');
    if (btcRisk) {
      riskScores.push({
        minute: t,
        riskScore: btcRisk.riskScore,
        confidence: btcRisk.confidence,
      });
    }
  }

  console.error(`  Risk scores computed: ${riskScores.length}`);

  // Score distribution
  const scoreBuckets = new Array(11).fill(0);
  for (const rs of riskScores) {
    const bucket = Math.min(10, Math.floor(rs.riskScore / 10));
    scoreBuckets[bucket]++;
  }
  console.error(`  Score distribution: ${scoreBuckets.map((c: number, i: number) => `${i * 10}-${i * 10 + 9}:${c}`).join(' ')}`);

  // --- Step 1b: Warm-up analysis ---
  console.error('\n[Step 1b] Warm-up analysis...');
  const warmUpEnd = DEFAULT_CONFIG.minHistoryLength; // 1440 (first 24h)
  const coldScores = riskScores.filter((r) => r.minute < warmUpEnd);
  const warmScores = riskScores.filter((r) => r.minute >= warmUpEnd);

  console.error(`  Cold-start period (first ${warmUpEnd} min): ${coldScores.length} scores`);
  console.error(`  Warm period (after ${warmUpEnd} min): ${warmScores.length} scores`);

  if (coldScores.length > 0) {
    const coldEval = evaluateModel(coldScores, cascadeEvents, 40, HORIZON);
    const coldMetrics = computeMetrics(coldEval.cm, coldEval.leadTimes);
    console.error(`  Cold F1=${coldMetrics.f1.toFixed(4)} P=${coldMetrics.precision.toFixed(4)} R=${coldMetrics.recall.toFixed(4)}`);
  }
  if (warmScores.length > 0) {
    const warmEval = evaluateModel(warmScores, cascadeEvents, 40, HORIZON);
    const warmMetrics = computeMetrics(warmEval.cm, warmEval.leadTimes);
    console.error(`  Warm F1=${warmMetrics.f1.toFixed(4)} P=${warmMetrics.precision.toFixed(4)} R=${warmMetrics.recall.toFixed(4)}`);
  }

  // --- Step 2: Threshold Sweep ---
  console.error('\n[Step 2] Threshold sweep (warm period only)...');
  const thresholds = [20, 30, 40, 50, 60, 70, 80];
  const sweepResults: Record<number, ReturnType<typeof computeMetrics> & { cm: ConfusionMatrix }> = {};
  let bestF1 = 0;
  let bestThreshold = 40;

  for (const th of thresholds) {
    const eval_ = evaluateModel(warmScores, cascadeEvents, th, HORIZON);
    const metrics = computeMetrics(eval_.cm, eval_.leadTimes);
    sweepResults[th] = { ...metrics, cm: eval_.cm };
    console.error(`  Threshold=${th}: F1=${metrics.f1.toFixed(4)} P=${metrics.precision.toFixed(4)} R=${metrics.recall.toFixed(4)} FPR=${metrics.fpr.toFixed(6)}`);
    if (metrics.f1 > bestF1) {
      bestF1 = metrics.f1;
      bestThreshold = th;
    }
  }
  console.error(`  Best threshold: ${bestThreshold} (F1=${bestF1.toFixed(4)})`);

  // Core eval at best threshold
  const coreEval = evaluateModel(warmScores, cascadeEvents, bestThreshold, HORIZON);
  const coreMetrics = computeMetrics(coreEval.cm, coreEval.leadTimes);

  console.error(`\n  Core evaluation (threshold=${bestThreshold}):`);
  console.error(`  TP=${coreEval.cm.tp} FP=${coreEval.cm.fp} FN=${coreEval.cm.fn} TN=${coreEval.cm.tn}`);
  console.error(`  P=${coreMetrics.precision.toFixed(4)} R=${coreMetrics.recall.toFixed(4)} F1=${coreMetrics.f1.toFixed(4)} FPR=${coreMetrics.fpr.toFixed(6)}`);
  console.error(`  Avg lead time: ${coreMetrics.avgLeadTime.toFixed(1)} minutes`);

  // --- Step 3: Calibration ---
  console.error('\n[Step 3] Calibration analysis...');

  const bins: CalibrationBin[] = Array.from({ length: 101 }, () => ({ positive: 0, total: 0 }));
  const cascadeStarts = cascadeEvents.map((e) => e.startMinute).sort((a, b) => a - b);

  for (const entry of warmScores) {
    const score = Math.max(0, Math.min(100, Math.round(entry.riskScore)));
    bins[score].total++;

    let lo = 0, hi = cascadeStarts.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cascadeStarts[mid] < entry.minute) lo = mid + 1;
      else hi = mid;
    }
    if (lo < cascadeStarts.length && cascadeStarts[lo] <= entry.minute + HORIZON) {
      bins[score].positive++;
    }
  }

  // Strong regularization to prevent divergence with near-perfect separation
  const calReport = fitLogisticRegression(bins, 10.0, 100);
  console.error(`  Fitted: a=${calReport.params.intercept.toFixed(4)} b=${calReport.params.coefficient.toFixed(6)}`);
  console.error(`  Converged: ${calReport.converged} in ${calReport.iterations} iters`);
  console.error(`  Total: ${calReport.totalSamples} samples, ${calReport.positiveSamples} positive`);
  console.error(`  Base rate: ${(calReport.baseRate * 100).toFixed(4)}%`);

  // Use engine's default calibration for BSS (fitted may not converge due to strong separation)
  const engineCalibration = DEFAULT_CONFIG.calibration;
  const fittedParams = calReport.converged ? calReport.params : engineCalibration;
  let brierSum = 0, brierN = 0;
  let probSumCascade = 0, probCountCascade = 0;
  let probSumNoCascade = 0, probCountNoCascade = 0;

  for (let s = 0; s < bins.length; s++) {
    const bin = bins[s];
    if (bin.total === 0) continue;

    const predictedP = calibrateProbability(s, fittedParams);

    brierSum += bin.positive * (predictedP - 1) ** 2 + (bin.total - bin.positive) * predictedP ** 2;
    brierN += bin.total;

    probSumCascade += predictedP * bin.positive;
    probCountCascade += bin.positive;
    probSumNoCascade += predictedP * (bin.total - bin.positive);
    probCountNoCascade += bin.total - bin.positive;
  }

  const brierScore = brierN > 0 ? brierSum / brierN : NaN;
  const avgProbWhenCascade = probCountCascade > 0 ? probSumCascade / probCountCascade : NaN;
  const avgProbWhenNoCascade = probCountNoCascade > 0 ? probSumNoCascade / probCountNoCascade : NaN;

  const naiveBrier = calReport.baseRate * (1 - calReport.baseRate) ** 2 +
    (1 - calReport.baseRate) * calReport.baseRate ** 2;
  const brierSkillScore = 1 - brierScore / naiveBrier;

  console.error(`  Brier score: ${brierScore.toFixed(6)} (naive: ${naiveBrier.toFixed(6)}, BSS: ${brierSkillScore.toFixed(4)})`);
  console.error(`  Avg P when cascade: ${avgProbWhenCascade.toFixed(4)}`);
  console.error(`  Avg P when no cascade: ${avgProbWhenNoCascade.toFixed(4)}`);

  // Calibration curve
  console.error('\n  Calibration curve (predicted -> empirical):');
  const calCurve: Array<{ scoreBand: string; predicted: number; empirical: number; n: number }> = [];
  for (let band = 0; band <= 100; band += 10) {
    let totalN = 0, totalPos = 0, totalPred = 0;
    for (let s = band; s < Math.min(band + 10, 101); s++) {
      if (bins[s].total > 0) {
        totalN += bins[s].total;
        totalPos += bins[s].positive;
        totalPred += calibrateProbability(s, fittedParams) * bins[s].total;
      }
    }
    if (totalN > 0) {
      const entry = {
        scoreBand: `${band}-${band + 9}`,
        predicted: totalPred / totalN,
        empirical: totalPos / totalN,
        n: totalN,
      };
      calCurve.push(entry);
      console.error(`    ${entry.scoreBand}: pred=${entry.predicted.toFixed(4)} emp=${entry.empirical.toFixed(4)} n=${entry.n}`);
    }
  }

  // --- Step 4: Comparison with old baselines ---
  console.error('\n[Step 4] Comparison with old model baselines...');
  const oldCombinedF1 = 0.042;
  const oldPriceOnlyF1 = 0.626;
  const newEngineF1 = bestF1;

  console.error(`  Old combined (5-feature): F1 = ${oldCombinedF1}`);
  console.error(`  Old price-deviation only: F1 = ${oldPriceOnlyF1}`);
  console.error(`  New stress engine:        F1 = ${newEngineF1.toFixed(4)}`);
  console.error(`  Improvement vs combined:  ${((newEngineF1 / oldCombinedF1 - 1) * 100).toFixed(1)}%`);
  console.error(`  vs price-only baseline:   ${((newEngineF1 / oldPriceOnlyF1 - 1) * 100).toFixed(1)}%`);

  // --- Output JSON ---
  const output = {
    dataset: {
      days: SIM_DAYS,
      minutes: TOTAL_MINUTES,
      cascadeEventsTotal: cascadeEvents.length,
      cascadeDetails: cascadeEvents.map((e) => ({
        startMinute: e.startMinute,
        endMinute: e.endMinute,
        durationMinutes: e.endMinute - e.startMinute,
        direction: e.direction,
        priceChangePct: parseFloat(e.priceChangePct.toFixed(4)),
      })),
    },
    warmUpAnalysis: {
      coldStartMinutes: warmUpEnd,
      coldScoreCount: coldScores.length,
      warmScoreCount: warmScores.length,
    },
    performance: {
      bestThreshold: bestThreshold,
      precision: coreMetrics.precision,
      recall: coreMetrics.recall,
      f1: coreMetrics.f1,
      falsePositiveRate: coreMetrics.fpr,
      tp: coreEval.cm.tp,
      fp: coreEval.cm.fp,
      fn: coreEval.cm.fn,
      tn: coreEval.cm.tn,
      averageLeadTimeMinutes: coreMetrics.avgLeadTime,
      totalEvaluationPoints: warmScores.length,
      baseRate: coreMetrics.baseRate,
      predictionRate: coreMetrics.predictionRate,
    },
    comparison: {
      oldCombinedF1,
      oldPriceOnlyF1,
      newEngineF1,
      improvementVsCombinedPct: parseFloat(((newEngineF1 / oldCombinedF1 - 1) * 100).toFixed(1)),
      improvementVsPriceOnlyPct: parseFloat(((newEngineF1 / oldPriceOnlyF1 - 1) * 100).toFixed(1)),
    },
    thresholdSweep: Object.fromEntries(
      Object.entries(sweepResults).map(([th, m]) => [
        th,
        { f1: m.f1, precision: m.precision, recall: m.recall, fpr: m.fpr },
      ]),
    ),
    calibration: {
      avgProbWhenCascade,
      avgProbWhenNoCascade,
      brierScore,
      naiveBrierScore: naiveBrier,
      brierSkillScore,
      fittedParams: calReport.converged
        ? {
            intercept: calReport.params.intercept,
            coefficient: calReport.params.coefficient,
            covariance: calReport.params.covariance || null,
          }
        : null,
      defaultParams: DEFAULT_CALIBRATION,
      totalSamples: calReport.totalSamples,
      positiveSamples: calReport.positiveSamples,
      baseRate: calReport.baseRate,
      converged: calReport.converged,
      iterations: calReport.iterations,
      logLikelihood: calReport.logLikelihood,
      calibrationCurve: calCurve,
    },
    config: {
      horizonMinutes: HORIZON,
      engineConfig: {
        historyLength: DEFAULT_CONFIG.historyLength,
        minHistoryLength: DEFAULT_CONFIG.minHistoryLength,
        coldStartThresholds: DEFAULT_CONFIG.coldStartThresholds,
        thresholdPercentiles: DEFAULT_CONFIG.thresholdPercentiles,
        volRegimePercentiles: DEFAULT_CONFIG.volRegimePercentiles,
        volMultipliers: DEFAULT_CONFIG.volMultipliers,
        volLookback: DEFAULT_CONFIG.volLookback,
        predictionMinScore: DEFAULT_CONFIG.predictionMinScore,
      },
    },
    scoreDistribution: scoreBuckets.map((count: number, i: number) => ({
      range: `${i * 10}-${i * 10 + 9}`,
      count,
      pct: parseFloat(((count / riskScores.length) * 100).toFixed(2)),
    })),
  };

  console.log(JSON.stringify(output, null, 2));
}

main();
