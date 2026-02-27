/**
 * Dual-Track Rare-Event Forecasting Research Framework
 *
 * Track A: Volatility Stress Model (price-defined cascades)
 * Track B: Liquidation Cascade Model (leverage-defined, forward only)
 * Robustness: Walk-forward, monthly stability, threshold sensitivity
 *
 * All computation runs against real PostgreSQL data.
 * No synthetic data. No fabricated indicators.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... npx tsx scripts/research.ts [symbol] [days]
 */

import pg from 'pg';
import { writeFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SYMBOL = process.argv[2] || 'BTCUSDT';
const DAYS = Number(process.argv[3]) || 90;

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://prism:prism@localhost:5432/prism';
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });

const END = new Date();
const START = new Date(END.getTime() - DAYS * 86_400_000);
const startIso = START.toISOString();
const endIso = END.toISOString();

// Stress engine parameters (match cascade.ts defaults)
const Z_SCORE_SCALING = 20;
const ROLLING_WINDOW = 1440;         // 24h for z-score
const VOL_WINDOW = 30;               // 30-min realized vol
const PREDICTION_MIN_SCORE = 40;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query<T>(sql, params);
  return res.rows;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function sigmoid(x: number): number {
  if (x > 500) return 1;
  if (x < -500) return 0;
  return 1 / (1 + Math.exp(-x));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ═══════════════════════════════════════════════════════════════════════════
// TRACK A — VOLATILITY STRESS FORECASTING
// ═══════════════════════════════════════════════════════════════════════════

// ---------------------------------------------------------------------------
// A1 — Cascade ground truth (3 definitions, from mark_prices)
// ---------------------------------------------------------------------------

async function stepA1() {
  console.log('\n' + '═'.repeat(68));
  console.log('  TRACK A — STEP A1: CASCADE GROUND TRUTH');
  console.log('═'.repeat(68));

  // Compute 30-min returns and rolling volatility in SQL
  // Definition 1: |30-min return| >= 2%
  // Definition 2: Top 1% of 30-min realized vol windows
  // Definition 3: |30-min return| >= 3σ of rolling 30-min vol

  // First, create a temp table with 30-min forward returns and rolling vol
  await pool.query(`DROP TABLE IF EXISTS _research_returns`);
  await pool.query(`
    CREATE TEMP TABLE _research_returns AS
    WITH prices AS (
      SELECT timestamp AS ts, mark_price AS px,
        ROW_NUMBER() OVER (ORDER BY timestamp) AS rn
      FROM mark_prices
      WHERE symbol = $1 AND timestamp >= $2 AND timestamp < $3
      ORDER BY timestamp
    ),
    with_fwd AS (
      SELECT p.ts, p.px, p.rn,
        -- 30-min forward return
        fwd.px AS fwd_px,
        LN(fwd.px / p.px) AS ret_30m,
        -- 1-min log return
        LN(p.px / prev.px) AS ret_1m
      FROM prices p
      LEFT JOIN prices fwd ON fwd.rn = p.rn + 30
      LEFT JOIN prices prev ON prev.rn = p.rn - 1
    )
    SELECT ts, px, rn, ret_30m, ret_1m,
      ABS(ret_30m) AS abs_ret_30m
    FROM with_fwd
  `, [SYMBOL, startIso, endIso]);

  // Compute rolling 30-min realized vol (stddev of 1-min returns over last 30 minutes)
  await pool.query(`DROP TABLE IF EXISTS _research_features`);
  await pool.query(`
    CREATE TEMP TABLE _research_features AS
    SELECT ts, px, rn, ret_30m, ret_1m, abs_ret_30m,
      STDDEV(ret_1m) OVER (ORDER BY rn ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS rv_30m,
      AVG(ret_1m) OVER (ORDER BY rn ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS avg_ret_30m,
      COUNT(ret_1m) OVER (ORDER BY rn ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS rv_cnt
    FROM _research_returns
  `);

  // Definition 1: |30-min return| >= 2%
  const def1 = await q<{ cnt: string }>(`
    SELECT COUNT(*)::TEXT AS cnt FROM _research_features
    WHERE abs_ret_30m >= 0.02 AND ret_30m IS NOT NULL
  `);

  // Definition 2: Top 1% of 30-min realized vol
  const rvP99 = await q<{ p99: string }>(`
    SELECT PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY rv_30m)::TEXT AS p99
    FROM _research_features WHERE rv_30m IS NOT NULL AND rv_cnt >= 20
  `);
  const rvThreshold = num(rvP99[0]?.p99);
  const def2 = await q<{ cnt: string }>(`
    SELECT COUNT(*)::TEXT AS cnt FROM _research_features
    WHERE rv_30m >= ${rvThreshold} AND rv_30m IS NOT NULL AND rv_cnt >= 20
  `);

  // Definition 3: |30-min return| >= 3σ of rolling 30-min vol
  const def3 = await q<{ cnt: string }>(`
    SELECT COUNT(*)::TEXT AS cnt FROM _research_features
    WHERE ret_30m IS NOT NULL AND rv_30m IS NOT NULL AND rv_30m > 0
    AND ABS(ret_30m) >= 3 * rv_30m * SQRT(30)
  `);

  // Total minutes in dataset
  const totalMin = await q<{ cnt: string }>(`SELECT COUNT(*)::TEXT AS cnt FROM _research_features`);
  const N = num(totalMin[0].cnt);

  // Build cascade label table (union of definitions, deduped by hour)
  await pool.query(`DROP TABLE IF EXISTS _cascade_labels`);
  await pool.query(`
    CREATE TEMP TABLE _cascade_labels AS
    WITH raw_labels AS (
      SELECT ts, ret_30m, abs_ret_30m, rv_30m,
        CASE WHEN abs_ret_30m >= 0.02 THEN true ELSE false END AS def1,
        CASE WHEN rv_30m >= ${rvThreshold} AND rv_cnt >= 20 THEN true ELSE false END AS def2,
        CASE WHEN rv_30m > 0 AND ABS(ret_30m) >= 3 * rv_30m * SQRT(30) AND rv_cnt >= 20 THEN true ELSE false END AS def3
      FROM _research_features
      WHERE ret_30m IS NOT NULL
    )
    SELECT *,
      (def1 OR def2 OR def3) AS any_cascade,
      (def1 AND (def2 OR def3)) AS strict_cascade
    FROM raw_labels
  `);

  // Deduped cascade events (1 per hour for def1)
  const cascadeEvents = await q<{
    hr: string; max_move: string; direction: string;
  }>(`
    WITH hourly AS (
      SELECT date_trunc('hour', ts) AS hr,
        MAX(abs_ret_30m) AS max_move,
        (ARRAY_AGG(ret_30m ORDER BY abs_ret_30m DESC))[1] AS top_ret
      FROM _cascade_labels
      WHERE def1 = true
      GROUP BY 1
    )
    SELECT hr::TEXT, (max_move * 100)::TEXT AS max_move,
      CASE WHEN top_ret < 0 THEN 'DOWN' ELSE 'UP' END AS direction
    FROM hourly ORDER BY hr
  `);

  // Monthly distribution
  const monthly = await q<{ month: string; cnt: string }>(`
    SELECT TO_CHAR(ts, 'YYYY-MM') AS month, COUNT(DISTINCT date_trunc('hour', ts))::TEXT AS cnt
    FROM _cascade_labels WHERE def1 = true GROUP BY 1 ORDER BY 1
  `);

  // Clustering: inter-event gaps
  const clustering = await q<{ mean_gap_h: string; std_gap_h: string; cv: string }>(`
    WITH events AS (
      SELECT DISTINCT date_trunc('hour', ts) AS hr FROM _cascade_labels WHERE def1 = true
    ),
    gaps AS (
      SELECT EXTRACT(EPOCH FROM hr - LAG(hr) OVER (ORDER BY hr)) / 3600 AS gap_h
      FROM events
    )
    SELECT AVG(gap_h)::TEXT AS mean_gap_h, STDDEV(gap_h)::TEXT AS std_gap_h,
      (STDDEV(gap_h) / NULLIF(AVG(gap_h), 0))::TEXT AS cv
    FROM gaps WHERE gap_h IS NOT NULL
  `);

  const stats = {
    definition1: { label: '|30m ret| >= 2%', count_minutes: num(def1[0].cnt), deduped_events: cascadeEvents.length },
    definition2: { label: 'Top 1% 30m RV', threshold: rvThreshold, count_minutes: num(def2[0].cnt) },
    definition3: { label: '|30m ret| >= 3σ×√30', count_minutes: num(def3[0].cnt) },
    total_minutes: N,
    base_rate_def1: num(def1[0].cnt) / N,
    base_rate_def1_hourly: cascadeEvents.length / (N / 60),
    monthly_distribution: Object.fromEntries(monthly.map(m => [m.month, num(m.cnt)])),
    clustering: {
      mean_gap_hours: num(clustering[0]?.mean_gap_h),
      std_gap_hours: num(clustering[0]?.std_gap_h),
      cv: num(clustering[0]?.cv),
    },
    events: cascadeEvents.slice(0, 20).map(e => ({
      time: e.hr, move_pct: num(e.max_move).toFixed(2), direction: e.direction,
    })),
  };

  console.log(`  Definition 1 (|30m ret| >= 2%):     ${stats.definition1.count_minutes} minutes, ${stats.definition1.deduped_events} unique events`);
  console.log(`  Definition 2 (top 1% 30m RV):       ${stats.definition2.count_minutes} minutes (threshold: ${rvThreshold.toExponential(3)})`);
  console.log(`  Definition 3 (|30m ret| >= 3σ√30):  ${stats.definition3.count_minutes} minutes`);
  console.log(`  Base rate (def1, per minute):        ${(stats.base_rate_def1 * 100).toFixed(4)}%`);
  console.log(`  Base rate (def1, per hour):          ${(stats.base_rate_def1_hourly * 100).toFixed(2)}%`);
  console.log(`  Cluster CV (inter-event gap):        ${stats.clustering.cv.toFixed(3)}`);
  console.log(`  Monthly distribution:                ${JSON.stringify(stats.monthly_distribution)}`);

  return stats;
}

// ---------------------------------------------------------------------------
// A2 — Feature engineering (strictly from real data)
// ---------------------------------------------------------------------------

async function stepA2() {
  console.log('\n' + '═'.repeat(68));
  console.log('  TRACK A — STEP A2: FEATURE ENGINEERING');
  console.log('═'.repeat(68));

  // Build feature matrix: for each minute, compute features using only past data
  // f1: z-score of |1-min return| vs rolling 24h (1440 min)
  // f2: rolling 30-min realized vol
  // f3: OI change z-score (interpolated to 1-min from 5-min)
  // f4: funding regime indicator (+1 / 0 / -1)
  // f5: volatility tercile (1 / 2 / 3)

  // Compute stress score (proxy for CascadePredictor.analyze())
  // stressZ = z-score of price deviation proxy → riskScore = stressZ * 20, clamped [0,100]

  await pool.query(`DROP TABLE IF EXISTS _feature_matrix`);
  await pool.query(`
    CREATE TEMP TABLE _feature_matrix AS
    WITH base AS (
      SELECT ts, px, rn, ret_1m, rv_30m,
        -- f1: z-score of |1-min return| vs rolling 1440-min
        AVG(ABS(ret_1m)) OVER w_24h AS avg_abs_ret_24h,
        STDDEV(ABS(ret_1m)) OVER w_24h AS std_abs_ret_24h,
        COUNT(ret_1m) OVER w_24h AS warmup_cnt,
        -- rv_30m already computed (f2)
        -- f5 prep: rv percentile over 3-day rolling
        PERCENT_RANK() OVER (ORDER BY rv_30m) AS rv_pctile
      FROM _research_features
      WINDOW w_24h AS (ORDER BY rn ROWS BETWEEN 1440 PRECEDING AND 1 PRECEDING)
    ),
    with_zscore AS (
      SELECT *,
        -- f1: z-score of current |ret_1m| vs 24h rolling
        CASE WHEN std_abs_ret_24h > 0 AND warmup_cnt >= 60
          THEN (ABS(ret_1m) - avg_abs_ret_24h) / std_abs_ret_24h
          ELSE 0 END AS f1_ret_zscore,
        -- f2: rolling realized vol (already computed)
        rv_30m AS f2_rv30m,
        -- f5: vol tercile
        CASE WHEN rv_pctile < 0.333 THEN 1
             WHEN rv_pctile < 0.667 THEN 2
             ELSE 3 END AS f5_vol_tercile,
        -- Stress score proxy: z-score of price deviation
        -- Using |1-min return| as proxy for cross-exchange spread
        CASE WHEN std_abs_ret_24h > 0 AND warmup_cnt >= ${ROLLING_WINDOW}
          THEN GREATEST(0, (ABS(ret_1m) - avg_abs_ret_24h) / std_abs_ret_24h) * ${Z_SCORE_SCALING}
          ELSE 0 END AS raw_risk_score
      FROM base
    )
    SELECT ws.*,
      LEAST(100, GREATEST(0, ROUND(raw_risk_score))) AS risk_score
    FROM with_zscore ws
  `);

  // Add OI features (f3) — join nearest OI reading
  await pool.query(`
    ALTER TABLE _feature_matrix ADD COLUMN IF NOT EXISTS f3_oi_zscore DOUBLE PRECISION DEFAULT 0
  `);
  await pool.query(`
    WITH oi_series AS (
      SELECT timestamp AS oi_ts, open_interest_usd AS oi,
        LAG(open_interest_usd) OVER (ORDER BY timestamp) AS prev_oi,
        AVG(open_interest_usd) OVER (ORDER BY timestamp ROWS BETWEEN 288 PRECEDING AND 1 PRECEDING) AS avg_oi,
        STDDEV(open_interest_usd) OVER (ORDER BY timestamp ROWS BETWEEN 288 PRECEDING AND 1 PRECEDING) AS std_oi
      FROM open_interest WHERE symbol = $1 AND timestamp >= $2 AND timestamp < $3
    ),
    oi_zscore AS (
      SELECT oi_ts,
        CASE WHEN std_oi > 0 THEN (oi - avg_oi) / std_oi ELSE 0 END AS oi_z
      FROM oi_series WHERE prev_oi IS NOT NULL
    )
    UPDATE _feature_matrix fm SET f3_oi_zscore = oz.oi_z
    FROM oi_zscore oz
    WHERE fm.ts = (SELECT MAX(oi_ts) FROM oi_zscore WHERE oi_ts <= fm.ts)
  `, [SYMBOL, startIso, endIso]);

  // Add funding regime (f4) — join nearest funding rate
  await pool.query(`
    ALTER TABLE _feature_matrix ADD COLUMN IF NOT EXISTS f4_funding_regime INTEGER DEFAULT 0
  `);
  await pool.query(`
    WITH fr_series AS (
      SELECT funding_time AS fr_ts, funding_rate AS fr
      FROM funding_rates WHERE symbol = $1 AND funding_time >= $2 AND funding_time < $3
    )
    UPDATE _feature_matrix fm SET f4_funding_regime =
      CASE WHEN frs.fr > 0.0001 THEN 1
           WHEN frs.fr < -0.0001 THEN -1
           ELSE 0 END
    FROM (
      SELECT DISTINCT ON (fm2.ts) fm2.ts, fr_series.fr
      FROM _feature_matrix fm2
      CROSS JOIN LATERAL (
        SELECT fr FROM fr_series WHERE fr_ts <= fm2.ts ORDER BY fr_ts DESC LIMIT 1
      ) fr_series
    ) frs
    WHERE fm.ts = frs.ts
  `, [SYMBOL, startIso, endIso]);

  // Feature summary
  const summary = await q<{
    total: string; warmup: string;
    f1_mean: string; f1_std: string;
    f2_mean: string; f2_std: string;
    f3_mean: string; f3_std: string;
    rs_mean: string; rs_std: string; rs_p50: string; rs_p95: string; rs_p99: string;
  }>(`
    SELECT
      COUNT(*)::TEXT AS total,
      COUNT(*) FILTER (WHERE warmup_cnt >= ${ROLLING_WINDOW})::TEXT AS warmup,
      AVG(f1_ret_zscore)::TEXT AS f1_mean, STDDEV(f1_ret_zscore)::TEXT AS f1_std,
      AVG(f2_rv30m)::TEXT AS f2_mean, STDDEV(f2_rv30m)::TEXT AS f2_std,
      AVG(f3_oi_zscore)::TEXT AS f3_mean, STDDEV(f3_oi_zscore)::TEXT AS f3_std,
      AVG(risk_score)::TEXT AS rs_mean, STDDEV(risk_score)::TEXT AS rs_std,
      PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY risk_score)::TEXT AS rs_p50,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY risk_score)::TEXT AS rs_p95,
      PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY risk_score)::TEXT AS rs_p99
    FROM _feature_matrix
  `);
  const s = summary[0];

  const schema = {
    total_rows: num(s.total),
    warmed_up_rows: num(s.warmup),
    features: {
      f1_ret_zscore: { mean: num(s.f1_mean), std: num(s.f1_std), description: 'z-score of |1-min return| vs 24h rolling' },
      f2_rv30m: { mean: num(s.f2_mean), std: num(s.f2_std), description: '30-min rolling realized volatility' },
      f3_oi_zscore: { mean: num(s.f3_mean), std: num(s.f3_std), description: 'OI z-score vs 24h rolling (5-min granularity)' },
      f4_funding_regime: { values: [-1, 0, 1], description: 'Funding regime: -1=negative, 0=neutral, +1=positive' },
      f5_vol_tercile: { values: [1, 2, 3], description: 'Volatility tercile (low/med/high)' },
    },
    risk_score: { mean: num(s.rs_mean), std: num(s.rs_std), p50: num(s.rs_p50), p95: num(s.rs_p95), p99: num(s.rs_p99) },
  };

  console.log(`  Total rows    : ${schema.total_rows.toLocaleString()}`);
  console.log(`  Warmed-up     : ${schema.warmed_up_rows.toLocaleString()}`);
  console.log(`  Risk score dist: mean=${num(s.rs_mean).toFixed(2)} std=${num(s.rs_std).toFixed(2)} p50=${num(s.rs_p50).toFixed(1)} p95=${num(s.rs_p95).toFixed(1)} p99=${num(s.rs_p99).toFixed(1)}`);

  return schema;
}

// ---------------------------------------------------------------------------
// A3 — Stress engine evaluation (threshold sweep, PR, AUC-PR)
// ---------------------------------------------------------------------------

async function stepA3() {
  console.log('\n' + '═'.repeat(68));
  console.log('  TRACK A — STEP A3: STRESS ENGINE EVALUATION');
  console.log('═'.repeat(68));

  // Join feature matrix with cascade labels
  // For each risk_score threshold, compute confusion matrix

  // Use definition 1 as primary label (|30-min return| >= 2%)
  // Label is FORWARD-LOOKING: cascade happens in the next 30 minutes
  const sweepResults = await q<{
    threshold: string; tp: string; fp: string; fn_val: string; tn: string;
  }>(`
    WITH labeled AS (
      SELECT fm.ts, fm.risk_score,
        COALESCE(cl.def1, false) AS is_cascade
      FROM _feature_matrix fm
      LEFT JOIN _cascade_labels cl ON cl.ts = fm.ts
      WHERE fm.warmup_cnt >= ${ROLLING_WINDOW}
    ),
    thresholds AS (
      SELECT generate_series(0, 100, 5) AS t
    )
    SELECT t::TEXT AS threshold,
      COUNT(*) FILTER (WHERE risk_score >= t AND is_cascade)::TEXT AS tp,
      COUNT(*) FILTER (WHERE risk_score >= t AND NOT is_cascade)::TEXT AS fp,
      COUNT(*) FILTER (WHERE risk_score < t AND is_cascade)::TEXT AS fn_val,
      COUNT(*) FILTER (WHERE risk_score < t AND NOT is_cascade)::TEXT AS tn
    FROM labeled, thresholds
    GROUP BY t ORDER BY t
  `);

  const prCurve: Array<{
    threshold: number; precision: number; recall: number; f1: number; fpr: number;
  }> = [];

  let bestF1 = 0;
  let bestThreshold = 0;

  for (const row of sweepResults) {
    const t = num(row.threshold);
    const tp = num(row.tp);
    const fp = num(row.fp);
    const fn = num(row.fn_val);
    const tn = num(row.tn);
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
    const fpr = fp + tn > 0 ? fp / (fp + tn) : 0;
    prCurve.push({ threshold: t, precision, recall, f1, fpr });
    if (f1 > bestF1) { bestF1 = f1; bestThreshold = t; }
  }

  // AUC-PR (trapezoidal integration over recall-precision pairs)
  const sorted = [...prCurve].sort((a, b) => a.recall - b.recall);
  let aucPR = 0;
  for (let i = 1; i < sorted.length; i++) {
    const dRecall = sorted[i].recall - sorted[i - 1].recall;
    const avgPrec = (sorted[i].precision + sorted[i - 1].precision) / 2;
    aucPR += dRecall * avgPrec;
  }

  // Average lead time (how early does score exceed threshold before cascade?)
  const leadTime = await q<{ avg_lead: string; median_lead: string }>(`
    WITH cascade_starts AS (
      SELECT ts FROM _cascade_labels
      WHERE def1 = true AND ts = (
        SELECT MIN(ts) FROM _cascade_labels cl2
        WHERE cl2.def1 = true AND cl2.ts >= _cascade_labels.ts - interval '30 minutes'
          AND cl2.ts <= _cascade_labels.ts
      )
    ),
    alerts AS (
      SELECT cs.ts AS cascade_ts,
        MAX(fm.ts) FILTER (WHERE fm.risk_score >= ${bestThreshold} AND fm.ts < cs.ts AND fm.ts >= cs.ts - interval '60 minutes') AS alert_ts
      FROM cascade_starts cs
      CROSS JOIN _feature_matrix fm
      WHERE fm.ts >= cs.ts - interval '60 minutes' AND fm.ts <= cs.ts
      GROUP BY cs.ts
    )
    SELECT
      AVG(EXTRACT(EPOCH FROM cascade_ts - alert_ts) / 60)::TEXT AS avg_lead,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM cascade_ts - alert_ts) / 60)::TEXT AS median_lead
    FROM alerts WHERE alert_ts IS NOT NULL
  `);

  // Random baseline: precision = base_rate
  const baseRate = await q<{ br: string }>(`
    SELECT AVG(CASE WHEN def1 THEN 1.0 ELSE 0.0 END)::TEXT AS br
    FROM _cascade_labels
  `);

  const performance = {
    best_threshold: bestThreshold,
    best_f1: bestF1,
    pr_curve: prCurve,
    auc_pr: aucPR,
    lead_time: {
      avg_minutes: num(leadTime[0]?.avg_lead),
      median_minutes: num(leadTime[0]?.median_lead),
    },
    baselines: {
      random_precision: num(baseRate[0]?.br),
      always_negative_recall: 0,
      always_negative_f1: 0,
    },
  };

  // Print key metrics
  const best = prCurve.find(p => p.threshold === bestThreshold)!;
  console.log(`  Best threshold   : ${bestThreshold}`);
  console.log(`  Best F1          : ${bestF1.toFixed(4)}`);
  console.log(`  Precision        : ${best.precision.toFixed(4)}`);
  console.log(`  Recall           : ${best.recall.toFixed(4)}`);
  console.log(`  FPR              : ${best.fpr.toFixed(4)}`);
  console.log(`  AUC-PR           : ${aucPR.toFixed(4)}`);
  console.log(`  Lead time (avg)  : ${num(leadTime[0]?.avg_lead).toFixed(1)} min`);
  console.log(`  Random baseline  : ${(num(baseRate[0]?.br) * 100).toFixed(4)}% precision`);

  console.log('\n  Threshold sweep (selected):');
  for (const row of prCurve.filter(r => r.threshold % 20 === 0)) {
    console.log(`    T=${String(row.threshold).padStart(3)} | P=${row.precision.toFixed(4)} R=${row.recall.toFixed(4)} F1=${row.f1.toFixed(4)} FPR=${row.fpr.toFixed(4)}`);
  }

  return performance;
}

// ---------------------------------------------------------------------------
// A4 — Calibration (logistic regression, Brier score, reliability)
// ---------------------------------------------------------------------------

async function stepA4() {
  console.log('\n' + '═'.repeat(68));
  console.log('  TRACK A — STEP A4: CALIBRATION');
  console.log('═'.repeat(68));

  // Bin risk scores 0-100, count events and non-events per bin
  const bins = await q<{ bin: string; total: string; cascades: string }>(`
    SELECT (FLOOR(fm.risk_score / 5) * 5)::TEXT AS bin,
      COUNT(*)::TEXT AS total,
      COUNT(*) FILTER (WHERE COALESCE(cl.def1, false))::TEXT AS cascades
    FROM _feature_matrix fm
    LEFT JOIN _cascade_labels cl ON cl.ts = fm.ts
    WHERE fm.warmup_cnt >= ${ROLLING_WINDOW}
    GROUP BY 1 ORDER BY 1::INT
  `);

  // Fit logistic regression via IRLS
  const binData = bins.map(b => ({
    score: num(b.bin) + 2.5, // bin center
    total: num(b.total),
    events: num(b.cascades),
  }));

  // IRLS fit
  let a = -5.0; // intercept
  let b = 0.1;  // coefficient
  const lambda = 0.01; // L2 regularization

  for (let iter = 0; iter < 50; iter++) {
    let g0 = 0, g1 = 0;
    let j00 = 0, j01 = 0, j11 = 0;

    for (const bin of binData) {
      if (bin.total === 0) continue;
      const s = bin.score;
      const p = sigmoid(a + b * s);
      const r = bin.events - bin.total * p;
      const w = bin.total * p * (1 - p);

      g0 += r;
      g1 += r * s;
      j00 += w;
      j01 += w * s;
      j11 += w * s * s;
    }

    // L2 regularization
    g0 -= lambda * a;
    g1 -= lambda * b;
    j00 += lambda;
    j11 += lambda;

    // Solve 2x2: J * [da, db] = g
    const det = j00 * j11 - j01 * j01;
    if (Math.abs(det) < 1e-15) break;
    const da = (j11 * g0 - j01 * g1) / det;
    const db = (j00 * g1 - j01 * g0) / det;

    a += da;
    b += db;

    if (Math.abs(da) < 1e-8 && Math.abs(db) < 1e-8) break;
  }

  // Compute Brier score
  let brierSum = 0;
  let brierN = 0;
  let baselineSum = 0;
  const totalEvents = binData.reduce((s, d) => s + d.events, 0);
  const totalObs = binData.reduce((s, d) => s + d.total, 0);
  const baseRate = totalObs > 0 ? totalEvents / totalObs : 0;

  const reliabilityCurve: Array<{ bin: number; predicted: number; observed: number; count: number }> = [];

  for (const bin of binData) {
    if (bin.total === 0) continue;
    const predicted = sigmoid(a + b * bin.score);
    const observed = bin.events / bin.total;

    brierSum += bin.total * (predicted - observed) ** 2;
    baselineSum += bin.total * (baseRate - observed) ** 2;
    brierN += bin.total;

    reliabilityCurve.push({
      bin: bin.score,
      predicted: Number(predicted.toFixed(6)),
      observed: Number(observed.toFixed(6)),
      count: bin.total,
    });
  }

  const brierScore = brierN > 0 ? brierSum / brierN : 0;
  const brierBaseline = brierN > 0 ? baselineSum / brierN : 0;
  const brierSkill = brierBaseline > 0 ? 1 - brierScore / brierBaseline : 0;

  const calibration = {
    fitted_params: { intercept: a, coefficient: b },
    brier_score: brierScore,
    brier_skill_score: brierSkill,
    base_rate: baseRate,
    reliability_curve: reliabilityCurve,
    score_to_probability: [0, 20, 40, 50, 60, 80, 100].map(s => ({
      score: s, probability: sigmoid(a + b * s),
    })),
  };

  console.log(`  Fitted: P(cascade) = σ(${a.toFixed(4)} + ${b.toFixed(4)} × score)`);
  console.log(`  Brier score       : ${brierScore.toFixed(6)}`);
  console.log(`  Brier skill score : ${brierSkill.toFixed(4)}`);
  console.log(`  Base rate         : ${(baseRate * 100).toFixed(4)}%`);
  console.log('\n  Score → Probability mapping:');
  for (const m of calibration.score_to_probability) {
    console.log(`    Score ${String(m.score).padStart(3)} → P = ${(m.probability * 100).toFixed(3)}%`);
  }
  console.log('\n  Reliability curve:');
  for (const r of reliabilityCurve.filter(r => r.count > 100)) {
    console.log(`    Bin ${String(r.bin).padStart(4)} | Predicted: ${(r.predicted * 100).toFixed(3)}% | Observed: ${(r.observed * 100).toFixed(3)}% | n=${r.count.toLocaleString()}`);
  }

  return calibration;
}

// ═══════════════════════════════════════════════════════════════════════════
// TRACK B — LIQUIDATION CASCADE FORECASTING
// ═══════════════════════════════════════════════════════════════════════════

async function trackB() {
  console.log('\n' + '═'.repeat(68));
  console.log('  TRACK B — LIQUIDATION CASCADE FORECASTING');
  console.log('═'.repeat(68));

  // Check if liquidation data exists
  const liqCount = await q<{ cnt: string }>(`
    SELECT COUNT(*)::TEXT AS cnt FROM liquidations
    WHERE symbol = $1 AND timestamp >= $2 AND timestamp < $3
  `, [SYMBOL, startIso, endIso]);
  const nLiq = num(liqCount[0].cnt);

  if (nLiq === 0) {
    console.log('\n  Liquidation data: 0 rows');
    console.log('  Track B requires live-collected liquidation data.');
    console.log('  Run `npm run ingest` to begin forward collection.');
    console.log('  Track B will be evaluable once sufficient liquidation history exists.');
    console.log('  Minimum recommended: 7 days of continuous collection.\n');
    return {
      status: 'INSUFFICIENT_DATA',
      liquidation_rows: 0,
      recommendation: 'Start live ingestion (npm run ingest). Minimum 7 days for B1-B2, 30 days for B3-B4.',
      framework_ready: true,
    };
  }

  // B1 — Liquidation bursts
  console.log(`\n  Liquidation rows: ${nLiq.toLocaleString()}`);
  console.log('\n  --- B1: Liquidation Burst Detection ---');

  const burstStats = await q<{
    p95_vol: string; p95_cnt: string; total_5m_bins: string; burst_bins: string;
  }>(`
    WITH bins5 AS (
      SELECT date_trunc('minute', timestamp) - (EXTRACT(MINUTE FROM timestamp)::INT % 5) * interval '1 minute' AS bin,
        SUM(usd_value) AS vol, COUNT(*) AS cnt
      FROM liquidations WHERE symbol = $1 AND timestamp >= $2 AND timestamp < $3
      GROUP BY 1
    )
    SELECT
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY vol)::TEXT AS p95_vol,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY cnt)::TEXT AS p95_cnt,
      COUNT(*)::TEXT AS total_5m_bins,
      COUNT(*) FILTER (WHERE vol >= PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY vol))::TEXT AS burst_bins
    FROM bins5
  `, [SYMBOL, startIso, endIso]);

  console.log(`  5-min bins with liqs : ${num(burstStats[0]?.total_5m_bins)}`);
  console.log(`  Burst threshold (vol): $${num(burstStats[0]?.p95_vol).toFixed(0)}`);
  console.log(`  Burst threshold (cnt): ${num(burstStats[0]?.p95_cnt)} events`);

  // B2 — True liquidation cascades
  console.log('\n  --- B2: Liquidation Cascade Detection ---');

  // Create burst table
  await pool.query(`DROP TABLE IF EXISTS _liq_bursts`);
  const p95Vol = num(burstStats[0]?.p95_vol);
  await pool.query(`
    CREATE TEMP TABLE _liq_bursts AS
    WITH bins5 AS (
      SELECT date_trunc('minute', timestamp) - (EXTRACT(MINUTE FROM timestamp)::INT % 5) * interval '1 minute' AS bin,
        SUM(usd_value) AS vol, COUNT(*) AS cnt
      FROM liquidations WHERE symbol = $1 AND timestamp >= $2 AND timestamp < $3
      GROUP BY 1
    )
    SELECT bin, vol, cnt FROM bins5 WHERE vol >= ${p95Vol}
  `, [SYMBOL, startIso, endIso]);

  // True cascade = price move >= 2% in 30 min AND burst within ±10 min
  const trueCascades = await q<{ cnt: string }>(`
    SELECT COUNT(DISTINCT date_trunc('hour', cl.ts))::TEXT AS cnt
    FROM _cascade_labels cl
    WHERE cl.def1 = true
    AND EXISTS (
      SELECT 1 FROM _liq_bursts lb
      WHERE lb.bin >= cl.ts - interval '10 minutes'
        AND lb.bin <= cl.ts + interval '10 minutes'
    )
  `);

  console.log(`  True liquidation cascades: ${num(trueCascades[0]?.cnt)} events`);

  // B3 — Forward evaluation
  console.log('\n  --- B3: Stress Engine Forward Evaluation ---');

  // Same threshold sweep but against burst-confirmed cascades
  const sweepB = await q<{
    threshold: string; tp: string; fp: string; fn_val: string; tn: string;
  }>(`
    WITH labeled AS (
      SELECT fm.ts, fm.risk_score,
        CASE WHEN cl.def1 = true AND EXISTS (
          SELECT 1 FROM _liq_bursts lb WHERE lb.bin >= fm.ts - interval '10 minutes' AND lb.bin <= fm.ts + interval '10 minutes'
        ) THEN true ELSE false END AS is_cascade
      FROM _feature_matrix fm
      LEFT JOIN _cascade_labels cl ON cl.ts = fm.ts
      WHERE fm.warmup_cnt >= ${ROLLING_WINDOW}
    ),
    thresholds AS (
      SELECT generate_series(0, 100, 10) AS t
    )
    SELECT t::TEXT AS threshold,
      COUNT(*) FILTER (WHERE risk_score >= t AND is_cascade)::TEXT AS tp,
      COUNT(*) FILTER (WHERE risk_score >= t AND NOT is_cascade)::TEXT AS fp,
      COUNT(*) FILTER (WHERE risk_score < t AND is_cascade)::TEXT AS fn_val,
      COUNT(*) FILTER (WHERE risk_score < t AND NOT is_cascade)::TEXT AS tn
    FROM labeled, thresholds
    GROUP BY t ORDER BY t
  `);

  const bPerf = sweepB.map(row => {
    const tp = num(row.tp), fp = num(row.fp), fn = num(row.fn_val), tn = num(row.tn);
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
    return { threshold: num(row.threshold), precision, recall, f1 };
  });

  for (const r of bPerf) {
    console.log(`    T=${String(r.threshold).padStart(3)} | P=${r.precision.toFixed(4)} R=${r.recall.toFixed(4)} F1=${r.f1.toFixed(4)}`);
  }

  // B4 — Regime analysis
  console.log('\n  --- B4: Regime Analysis ---');
  const regime = await q<{
    tercile: string; total: string; cascades: string; avg_score: string;
  }>(`
    SELECT fm.f5_vol_tercile::TEXT AS tercile,
      COUNT(*)::TEXT AS total,
      COUNT(*) FILTER (WHERE COALESCE(cl.def1, false))::TEXT AS cascades,
      AVG(fm.risk_score)::TEXT AS avg_score
    FROM _feature_matrix fm
    LEFT JOIN _cascade_labels cl ON cl.ts = fm.ts
    WHERE fm.warmup_cnt >= ${ROLLING_WINDOW}
    GROUP BY 1 ORDER BY 1
  `);

  const regimeAnalysis = regime.map(r => ({
    regime: num(r.tercile) === 1 ? 'Low' : num(r.tercile) === 2 ? 'Mid' : 'High',
    total: num(r.total),
    cascades: num(r.cascades),
    cascade_rate: num(r.total) > 0 ? (num(r.cascades) / num(r.total) * 100).toFixed(4) + '%' : '0%',
    avg_risk_score: num(r.avg_score).toFixed(2),
  }));

  for (const r of regimeAnalysis) {
    console.log(`    ${r.regime.padEnd(5)} | n=${r.total.toLocaleString().padStart(8)} | cascades=${String(r.cascades).padStart(5)} | rate=${r.cascade_rate.padStart(8)} | avg_score=${r.avg_risk_score}`);
  }

  return {
    status: 'EVALUATED',
    liquidation_rows: nLiq,
    burst_stats: burstStats[0],
    true_cascades: num(trueCascades[0]?.cnt),
    performance: bPerf,
    regime_analysis: regimeAnalysis,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ROBUSTNESS TESTING
// ═══════════════════════════════════════════════════════════════════════════

async function robustnessTests() {
  console.log('\n' + '═'.repeat(68));
  console.log('  ROBUSTNESS TESTING');
  console.log('═'.repeat(68));

  // 1. Walk-forward: calibrate on first 60 days, test on last 30
  console.log('\n  --- Walk-Forward Evaluation ---');

  const splitDate = new Date(START.getTime() + 60 * 86_400_000);
  const splitIso = splitDate.toISOString();

  // Train calibration on first 60 days
  const trainBins = await q<{ bin: string; total: string; cascades: string }>(`
    SELECT (FLOOR(fm.risk_score / 5) * 5)::TEXT AS bin,
      COUNT(*)::TEXT AS total,
      COUNT(*) FILTER (WHERE COALESCE(cl.def1, false))::TEXT AS cascades
    FROM _feature_matrix fm
    LEFT JOIN _cascade_labels cl ON cl.ts = fm.ts
    WHERE fm.warmup_cnt >= ${ROLLING_WINDOW} AND fm.ts < $1
    GROUP BY 1 ORDER BY 1::INT
  `, [splitIso]);

  // IRLS on train data
  let wfA = -5.0, wfB = 0.1;
  for (let iter = 0; iter < 50; iter++) {
    let g0 = 0, g1 = 0, j00 = 0, j01 = 0, j11 = 0;
    for (const bin of trainBins) {
      const s = num(bin.bin) + 2.5, n = num(bin.total), y = num(bin.cascades);
      if (n === 0) continue;
      const p = sigmoid(wfA + wfB * s);
      const r = y - n * p, w = n * p * (1 - p);
      g0 += r; g1 += r * s;
      j00 += w; j01 += w * s; j11 += w * s * s;
    }
    g0 -= 0.01 * wfA; g1 -= 0.01 * wfB; j00 += 0.01; j11 += 0.01;
    const det = j00 * j11 - j01 * j01;
    if (Math.abs(det) < 1e-15) break;
    wfA += (j11 * g0 - j01 * g1) / det;
    wfB += (j00 * g1 - j01 * g0) / det;
  }

  // Test on last 30 days
  const testMetrics = await q<{
    brier: string; base_rate: string;
  }>(`
    WITH labeled AS (
      SELECT fm.risk_score,
        CASE WHEN COALESCE(cl.def1, false) THEN 1.0 ELSE 0.0 END AS y
      FROM _feature_matrix fm
      LEFT JOIN _cascade_labels cl ON cl.ts = fm.ts
      WHERE fm.warmup_cnt >= ${ROLLING_WINDOW} AND fm.ts >= $1
    )
    SELECT
      AVG(POWER(1.0 / (1.0 + EXP(-(${wfA} + ${wfB} * risk_score))) - y, 2))::TEXT AS brier,
      AVG(y)::TEXT AS base_rate
    FROM labeled
  `, [splitIso]);

  const testBrier = num(testMetrics[0]?.brier);
  const testBaseRate = num(testMetrics[0]?.base_rate);
  const testClimatology = testBaseRate * (1 - testBaseRate);
  const testBSS = testClimatology > 0 ? 1 - testBrier / testClimatology : 0;

  console.log(`  Train period     : ${startIso.slice(0, 10)} → ${splitIso.slice(0, 10)} (60 days)`);
  console.log(`  Test period      : ${splitIso.slice(0, 10)} → ${endIso.slice(0, 10)} (30 days)`);
  console.log(`  Train params     : a=${wfA.toFixed(4)}, b=${wfB.toFixed(4)}`);
  console.log(`  Test Brier score : ${testBrier.toFixed(6)}`);
  console.log(`  Test BSS         : ${testBSS.toFixed(4)}`);

  // 2. Monthly stability
  console.log('\n  --- Monthly Stability ---');
  const monthlyPerf = await q<{
    month: string; total: string; cascades: string; avg_score_cascade: string; avg_score_non: string;
  }>(`
    SELECT TO_CHAR(fm.ts, 'YYYY-MM') AS month,
      COUNT(*)::TEXT AS total,
      COUNT(*) FILTER (WHERE COALESCE(cl.def1, false))::TEXT AS cascades,
      AVG(fm.risk_score) FILTER (WHERE COALESCE(cl.def1, false))::TEXT AS avg_score_cascade,
      AVG(fm.risk_score) FILTER (WHERE NOT COALESCE(cl.def1, false))::TEXT AS avg_score_non
    FROM _feature_matrix fm
    LEFT JOIN _cascade_labels cl ON cl.ts = fm.ts
    WHERE fm.warmup_cnt >= ${ROLLING_WINDOW}
    GROUP BY 1 ORDER BY 1
  `);

  const monthlyStability = monthlyPerf.map(m => ({
    month: m.month,
    minutes: num(m.total),
    cascades: num(m.cascades),
    avg_score_cascade: num(m.avg_score_cascade),
    avg_score_normal: num(m.avg_score_non),
    separation: num(m.avg_score_cascade) - num(m.avg_score_non),
  }));

  for (const m of monthlyStability) {
    console.log(`    ${m.month} | n=${m.minutes.toLocaleString().padStart(8)} | cascades=${String(m.cascades).padStart(5)} | Δscore=${m.separation.toFixed(2)}`);
  }

  // 3. Threshold sensitivity
  console.log('\n  --- Threshold Sensitivity ---');
  const optThreshold = (await q<{ t: string }>(`
    WITH labeled AS (
      SELECT fm.risk_score, COALESCE(cl.def1, false) AS y
      FROM _feature_matrix fm
      LEFT JOIN _cascade_labels cl ON cl.ts = fm.ts
      WHERE fm.warmup_cnt >= ${ROLLING_WINDOW}
    ),
    sweep AS (
      SELECT t,
        COUNT(*) FILTER (WHERE risk_score >= t AND y) AS tp,
        COUNT(*) FILTER (WHERE risk_score >= t AND NOT y) AS fp,
        COUNT(*) FILTER (WHERE risk_score < t AND y) AS fn
      FROM labeled, generate_series(0, 100, 1) t
      GROUP BY t
    )
    SELECT t::TEXT FROM sweep
    WHERE tp + fp > 0 AND tp + fn > 0
    ORDER BY 2.0 * tp / NULLIF(2.0 * tp + fp + fn, 0) DESC
    LIMIT 1
  `))[0];
  const optT = num(optThreshold?.t);

  // Evaluate at opt ±5
  const sensitivity = await q<{
    threshold: string; precision: string; recall: string; f1: string;
  }>(`
    WITH labeled AS (
      SELECT fm.risk_score, COALESCE(cl.def1, false) AS y
      FROM _feature_matrix fm
      LEFT JOIN _cascade_labels cl ON cl.ts = fm.ts
      WHERE fm.warmup_cnt >= ${ROLLING_WINDOW}
    )
    SELECT t::TEXT AS threshold,
      (COUNT(*) FILTER (WHERE risk_score >= t AND y)::FLOAT / NULLIF(COUNT(*) FILTER (WHERE risk_score >= t), 0))::TEXT AS precision,
      (COUNT(*) FILTER (WHERE risk_score >= t AND y)::FLOAT / NULLIF(COUNT(*) FILTER (WHERE y), 0))::TEXT AS recall,
      (2.0 * COUNT(*) FILTER (WHERE risk_score >= t AND y) / NULLIF(2.0 * COUNT(*) FILTER (WHERE risk_score >= t AND y) + COUNT(*) FILTER (WHERE risk_score >= t AND NOT y) + COUNT(*) FILTER (WHERE risk_score < t AND y), 0))::TEXT AS f1
    FROM labeled, generate_series(${Math.max(0, optT - 5)}, ${Math.min(100, optT + 5)}, 1) t
    GROUP BY t ORDER BY t
  `);

  console.log(`  Optimal threshold: ${optT}`);
  for (const r of sensitivity) {
    const marker = num(r.threshold) === optT ? ' ◀' : '';
    console.log(`    T=${String(num(r.threshold)).padStart(3)} | P=${num(r.precision).toFixed(4)} R=${num(r.recall).toFixed(4)} F1=${num(r.f1).toFixed(4)}${marker}`);
  }

  return {
    walk_forward: {
      train_period: `${startIso.slice(0, 10)} → ${splitIso.slice(0, 10)}`,
      test_period: `${splitIso.slice(0, 10)} → ${endIso.slice(0, 10)}`,
      train_params: { intercept: wfA, coefficient: wfB },
      test_brier: testBrier,
      test_bss: testBSS,
    },
    monthly_stability: monthlyStability,
    threshold_sensitivity: {
      optimal: optT,
      range: sensitivity.map(r => ({
        threshold: num(r.threshold),
        f1: num(r.f1),
      })),
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═'.repeat(68));
  console.log('  PRISM DUAL-TRACK RARE-EVENT FORECASTING RESEARCH');
  console.log(`  Symbol: ${SYMBOL} | Window: ${DAYS} days`);
  console.log(`  Range : ${startIso} → ${endIso}`);
  console.log('═'.repeat(68));

  // Verify data
  const dataCounts = await q<{ tbl: string; cnt: string }>(`
    SELECT 'mark_prices' AS tbl, COUNT(*)::TEXT AS cnt FROM mark_prices WHERE symbol=$1 AND timestamp >= $2 AND timestamp < $3
    UNION ALL SELECT 'funding_rates', COUNT(*)::TEXT FROM funding_rates WHERE symbol=$1 AND funding_time >= $2 AND funding_time < $3
    UNION ALL SELECT 'open_interest', COUNT(*)::TEXT FROM open_interest WHERE symbol=$1 AND timestamp >= $2 AND timestamp < $3
    UNION ALL SELECT 'liquidations', COUNT(*)::TEXT FROM liquidations WHERE symbol=$1 AND timestamp >= $2 AND timestamp < $3
  `, [SYMBOL, startIso, endIso]);

  console.log('\n  Data inventory:');
  for (const d of dataCounts) {
    console.log(`    ${d.tbl.padEnd(20)}: ${num(d.cnt).toLocaleString()} rows`);
  }

  if (num(dataCounts.find(d => d.tbl === 'mark_prices')?.cnt) === 0) {
    console.error('\n  FATAL: No mark price data. Run backfill first.');
    process.exit(1);
  }

  // Execute all phases
  const a1 = await stepA1();
  const a2 = await stepA2();
  const a3 = await stepA3();
  const a4 = await stepA4();
  const b = await trackB();
  const robustness = await robustnessTests();

  // Compile verdict
  const hasLiq = b.status === 'EVALUATED';
  const bestF1 = a3.best_f1;
  const bss = a4.brier_skill_score;
  const leadMin = a3.lead_time.avg_minutes;

  let verdict: string;
  if (bestF1 >= 0.15 && bss > 0) {
    verdict = `Model shows meaningful discriminative ability (F1=${bestF1.toFixed(3)}, BSS=${bss.toFixed(3)}). `;
  } else if (bestF1 > 0) {
    verdict = `Model shows weak but non-trivial signal (F1=${bestF1.toFixed(3)}, BSS=${bss.toFixed(3)}). `;
  } else {
    verdict = `Model shows no discriminative ability on this data. `;
  }

  if (leadMin > 5) {
    verdict += `Average lead time of ${leadMin.toFixed(1)} minutes provides actionable warning. `;
  } else if (leadMin > 0) {
    verdict += `Lead time of ${leadMin.toFixed(1)} minutes is short but non-zero. `;
  }

  if (!hasLiq) {
    verdict += 'Track B (liquidation cascades) blocked on data: live ingestion required. ';
    verdict += 'Framework is ready — begin collection with `npm run ingest`.';
  } else {
    verdict += `Track B evaluated with ${b.liquidation_rows} liquidation events.`;
  }

  // Full report
  const report = {
    trackA_volatilityModel: {
      cascadeStats: a1,
      featureSchema: a2,
      performance: a3,
      calibration: a4,
    },
    trackB_liquidationModel: b,
    robustness,
    executiveVerdict: verdict,
  };

  const outPath = `research-${SYMBOL}-${DAYS}d.json`;
  writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log('\n' + '═'.repeat(68));
  console.log('  EXECUTIVE VERDICT');
  console.log('═'.repeat(68));
  console.log(`\n  ${verdict}\n`);
  console.log(`  Full report: ${outPath}`);

  await pool.end();
}

main().catch(async (err) => {
  console.error('Research framework failed:', err);
  await pool.end();
  process.exit(1);
});
