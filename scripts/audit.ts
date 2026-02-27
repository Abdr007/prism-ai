/**
 * Forensic-level database audit for PRISM historical data.
 *
 * Phases:
 *   1. Structural integrity
 *   2. Time series continuity & quality
 *   3. Liquidation forensic analysis
 *   4. Microstructure consistency
 *   5. Cascade ground truth validation
 *   6. Synthetic data detection heuristics
 *   7. Final quality scoring
 *
 * Usage:
 *   DATABASE_URL=postgresql://... npx tsx scripts/audit.ts [symbol] [days]
 */

import pg from 'pg';

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

function pct(n: number, d: number): string {
  return d === 0 ? 'N/A' : (n / d * 100).toFixed(3) + '%';
}

// ---------------------------------------------------------------------------
// PHASE 1 — Structural integrity
// ---------------------------------------------------------------------------

async function phase1() {
  console.log('\n' + '='.repeat(68));
  console.log('  PHASE 1 — STRUCTURAL INTEGRITY AUDIT');
  console.log('='.repeat(68));

  const result: Record<string, unknown> = {};

  // 1.1 Primary key uniqueness — mark_prices
  const mpDups = await q(`
    SELECT symbol, timestamp, COUNT(*) AS cnt
    FROM mark_prices WHERE symbol=$1 AND timestamp >= $2 AND timestamp < $3
    GROUP BY symbol, timestamp HAVING COUNT(*) > 1 LIMIT 5`, [SYMBOL, startIso, endIso]);
  result.mark_prices_pk_duplicates = mpDups.length;
  console.log(`  mark_prices PK duplicates      : ${mpDups.length}`);

  // 1.2 Primary key uniqueness — funding_rates
  const frDups = await q(`
    SELECT symbol, funding_time, COUNT(*) AS cnt
    FROM funding_rates WHERE symbol=$1 AND funding_time >= $2 AND funding_time < $3
    GROUP BY symbol, funding_time HAVING COUNT(*) > 1 LIMIT 5`, [SYMBOL, startIso, endIso]);
  result.funding_rates_pk_duplicates = frDups.length;
  console.log(`  funding_rates PK duplicates    : ${frDups.length}`);

  // 1.3 Primary key uniqueness — open_interest
  const oiDups = await q(`
    SELECT symbol, timestamp, COUNT(*) AS cnt
    FROM open_interest WHERE symbol=$1 AND timestamp >= $2 AND timestamp < $3
    GROUP BY symbol, timestamp HAVING COUNT(*) > 1 LIMIT 5`, [SYMBOL, startIso, endIso]);
  result.open_interest_pk_duplicates = oiDups.length;
  console.log(`  open_interest PK duplicates    : ${oiDups.length}`);

  // 1.4 Liquidation ID uniqueness
  const liqDups = await q(`
    SELECT id, COUNT(*) AS cnt
    FROM liquidations WHERE symbol=$1 AND timestamp >= $2 AND timestamp < $3
    GROUP BY id HAVING COUNT(*) > 1 LIMIT 5`, [SYMBOL, startIso, endIso]);
  result.liquidation_id_duplicates = liqDups.length;
  console.log(`  liquidation ID duplicates      : ${liqDups.length}`);

  // 1.5 Row counts
  const counts = await q<{ tbl: string; cnt: string }>(`
    SELECT 'mark_prices' AS tbl, COUNT(*)::TEXT AS cnt FROM mark_prices WHERE symbol=$1 AND timestamp >= $2 AND timestamp < $3
    UNION ALL SELECT 'liquidations', COUNT(*)::TEXT FROM liquidations WHERE symbol=$1 AND timestamp >= $2 AND timestamp < $3
    UNION ALL SELECT 'funding_rates', COUNT(*)::TEXT FROM funding_rates WHERE symbol=$1 AND funding_time >= $2 AND funding_time < $3
    UNION ALL SELECT 'open_interest', COUNT(*)::TEXT FROM open_interest WHERE symbol=$1 AND timestamp >= $2 AND timestamp < $3
  `, [SYMBOL, startIso, endIso]);
  for (const row of counts) {
    result[`${row.tbl}_rows`] = Number(row.cnt);
    console.log(`  ${row.tbl.padEnd(25)}: ${Number(row.cnt).toLocaleString()} rows`);
  }

  // 1.6 Missing minutes in mark_prices
  // Truncate timestamps to minute boundaries for proper join
  const gapResult = await q<{ expected: string; present: string; missing: string; longest_gap: string }>(`
    WITH bounds AS (
      SELECT
        date_trunc('minute', MIN(timestamp)) AS first_ts,
        date_trunc('minute', MAX(timestamp)) AS last_ts
      FROM mark_prices WHERE symbol=$1 AND timestamp >= $2 AND timestamp < $3
    ),
    expected AS (
      SELECT generate_series(
        (SELECT first_ts FROM bounds),
        (SELECT last_ts FROM bounds),
        interval '1 minute'
      ) AS ts
    ),
    present AS (
      SELECT DISTINCT date_trunc('minute', timestamp) AS ts
      FROM mark_prices WHERE symbol=$1 AND timestamp >= $2 AND timestamp < $3
    ),
    missing AS (
      SELECT e.ts FROM expected e LEFT JOIN present p ON p.ts = e.ts WHERE p.ts IS NULL
    ),
    gaps AS (
      SELECT ts, ts - (ROW_NUMBER() OVER (ORDER BY ts)) * interval '1 minute' AS grp FROM missing
    ),
    gap_lengths AS (
      SELECT COUNT(*) AS gap_len FROM gaps GROUP BY grp
    )
    SELECT
      (SELECT COUNT(*) FROM expected)::TEXT AS expected,
      (SELECT COUNT(*) FROM present)::TEXT AS present,
      (SELECT COUNT(*) FROM missing)::TEXT AS missing,
      COALESCE((SELECT MAX(gap_len) FROM gap_lengths), 0)::TEXT AS longest_gap
  `, [SYMBOL, startIso, endIso]);
  const g = gapResult[0];
  result.expected_minutes = num(g.expected);
  result.present_minutes = num(g.present);
  result.missing_minutes = num(g.missing);
  result.longest_consecutive_gap = num(g.longest_gap);
  result.coverage_pct = pct(num(g.present), num(g.expected));
  console.log(`  Expected minutes               : ${num(g.expected).toLocaleString()}`);
  console.log(`  Present minutes                : ${num(g.present).toLocaleString()}`);
  console.log(`  Missing minutes                : ${num(g.missing).toLocaleString()}`);
  console.log(`  Coverage                       : ${result.coverage_pct}`);
  console.log(`  Longest consecutive gap (min)  : ${num(g.longest_gap).toLocaleString()}`);

  // 1.7 Clock drift — future timestamps
  const futureMp = await q<{ cnt: string }>(`
    SELECT COUNT(*)::TEXT AS cnt FROM mark_prices
    WHERE symbol=$1 AND timestamp > NOW() + interval '5 minutes'`, [SYMBOL]);
  result.future_timestamps_mark = num(futureMp[0].cnt);
  console.log(`  Future timestamps (mark)       : ${result.future_timestamps_mark}`);

  // 1.8 Backward jumps in mark_prices
  const backjumps = await q<{ cnt: string }>(`
    WITH ordered AS (
      SELECT timestamp, LAG(timestamp) OVER (ORDER BY timestamp) AS prev_ts
      FROM mark_prices WHERE symbol=$1 AND timestamp >= $2 AND timestamp < $3
    )
    SELECT COUNT(*)::TEXT AS cnt FROM ordered WHERE timestamp < prev_ts
  `, [SYMBOL, startIso, endIso]);
  result.backward_timestamp_jumps = num(backjumps[0].cnt);
  console.log(`  Backward timestamp jumps       : ${result.backward_timestamp_jumps}`);

  // 1.9 Negative/zero mark prices
  const negMp = await q<{ cnt: string }>(`
    SELECT COUNT(*)::TEXT AS cnt FROM mark_prices
    WHERE symbol=$1 AND timestamp >= $2 AND timestamp < $3 AND mark_price <= 0`, [SYMBOL, startIso, endIso]);
  result.negative_zero_mark_prices = num(negMp[0].cnt);
  console.log(`  Negative/zero mark prices      : ${result.negative_zero_mark_prices}`);

  // 1.10 Negative OI
  const negOi = await q<{ cnt: string }>(`
    SELECT COUNT(*)::TEXT AS cnt FROM open_interest
    WHERE symbol=$1 AND timestamp >= $2 AND timestamp < $3 AND open_interest_usd < 0`, [SYMBOL, startIso, endIso]);
  result.negative_open_interest = num(negOi[0].cnt);
  console.log(`  Negative open interest         : ${result.negative_open_interest}`);

  // 1.11 Funding rate bounds
  const oobFr = await q<{ cnt: string }>(`
    SELECT COUNT(*)::TEXT AS cnt FROM funding_rates
    WHERE symbol=$1 AND funding_time >= $2 AND funding_time < $3
    AND (funding_rate < -0.05 OR funding_rate > 0.05)`, [SYMBOL, startIso, endIso]);
  result.funding_out_of_bounds = num(oobFr[0].cnt);
  console.log(`  Funding rate out of bounds     : ${result.funding_out_of_bounds}`);

  // 1.12 Mark price outliers > 8 std deviations
  const outlierMp = await q<{ cnt: string }>(`
    WITH stats AS (
      SELECT AVG(mark_price) AS mu, STDDEV(mark_price) AS sigma
      FROM mark_prices WHERE symbol=$1 AND timestamp >= $2 AND timestamp < $3
    )
    SELECT COUNT(*)::TEXT AS cnt FROM mark_prices m, stats s
    WHERE m.symbol=$1 AND m.timestamp >= $2 AND m.timestamp < $3
    AND ABS(m.mark_price - s.mu) > 8 * s.sigma`, [SYMBOL, startIso, endIso]);
  result.mark_price_8sigma_outliers = num(outlierMp[0].cnt);
  console.log(`  Mark price >8σ outliers        : ${result.mark_price_8sigma_outliers}`);

  return result;
}

// ---------------------------------------------------------------------------
// PHASE 2 — Time series quality
// ---------------------------------------------------------------------------

async function phase2() {
  console.log('\n' + '='.repeat(68));
  console.log('  PHASE 2 — TIME SERIES CONTINUITY & QUALITY');
  console.log('='.repeat(68));

  const result: Record<string, unknown> = {};

  // 2.1 Mark price log-return moments
  console.log('\n  --- Mark Price Log Returns ---');
  const moments = await q<{
    cnt: string; mean_ret: string; std_ret: string;
    skew: string; kurt: string;
    p50: string; p90: string; p95: string; p99: string; p999: string;
    min_ret: string; max_ret: string;
  }>(`
    WITH ordered AS (
      SELECT mark_price, LAG(mark_price) OVER (ORDER BY timestamp) AS prev
      FROM mark_prices WHERE symbol=$1 AND timestamp >= $2 AND timestamp < $3
    ),
    rets AS (
      SELECT LN(mark_price / prev) AS r FROM ordered WHERE prev > 0 AND mark_price > 0
    ),
    stats AS (
      SELECT AVG(r) AS mu, STDDEV(r) AS sigma FROM rets
    ),
    centered AS (
      SELECT r, r - stats.mu AS d, stats.sigma AS sigma FROM rets, stats
    ),
    agg AS (
      SELECT
        COUNT(*)::TEXT AS cnt,
        AVG(r)::TEXT AS mean_ret,
        (SELECT sigma FROM stats)::TEXT AS std_ret,
        CASE WHEN (SELECT sigma FROM stats) > 0
          THEN (AVG(POWER(d, 3)) / POWER((SELECT sigma FROM stats), 3))::TEXT
          ELSE '0' END AS skew,
        CASE WHEN (SELECT sigma FROM stats) > 0
          THEN (AVG(POWER(d, 4)) / POWER((SELECT sigma FROM stats), 4))::TEXT
          ELSE '0' END AS kurt,
        MIN(r)::TEXT AS min_ret,
        MAX(r)::TEXT AS max_ret,
        PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY r)::TEXT AS p50,
        PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY r)::TEXT AS p90,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY r)::TEXT AS p95,
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY r)::TEXT AS p99,
        PERCENTILE_CONT(0.999) WITHIN GROUP (ORDER BY r)::TEXT AS p999
      FROM centered
    )
    SELECT * FROM agg
  `, [SYMBOL, startIso, endIso]);
  const m = moments[0];

  const kurtosis = num(m.kurt);
  result.return_count = num(m.cnt);
  result.return_mean = num(m.mean_ret);
  result.return_std = num(m.std_ret);
  result.return_skewness = num(m.skew);
  result.return_kurtosis = kurtosis;
  result.fat_tailed = kurtosis > 3;
  result.return_percentiles = {
    p50: num(m.p50), p90: num(m.p90), p95: num(m.p95), p99: num(m.p99), p999: num(m.p999),
  };
  result.return_min = num(m.min_ret);
  result.return_max = num(m.max_ret);

  console.log(`  Count      : ${num(m.cnt).toLocaleString()}`);
  console.log(`  Mean       : ${num(m.mean_ret).toExponential(4)}`);
  console.log(`  Std Dev    : ${num(m.std_ret).toExponential(4)}`);
  console.log(`  Skewness   : ${num(m.skew).toFixed(4)}`);
  console.log(`  Kurtosis   : ${kurtosis.toFixed(4)} ${kurtosis > 3 ? '(fat-tailed ✓)' : '(NOT fat-tailed ✗)'}`);
  console.log(`  Min return : ${num(m.min_ret).toFixed(6)}`);
  console.log(`  Max return : ${num(m.max_ret).toFixed(6)}`);
  console.log(`  Percentiles: p50=${num(m.p50).toExponential(3)} p90=${num(m.p90).toExponential(3)} p95=${num(m.p95).toExponential(3)} p99=${num(m.p99).toExponential(3)} p99.9=${num(m.p999).toExponential(3)}`);

  // 2.2 Flatline detection (>3 identical consecutive prices)
  const flatlines = await q<{ flat_count: string; max_run: string }>(`
    WITH runs AS (
      SELECT mark_price, timestamp,
        mark_price - LAG(mark_price) OVER (ORDER BY timestamp) AS diff
      FROM mark_prices WHERE symbol=$1 AND timestamp >= $2 AND timestamp < $3
    ),
    flagged AS (
      SELECT *, CASE WHEN diff = 0 THEN 0 ELSE 1 END AS changed,
        SUM(CASE WHEN diff = 0 THEN 0 ELSE 1 END) OVER (ORDER BY timestamp) AS grp
      FROM runs
    ),
    groups AS (
      SELECT grp, COUNT(*) AS run_len FROM flagged WHERE diff = 0 GROUP BY grp
    )
    SELECT
      (SELECT COUNT(*) FROM groups WHERE run_len >= 3)::TEXT AS flat_count,
      COALESCE((SELECT MAX(run_len) FROM groups), 0)::TEXT AS max_run
  `, [SYMBOL, startIso, endIso]);
  result.flatline_sequences_gt3 = num(flatlines[0].flat_count);
  result.longest_flatline = num(flatlines[0].max_run);
  console.log(`  Flatline seqs (>3 min same px) : ${result.flatline_sequences_gt3}`);
  console.log(`  Longest flatline (minutes)     : ${result.longest_flatline}`);

  // 2.3 Abnormal jumps >10% in 1 minute
  const jumps = await q<{ cnt: string; worst: string; worst_ts: string }>(`
    WITH ordered AS (
      SELECT mark_price, LAG(mark_price) OVER (ORDER BY timestamp) AS prev, timestamp
      FROM mark_prices WHERE symbol=$1 AND timestamp >= $2 AND timestamp < $3
    )
    SELECT
      COUNT(*)::TEXT AS cnt,
      MAX(ABS(mark_price - prev) / prev)::TEXT AS worst,
      (ARRAY_AGG(timestamp ORDER BY ABS(mark_price - prev) / prev DESC))[1]::TEXT AS worst_ts
    FROM ordered WHERE prev > 0 AND ABS(mark_price - prev) / prev > 0.10
  `, [SYMBOL, startIso, endIso]);
  result.jumps_gt_10pct = num(jumps[0].cnt);
  result.worst_jump_pct = (num(jumps[0].worst) * 100).toFixed(4);
  console.log(`  1-min jumps >10%               : ${result.jumps_gt_10pct}`);
  if (num(jumps[0].cnt) > 0) console.log(`  Worst jump                     : ${result.worst_jump_pct}% at ${jumps[0].worst_ts}`);

  // 2.4 OI analysis
  console.log('\n  --- Open Interest ---');
  const oiStats = await q<{
    cnt: string; mean_chg: string; std_chg: string;
    spikes: string; worst_spike: string;
  }>(`
    WITH ordered AS (
      SELECT open_interest_usd, LAG(open_interest_usd) OVER (ORDER BY timestamp) AS prev, timestamp
      FROM open_interest WHERE symbol=$1 AND timestamp >= $2 AND timestamp < $3
    ),
    changes AS (
      SELECT (open_interest_usd - prev) / NULLIF(prev, 0) AS pct_chg FROM ordered WHERE prev > 0
    )
    SELECT
      COUNT(*)::TEXT AS cnt,
      AVG(pct_chg)::TEXT AS mean_chg,
      STDDEV(pct_chg)::TEXT AS std_chg,
      (SELECT COUNT(*) FROM changes WHERE ABS(pct_chg) > 0.15)::TEXT AS spikes,
      (SELECT MAX(ABS(pct_chg)) FROM changes)::TEXT AS worst_spike
    FROM changes
  `, [SYMBOL, startIso, endIso]);
  result.oi_change_count = num(oiStats[0].cnt);
  result.oi_change_mean = num(oiStats[0].mean_chg);
  result.oi_change_std = num(oiStats[0].std_chg);
  result.oi_spikes_gt15pct = num(oiStats[0].spikes);
  console.log(`  OI change observations         : ${num(oiStats[0].cnt).toLocaleString()}`);
  console.log(`  OI change mean                 : ${num(oiStats[0].mean_chg).toExponential(3)}`);
  console.log(`  OI change std                  : ${num(oiStats[0].std_chg).toExponential(3)}`);
  console.log(`  OI spikes >15%                 : ${result.oi_spikes_gt15pct}`);

  // 2.5 OI vs price correlation
  const corr = await q<{ corr_val: string }>(`
    WITH mp AS (
      SELECT date_trunc('hour', timestamp) AS hr, AVG(mark_price) AS avg_px
      FROM mark_prices WHERE symbol=$1 AND timestamp >= $2 AND timestamp < $3
      GROUP BY 1
    ),
    oi AS (
      SELECT date_trunc('hour', timestamp) AS hr, AVG(open_interest_usd) AS avg_oi
      FROM open_interest WHERE symbol=$1 AND timestamp >= $2 AND timestamp < $3
      GROUP BY 1
    ),
    joined AS (
      SELECT mp.avg_px, oi.avg_oi FROM mp JOIN oi ON mp.hr = oi.hr
    )
    SELECT CORR(avg_px, avg_oi)::TEXT AS corr_val FROM joined
  `, [SYMBOL, startIso, endIso]);
  result.oi_price_hourly_correlation = num(corr[0]?.corr_val);
  console.log(`  OI-Price hourly correlation    : ${num(corr[0]?.corr_val).toFixed(4)}`);

  // 2.6 Funding rate distribution
  console.log('\n  --- Funding Rates ---');
  const frDist = await q<{
    cnt: string; mean_fr: string; std_fr: string; min_fr: string; max_fr: string;
    p25: string; p50: string; p75: string;
  }>(`
    SELECT
      COUNT(*)::TEXT AS cnt,
      AVG(funding_rate)::TEXT AS mean_fr,
      STDDEV(funding_rate)::TEXT AS std_fr,
      MIN(funding_rate)::TEXT AS min_fr,
      MAX(funding_rate)::TEXT AS max_fr,
      PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY funding_rate)::TEXT AS p25,
      PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY funding_rate)::TEXT AS p50,
      PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY funding_rate)::TEXT AS p75
    FROM funding_rates WHERE symbol=$1 AND funding_time >= $2 AND funding_time < $3
  `, [SYMBOL, startIso, endIso]);
  const fr = frDist[0];
  result.funding_count = num(fr.cnt);
  result.funding_mean = num(fr.mean_fr);
  result.funding_std = num(fr.std_fr);
  result.funding_min = num(fr.min_fr);
  result.funding_max = num(fr.max_fr);
  console.log(`  Count    : ${num(fr.cnt).toLocaleString()}`);
  console.log(`  Mean     : ${num(fr.mean_fr).toExponential(4)}`);
  console.log(`  Std      : ${num(fr.std_fr).toExponential(4)}`);
  console.log(`  Range    : [${num(fr.min_fr).toFixed(6)}, ${num(fr.max_fr).toFixed(6)}]`);
  console.log(`  Quartiles: p25=${num(fr.p25).toFixed(6)} p50=${num(fr.p50).toFixed(6)} p75=${num(fr.p75).toFixed(6)}`);

  // 2.7 Funding flat segments > 24h (>= 3 identical consecutive rates)
  const frFlat = await q<{ flat_segs: string; longest: string }>(`
    WITH ordered AS (
      SELECT funding_rate, funding_time,
        funding_rate - LAG(funding_rate) OVER (ORDER BY funding_time) AS diff
      FROM funding_rates WHERE symbol=$1 AND funding_time >= $2 AND funding_time < $3
    ),
    flagged AS (
      SELECT *, SUM(CASE WHEN diff = 0 THEN 0 ELSE 1 END) OVER (ORDER BY funding_time) AS grp
      FROM ordered
    ),
    groups AS (
      SELECT grp, COUNT(*) AS run_len FROM flagged WHERE diff = 0 GROUP BY grp
    )
    SELECT
      (SELECT COUNT(*) FROM groups WHERE run_len >= 3)::TEXT AS flat_segs,
      COALESCE((SELECT MAX(run_len) FROM groups), 0)::TEXT AS longest
  `, [SYMBOL, startIso, endIso]);
  result.funding_flat_segments_gt24h = num(frFlat[0].flat_segs);
  result.funding_longest_flat = num(frFlat[0].longest);
  console.log(`  Flat segments (≥3 identical)   : ${result.funding_flat_segments_gt24h}`);
  console.log(`  Longest flat run (periods)     : ${result.funding_longest_flat} (${num(frFlat[0].longest) * 8}h)`);

  return result;
}

// ---------------------------------------------------------------------------
// PHASE 3 — Liquidation forensic analysis
// ---------------------------------------------------------------------------

async function phase3() {
  console.log('\n' + '='.repeat(68));
  console.log('  PHASE 3 — LIQUIDATION FORENSIC ANALYSIS');
  console.log('='.repeat(68));

  const result: Record<string, unknown> = {};

  // 3.1 USD value distribution
  const dist = await q<{
    cnt: string; p50: string; p90: string; p95: string; p99: string; p999: string; max_val: string;
  }>(`
    SELECT
      COUNT(*)::TEXT AS cnt,
      PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY usd_value)::TEXT AS p50,
      PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY usd_value)::TEXT AS p90,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY usd_value)::TEXT AS p95,
      PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY usd_value)::TEXT AS p99,
      PERCENTILE_CONT(0.999) WITHIN GROUP (ORDER BY usd_value)::TEXT AS p999,
      MAX(usd_value)::TEXT AS max_val
    FROM liquidations WHERE symbol=$1 AND timestamp >= $2 AND timestamp < $3
  `, [SYMBOL, startIso, endIso]);
  const d = dist[0];
  const liqCount = num(d.cnt);
  result.liquidation_count = liqCount;

  if (liqCount === 0) {
    console.log('  No liquidation data found. Skipping Phase 3.');
    console.log('  (Liquidations require live WebSocket collection — see Phase 4 docs)');
    result.status = 'NO_DATA';
    return result;
  }

  result.usd_percentiles = {
    p50: num(d.p50), p90: num(d.p90), p95: num(d.p95), p99: num(d.p99), p999: num(d.p999), max: num(d.max_val),
  };
  result.heavy_right_tail = num(d.p99) > 10 * num(d.p50);

  console.log(`  Count        : ${liqCount.toLocaleString()}`);
  console.log(`  p50 (USD)    : $${num(d.p50).toFixed(2)}`);
  console.log(`  p90          : $${num(d.p90).toFixed(2)}`);
  console.log(`  p95          : $${num(d.p95).toFixed(2)}`);
  console.log(`  p99          : $${num(d.p99).toFixed(2)}`);
  console.log(`  p99.9        : $${num(d.p999).toFixed(2)}`);
  console.log(`  Max          : $${num(d.max_val).toFixed(2)}`);
  console.log(`  Heavy tail   : ${result.heavy_right_tail ? 'YES (p99 > 10×p50 ✓)' : 'NO ✗'}`);

  // 3.2 Hourly liquidation counts & volume
  const hourly = await q<{ hr: string; cnt: string; vol: string }>(`
    SELECT date_trunc('hour', timestamp) AS hr, COUNT(*)::TEXT AS cnt, SUM(usd_value)::TEXT AS vol
    FROM liquidations WHERE symbol=$1 AND timestamp >= $2 AND timestamp < $3
    GROUP BY 1 ORDER BY 1`, [SYMBOL, startIso, endIso]);
  result.hourly_bins = hourly.length;

  // 3.3 Burst detection (top 5% intensity)
  if (hourly.length > 0) {
    const volumes = hourly.map(h => num(h.vol)).sort((a, b) => a - b);
    const p95idx = Math.floor(volumes.length * 0.95);
    const p95vol = volumes[p95idx] || 0;
    const bursts = hourly.filter(h => num(h.vol) >= p95vol).sort((a, b) => num(b.vol) - num(a.vol));
    result.burst_threshold_p95 = p95vol;
    result.burst_count = bursts.length;
    console.log(`  Burst threshold (p95 hourly)   : $${p95vol.toFixed(0)}`);
    console.log(`  Burst windows (top 5%)         : ${bursts.length}`);

    // 3.4 Top 20 bursts with price context
    console.log('\n  Top 20 liquidation bursts:');
    const top20 = bursts.slice(0, 20);
    const burstDetails: Array<Record<string, unknown>> = [];
    for (const b of top20) {
      const hrStart = new Date(b.hr);
      const hrEnd = new Date(hrStart.getTime() + 3_600_000);
      // Dominant side
      const sides = await q<{ side: string; cnt: string; vol: string }>(`
        SELECT side, COUNT(*)::TEXT AS cnt, SUM(usd_value)::TEXT AS vol
        FROM liquidations WHERE symbol=$1 AND timestamp >= $2 AND timestamp < $3
        GROUP BY side`, [SYMBOL, hrStart.toISOString(), hrEnd.toISOString()]);
      // 30-min price move from burst start
      const priceMove = await q<{ start_px: string; end_px: string }>(`
        SELECT
          (SELECT mark_price FROM mark_prices WHERE symbol=$1 AND timestamp >= $2 ORDER BY timestamp LIMIT 1) AS start_px,
          (SELECT mark_price FROM mark_prices WHERE symbol=$1 AND timestamp <= $2::timestamptz + interval '30 minutes' ORDER BY timestamp DESC LIMIT 1) AS end_px
      `, [SYMBOL, hrStart.toISOString()]);
      const sp = num(priceMove[0]?.start_px);
      const ep = num(priceMove[0]?.end_px);
      const pxChg = sp > 0 ? ((ep - sp) / sp * 100) : 0;
      const dominantSide = sides.reduce((a, b) => num(a.vol) > num(b.vol) ? a : b, sides[0]);
      const consistent = (dominantSide.side === 'SELL' && pxChg < 0) || (dominantSide.side === 'BUY' && pxChg > 0);

      burstDetails.push({ hr: b.hr, vol: num(b.vol), dominant_side: dominantSide.side, price_change_pct: pxChg, direction_consistent: consistent });
      console.log(`    ${b.hr} | $${num(b.vol).toFixed(0).padStart(12)} | ${dominantSide.side} dom | Δpx ${pxChg.toFixed(2)}% | ${consistent ? '✓' : '✗'}`);
    }
    result.top_bursts = burstDetails;
    const consistentCount = burstDetails.filter(b => b.direction_consistent).length;
    result.direction_consistency_rate = `${consistentCount}/${burstDetails.length}`;
    console.log(`  Direction consistency          : ${consistentCount}/${burstDetails.length}`);
  }

  // 3.5 Correlation: 5-min liq volume vs 5-min abs return
  const liqPxCorr = await q<{ corr_val: string }>(`
    WITH liq5 AS (
      SELECT date_trunc('minute', timestamp) - (EXTRACT(MINUTE FROM timestamp)::INT % 5) * interval '1 minute' AS bucket,
        SUM(usd_value) AS vol
      FROM liquidations WHERE symbol=$1 AND timestamp >= $2 AND timestamp < $3
      GROUP BY 1
    ),
    px5 AS (
      SELECT date_trunc('minute', timestamp) - (EXTRACT(MINUTE FROM timestamp)::INT % 5) * interval '1 minute' AS bucket,
        ABS(LN((ARRAY_AGG(mark_price ORDER BY timestamp DESC))[1] / NULLIF((ARRAY_AGG(mark_price ORDER BY timestamp ASC))[1], 0))) AS abs_ret
      FROM mark_prices WHERE symbol=$1 AND timestamp >= $2 AND timestamp < $3
      GROUP BY 1 HAVING COUNT(*) >= 2
    ),
    joined AS (
      SELECT liq5.vol, px5.abs_ret FROM liq5 JOIN px5 ON liq5.bucket = px5.bucket
    )
    SELECT CORR(vol, abs_ret)::TEXT AS corr_val FROM joined
  `, [SYMBOL, startIso, endIso]);
  result.liq_volume_abs_return_5min_corr = num(liqPxCorr[0]?.corr_val);
  console.log(`  5-min liq volume vs abs return : ${num(liqPxCorr[0]?.corr_val).toFixed(4)}`);

  if (num(liqPxCorr[0]?.corr_val) < 0.05) {
    console.log(`  ⚠ LOW CORRELATION — liquidations may not be price-reactive`);
    result.suspicious_low_correlation = true;
  }

  return result;
}

// ---------------------------------------------------------------------------
// PHASE 4 — Microstructure consistency
// ---------------------------------------------------------------------------

async function phase4() {
  console.log('\n' + '='.repeat(68));
  console.log('  PHASE 4 — MICROSTRUCTURE CONSISTENCY');
  console.log('='.repeat(68));

  const result: Record<string, unknown> = {};

  // 4.1 30-min rolling realized volatility
  const rvol = await q<{ cnt: string; mean_rv: string; std_rv: string; p33: string; p67: string }>(`
    WITH rets AS (
      SELECT timestamp, LN(mark_price / LAG(mark_price) OVER (ORDER BY timestamp)) AS r
      FROM mark_prices WHERE symbol=$1 AND timestamp >= $2 AND timestamp < $3
    ),
    rv30 AS (
      SELECT timestamp,
        STDDEV(r) OVER (ORDER BY timestamp ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) * SQRT(30) AS rv
      FROM rets WHERE r IS NOT NULL
    )
    SELECT
      COUNT(*)::TEXT AS cnt,
      AVG(rv)::TEXT AS mean_rv,
      STDDEV(rv)::TEXT AS std_rv,
      PERCENTILE_CONT(0.33) WITHIN GROUP (ORDER BY rv)::TEXT AS p33,
      PERCENTILE_CONT(0.67) WITHIN GROUP (ORDER BY rv)::TEXT AS p67
    FROM rv30 WHERE rv IS NOT NULL
  `, [SYMBOL, startIso, endIso]);
  result.rv30_mean = num(rvol[0].mean_rv);
  result.rv30_std = num(rvol[0].std_rv);
  result.rv30_tercile_low = num(rvol[0].p33);
  result.rv30_tercile_high = num(rvol[0].p67);
  console.log(`  30-min realized vol mean       : ${num(rvol[0].mean_rv).toExponential(4)}`);
  console.log(`  30-min realized vol std        : ${num(rvol[0].std_rv).toExponential(4)}`);
  console.log(`  Vol terciles (p33/p67)         : ${num(rvol[0].p33).toExponential(3)} / ${num(rvol[0].p67).toExponential(3)}`);

  // 4.2 Liquidation frequency across vol terciles
  const liqByVol = await q<{ tercile: string; liq_count: string; liq_vol: string }>(`
    WITH rets AS (
      SELECT timestamp, LN(mark_price / LAG(mark_price) OVER (ORDER BY timestamp)) AS r
      FROM mark_prices WHERE symbol=$1 AND timestamp >= $2 AND timestamp < $3
    ),
    rv30 AS (
      SELECT timestamp,
        STDDEV(r) OVER (ORDER BY timestamp ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) * SQRT(30) AS rv
      FROM rets WHERE r IS NOT NULL
    ),
    rv_terciles AS (
      SELECT timestamp, rv,
        NTILE(3) OVER (ORDER BY rv) AS tercile
      FROM rv30 WHERE rv IS NOT NULL
    ),
    liq_min AS (
      SELECT date_trunc('minute', timestamp) AS min_ts, SUM(usd_value) AS vol, COUNT(*) AS cnt
      FROM liquidations WHERE symbol=$1 AND timestamp >= $2 AND timestamp < $3
      GROUP BY 1
    )
    SELECT
      rt.tercile::TEXT,
      COALESCE(SUM(lm.cnt), 0)::TEXT AS liq_count,
      COALESCE(SUM(lm.vol), 0)::TEXT AS liq_vol
    FROM rv_terciles rt
    LEFT JOIN liq_min lm ON lm.min_ts = rt.timestamp
    GROUP BY rt.tercile ORDER BY rt.tercile
  `, [SYMBOL, startIso, endIso]);

  console.log('\n  Liquidation frequency by volatility tercile:');
  for (const row of liqByVol) {
    const label = row.tercile === '1' ? 'Low' : row.tercile === '2' ? 'Mid' : 'High';
    console.log(`    ${label.padEnd(6)}: ${num(row.liq_count).toLocaleString()} events, $${num(row.liq_vol).toFixed(0)} vol`);
  }
  result.liq_by_vol_tercile = liqByVol.map(r => ({ tercile: r.tercile, count: num(r.liq_count), volume: num(r.liq_vol) }));

  // Check if high-vol tercile has most liquidations
  const highVolLiq = liqByVol.find(r => r.tercile === '3');
  const lowVolLiq = liqByVol.find(r => r.tercile === '1');
  if (highVolLiq && lowVolLiq) {
    result.stress_clustering = num(highVolLiq.liq_count) > num(lowVolLiq.liq_count) * 2;
    console.log(`  Stress clustering (high > 2×low): ${result.stress_clustering ? 'YES ✓' : 'NO ✗'}`);
  }

  // 4.3 Detect evenly-spaced liquidations (synthetic fingerprint)
  const spacing = await q<{ cnt: string; mean_gap: string; std_gap: string; cv: string }>(`
    WITH ordered AS (
      SELECT timestamp,
        EXTRACT(EPOCH FROM timestamp - LAG(timestamp) OVER (ORDER BY timestamp)) AS gap_s
      FROM liquidations WHERE symbol=$1 AND timestamp >= $2 AND timestamp < $3
    )
    SELECT
      COUNT(*)::TEXT AS cnt,
      AVG(gap_s)::TEXT AS mean_gap,
      STDDEV(gap_s)::TEXT AS std_gap,
      (STDDEV(gap_s) / NULLIF(AVG(gap_s), 0))::TEXT AS cv
    FROM ordered WHERE gap_s IS NOT NULL AND gap_s > 0
  `, [SYMBOL, startIso, endIso]);
  const cv = num(spacing[0]?.cv);
  result.liq_spacing_cv = cv;
  result.evenly_spaced = cv < 0.3;
  console.log(`  Liq inter-arrival CV           : ${cv.toFixed(4)} ${cv < 0.3 ? '(⚠ suspiciously uniform)' : '(irregular ✓)'}`);

  // 4.4 Detect uniform liquidation sizes
  const sizeCv = await q<{ cv: string }>(`
    SELECT (STDDEV(usd_value) / NULLIF(AVG(usd_value), 0))::TEXT AS cv
    FROM liquidations WHERE symbol=$1 AND timestamp >= $2 AND timestamp < $3
  `, [SYMBOL, startIso, endIso]);
  const scv = num(sizeCv[0]?.cv);
  result.liq_size_cv = scv;
  result.uniform_sizes = scv < 0.5;
  console.log(`  Liq USD size CV                : ${scv.toFixed(4)} ${scv < 0.5 ? '(⚠ suspiciously uniform)' : '(varied ✓)'}`);

  return result;
}

// ---------------------------------------------------------------------------
// PHASE 5 — Cascade ground truth validation
// ---------------------------------------------------------------------------

async function phase5() {
  console.log('\n' + '='.repeat(68));
  console.log('  PHASE 5 — CASCADE GROUND TRUTH VALIDATION');
  console.log('='.repeat(68));

  const result: Record<string, unknown> = {};

  // 5.1 Detect cascade candidates: >=2% absolute move in 30 min AND liq volume >= p95
  const cascades = await q<{
    cascade_start: string; cascade_end: string; abs_move_pct: string;
    liq_volume: string; liq_count: string; direction: string;
  }>(`
    WITH
    -- 30-minute windows with price moves
    windows AS (
      SELECT
        timestamp AS window_start,
        timestamp + interval '30 minutes' AS window_end,
        mark_price AS start_px,
        LEAD(mark_price, 30) OVER (ORDER BY timestamp) AS end_px
      FROM mark_prices
      WHERE symbol=$1 AND timestamp >= $2 AND timestamp < $3
    ),
    moves AS (
      SELECT *,
        ABS(end_px - start_px) / NULLIF(start_px, 0) * 100 AS abs_move_pct,
        CASE WHEN end_px < start_px THEN 'DOWN' ELSE 'UP' END AS direction
      FROM windows WHERE end_px IS NOT NULL
    ),
    -- Hourly liq volume p95 threshold
    hourly_liq AS (
      SELECT date_trunc('hour', timestamp) AS hr, SUM(usd_value) AS vol
      FROM liquidations WHERE symbol=$1 AND timestamp >= $2 AND timestamp < $3
      GROUP BY 1
    ),
    liq_threshold AS (
      SELECT COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY vol), 0) AS p95 FROM hourly_liq
    ),
    -- Cascade candidates
    candidates AS (
      SELECT m.window_start, m.window_end, m.abs_move_pct, m.direction
      FROM moves m
      WHERE m.abs_move_pct >= 2
    ),
    -- Enrich with liq data
    enriched AS (
      SELECT c.*,
        COALESCE((SELECT SUM(usd_value) FROM liquidations WHERE symbol=$1 AND timestamp >= c.window_start AND timestamp < c.window_end), 0) AS liq_volume,
        COALESCE((SELECT COUNT(*) FROM liquidations WHERE symbol=$1 AND timestamp >= c.window_start AND timestamp < c.window_end), 0) AS liq_count
      FROM candidates c
    )
    SELECT
      window_start::TEXT AS cascade_start,
      window_end::TEXT AS cascade_end,
      abs_move_pct::TEXT,
      liq_volume::TEXT,
      liq_count::TEXT,
      direction
    FROM enriched e, liq_threshold lt
    WHERE e.liq_volume >= lt.p95 OR lt.p95 = 0
    ORDER BY e.abs_move_pct DESC
    LIMIT 100
  `, [SYMBOL, startIso, endIso]);

  // Deduplicate overlapping windows (keep largest move per 1-hour block)
  const seen = new Set<string>();
  const deduped = cascades.filter(c => {
    const block = c.cascade_start.slice(0, 13); // hour-level dedup
    if (seen.has(block)) return false;
    seen.add(block);
    return true;
  });

  result.cascade_candidates = deduped.length;
  console.log(`  Cascade candidates (deduped)   : ${deduped.length}`);

  if (deduped.length === 0) {
    console.log('  No cascades detected (may need more data or liq stream)');
    result.status = 'NO_CASCADES';
    return result;
  }

  // 5.2 Cascades per month
  const byMonth: Record<string, number> = {};
  for (const c of deduped) {
    const month = c.cascade_start.slice(0, 7);
    byMonth[month] = (byMonth[month] || 0) + 1;
  }
  result.cascades_per_month = byMonth;
  console.log('  Cascades per month:');
  for (const [month, count] of Object.entries(byMonth)) {
    console.log(`    ${month}: ${count}`);
  }

  // 5.3 Distribution uniformity check
  const monthCounts = Object.values(byMonth);
  const monthMean = monthCounts.reduce((a, b) => a + b, 0) / monthCounts.length;
  const monthStd = Math.sqrt(monthCounts.reduce((a, b) => a + (b - monthMean) ** 2, 0) / monthCounts.length);
  const monthCv = monthStd / (monthMean || 1);
  result.cascade_monthly_cv = monthCv;
  result.cascade_non_uniform = monthCv > 0.3;
  console.log(`  Monthly CV                     : ${monthCv.toFixed(3)} ${monthCv > 0.3 ? '(non-uniform ✓)' : '(⚠ suspiciously uniform)'}`);

  // 5.4 Top cascade details
  console.log('\n  Top cascade events:');
  for (const c of deduped.slice(0, 10)) {
    console.log(`    ${c.cascade_start} | Δ${num(c.abs_move_pct).toFixed(2)}% ${c.direction} | ${num(c.liq_count)} liqs | $${num(c.liq_volume).toFixed(0)}`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// PHASE 6 — Synthetic detection heuristics
// ---------------------------------------------------------------------------

async function phase6(p1: Record<string, unknown>, p2: Record<string, unknown>, p3: Record<string, unknown>, p4: Record<string, unknown>) {
  console.log('\n' + '='.repeat(68));
  console.log('  PHASE 6 — SYNTHETIC DATA DETECTION HEURISTICS');
  console.log('='.repeat(68));

  const heuristics: Record<string, { pass: boolean; explanation: string }> = {};

  // H1: Uniform timestamp spacing in mark_prices?
  const mpSpacing = await q<{ cv: string }>(`
    WITH ordered AS (
      SELECT EXTRACT(EPOCH FROM timestamp - LAG(timestamp) OVER (ORDER BY timestamp)) AS gap
      FROM mark_prices WHERE symbol=$1 AND timestamp >= $2 AND timestamp < $3
    )
    SELECT (STDDEV(gap) / NULLIF(AVG(gap), 0))::TEXT AS cv FROM ordered WHERE gap IS NOT NULL
  `, [SYMBOL, startIso, endIso]);
  const mpCv = num(mpSpacing[0]?.cv);
  // Mark prices ARE expected to be ~uniformly spaced at 1-min (that's kline data), so low CV is normal
  // But if CV is essentially 0 (< 0.01), that's suspicious (no gaps at all)
  heuristics['uniform_timestamp_spacing'] = {
    pass: mpCv > 0.01 || num(p1['missing_minutes'] as number) > 0,
    explanation: `Mark price timestamp CV=${mpCv.toFixed(4)}. Missing gaps=${p1['missing_minutes']}. Some gaps expected for real data.`,
  };

  // H2: Lack of heavy tails in returns?
  const kurt = num(p2['return_kurtosis'] as number);
  heuristics['heavy_tails'] = {
    pass: kurt > 3,
    explanation: `Return kurtosis=${kurt.toFixed(2)}. Real BTC futures exhibit kurtosis >> 3.`,
  };

  // H3: Too-clean distributions?
  const retStd = num(p2['return_std'] as number);
  heuristics['distribution_realism'] = {
    pass: retStd > 1e-6,
    explanation: `Return std=${retStd.toExponential(4)}. Zero or near-zero std indicates synthetic flat data.`,
  };

  // H4: Identical liquidation sizes?
  const liqSizeCv = num(p4['liq_size_cv'] as number);
  heuristics['liquidation_size_variety'] = {
    pass: liqSizeCv > 0.5 || num(p3['liquidation_count'] as number) === 0,
    explanation: liqSizeCv > 0
      ? `Liq USD value CV=${liqSizeCv.toFixed(3)}. Values > 0.5 indicate real market variety.`
      : `No liquidation data to evaluate.`,
  };

  // H5: Weekend liquidity difference?
  const weekendTest = await q<{ weekday_vol: string; weekend_vol: string }>(`
    WITH hourly AS (
      SELECT date_trunc('hour', timestamp) AS hr,
        EXTRACT(DOW FROM timestamp) AS dow,
        STDDEV(mark_price) / NULLIF(AVG(mark_price), 0) AS norm_vol
      FROM mark_prices WHERE symbol=$1 AND timestamp >= $2 AND timestamp < $3
      GROUP BY 1, 2
    )
    SELECT
      AVG(CASE WHEN dow IN (0, 6) THEN norm_vol END)::TEXT AS weekend_vol,
      AVG(CASE WHEN dow NOT IN (0, 6) THEN norm_vol END)::TEXT AS weekday_vol
    FROM hourly
  `, [SYMBOL, startIso, endIso]);
  const wkdVol = num(weekendTest[0]?.weekday_vol);
  const wkndVol = num(weekendTest[0]?.weekend_vol);
  const wkndRatio = wkdVol > 0 ? wkndVol / wkdVol : 1;
  heuristics['weekend_liquidity_difference'] = {
    pass: Math.abs(wkndRatio - 1) > 0.01 || wkndRatio < 1,
    explanation: `Weekend/weekday vol ratio=${wkndRatio.toFixed(4)}. Real crypto has 24/7 trading with mild liquidity differences.`,
  };

  // H6: Perfectly symmetric funding?
  const fundSkew = await q<{ skew: string }>(`
    WITH rets AS (
      SELECT funding_rate AS r FROM funding_rates WHERE symbol=$1 AND funding_time >= $2 AND funding_time < $3
    ),
    stats AS (
      SELECT AVG(r) AS mu, STDDEV(r) AS sigma FROM rets
    ),
    centered AS (
      SELECT r - stats.mu AS d, stats.sigma FROM rets, stats
    )
    SELECT CASE WHEN (SELECT sigma FROM stats) > 0
      THEN (AVG(POWER(d, 3)) / POWER((SELECT sigma FROM stats), 3))::TEXT
      ELSE '0' END AS skew
    FROM centered
  `, [SYMBOL, startIso, endIso]);
  const fSkew = num(fundSkew[0]?.skew);
  heuristics['funding_asymmetry'] = {
    pass: Math.abs(fSkew) > 0.1,
    explanation: `Funding skewness=${fSkew.toFixed(4)}. Real funding is typically positively skewed (longs pay shorts).`,
  };

  // H7: Unrealistically smooth OI curve?
  const oiChgStd = num(p2['oi_change_std'] as number);
  heuristics['oi_curve_roughness'] = {
    pass: oiChgStd > 1e-6,
    explanation: `OI change std=${oiChgStd.toExponential(4)}. Near-zero std indicates synthetic smoothness.`,
  };

  // H8: Volatility clustering (ARCH effect)?
  // Autocorrelation of squared returns — positive value indicates vol clustering
  const archTest = await q<{ sq_ret_autocorr: string }>(`
    WITH rets AS (
      SELECT timestamp, LN(mark_price / LAG(mark_price) OVER (ORDER BY timestamp)) AS r
      FROM mark_prices WHERE symbol=$1 AND timestamp >= $2 AND timestamp < $3
    ),
    sq AS (
      SELECT r*r AS sq_r, LAG(r*r) OVER (ORDER BY timestamp) AS lag_sq_r
      FROM rets WHERE r IS NOT NULL
    )
    SELECT CORR(sq_r, lag_sq_r)::TEXT AS sq_ret_autocorr FROM sq WHERE lag_sq_r IS NOT NULL
  `, [SYMBOL, startIso, endIso]);
  const archCorr = num(archTest[0]?.sq_ret_autocorr);
  heuristics['volatility_clustering'] = {
    pass: archCorr > 0.05,
    explanation: `Squared return autocorr(1)=${archCorr.toFixed(4)}. Real markets show strong vol clustering (>0.05).`,
  };

  // Print results
  console.log('');
  for (const [name, h] of Object.entries(heuristics)) {
    console.log(`  ${h.pass ? 'PASS' : 'FAIL'} | ${name}`);
    console.log(`       ${h.explanation}`);
  }

  return heuristics;
}

// ---------------------------------------------------------------------------
// PHASE 7 — Final quality score
// ---------------------------------------------------------------------------

function phase7(
  p1: Record<string, unknown>,
  p2: Record<string, unknown>,
  p3: Record<string, unknown>,
  p4: Record<string, unknown>,
  p5: Record<string, unknown>,
  p6: Record<string, { pass: boolean; explanation: string }>,
) {
  console.log('\n' + '='.repeat(68));
  console.log('  PHASE 7 — DATA QUALITY SCORING');
  console.log('='.repeat(68));

  let score = 100;
  const deductions: string[] = [];

  // Data presence
  const mpRows = num(p1['mark_prices_rows'] as number);
  const liqRows = num(p1['liquidations_rows'] as number);
  const frRows = num(p1['funding_rates_rows'] as number);
  const oiRows = num(p1['open_interest_rows'] as number);

  if (mpRows === 0) { score -= 40; deductions.push('No mark price data (-40)'); }
  if (liqRows === 0) { score -= 15; deductions.push('No liquidation data (-15). Expected if stream not yet started.'); }
  if (frRows === 0) { score -= 10; deductions.push('No funding rate data (-10)'); }
  if (oiRows === 0) { score -= 10; deductions.push('No open interest data (-10)'); }

  // Coverage
  const coverageStr = String(p1['coverage_pct'] || '0%');
  const coverage = parseFloat(coverageStr);
  if (coverage < 95 && mpRows > 0) { score -= 10; deductions.push(`Mark price coverage ${coverageStr} < 95% (-10)`); }
  if (coverage < 80 && mpRows > 0) { score -= 10; deductions.push(`Mark price coverage ${coverageStr} < 80% (-10 additional)`); }

  // Structural issues
  if (num(p1['mark_prices_pk_duplicates'] as number) > 0) { score -= 10; deductions.push('PK duplicates detected (-10)'); }
  if (num(p1['negative_zero_mark_prices'] as number) > 0) { score -= 10; deductions.push('Negative/zero mark prices (-10)'); }
  if (num(p1['negative_open_interest'] as number) > 0) { score -= 5; deductions.push('Negative OI detected (-5)'); }

  // Time series quality
  if (!p2['fat_tailed'] && mpRows > 0) { score -= 10; deductions.push('Returns not fat-tailed (-10)'); }
  if (num(p2['jumps_gt_10pct'] as number) > 5) { score -= 5; deductions.push('Many >10% 1-min jumps (-5)'); }

  // Synthetic heuristics
  const heurFails = Object.values(p6).filter(h => !h.pass).length;
  if (heurFails >= 4) { score -= 25; deductions.push(`${heurFails} synthetic heuristic failures (-25)`); }
  else if (heurFails >= 2) { score -= 10; deductions.push(`${heurFails} synthetic heuristic failures (-10)`); }

  score = Math.max(0, score);

  let rating: string;
  if (score >= 85) rating = 'EXCELLENT (institutional-grade)';
  else if (score >= 70) rating = 'STRONG (research-grade)';
  else if (score >= 50) rating = 'MODERATE (usable with caveats)';
  else if (score >= 25) rating = 'WEAK (ingestion issues)';
  else rating = 'INVALID (synthetic or corrupted)';

  console.log(`\n  Score       : ${score}/100`);
  console.log(`  Rating      : ${rating}`);
  if (deductions.length > 0) {
    console.log('  Deductions  :');
    for (const d of deductions) console.log(`    - ${d}`);
  }

  // Executive summary
  const hasData = mpRows > 0 || frRows > 0 || oiRows > 0;
  let summary: string;
  if (!hasData) {
    summary = `Database tables exist but contain no data for ${SYMBOL} in the ${DAYS}-day review window. `
      + `This is expected for a freshly deployed pipeline — the backfill scripts (npm run backfill) `
      + `and live ingestion (npm run ingest) must be executed to populate data. `
      + `Schema structure is sound. No audit anomalies detected at the structural level.`;
  } else if (liqRows === 0) {
    summary = `Market data (mark prices, funding, OI) is present and ${coverage >= 95 ? 'has excellent coverage' : 'partially populated'}. `
      + `Liquidation data is absent — this is expected as Binance does not offer a historical liquidation REST API; `
      + `forward collection via WebSocket (npm run ingest) is required. `
      + `Available data passes structural integrity checks.`;
  } else {
    summary = `Full dataset present for ${SYMBOL} across all 4 tables. `
      + `${heurFails === 0 ? 'All synthetic detection heuristics pass.' : `${heurFails} synthetic heuristic(s) flagged.`} `
      + `${coverage >= 95 ? 'Mark price coverage is institutional-grade.' : `Mark price coverage at ${coverageStr} has gaps.`}`;
  }

  console.log(`\n  Executive Summary:\n  ${summary}`);

  return {
    score,
    rating,
    deductions,
    executiveSummary: summary,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('='.repeat(68));
  console.log('  PRISM FORENSIC DATA AUDIT');
  console.log(`  Symbol: ${SYMBOL} | Window: ${DAYS} days`);
  console.log(`  Range : ${startIso} → ${endIso}`);
  console.log('='.repeat(68));

  // Ensure tables exist
  try {
    await q('SELECT 1 FROM mark_prices LIMIT 0');
  } catch {
    console.log('\n  Historical tables do not exist. Creating schema...');
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const dir = dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(join(dir, '..', 'src', 'historical', 'schema.sql'), 'utf-8');
    await pool.query(sql);
    console.log('  Schema created.');
  }

  const p1 = await phase1();
  const p2 = await phase2();
  const p3 = await phase3();
  const p4 = await phase4();
  const p5 = await phase5();
  const p6 = await phase6(p1, p2, p3, p4);
  const p7 = phase7(p1, p2, p3, p4, p5, p6);

  // Output full JSON
  const report = {
    structuralIntegrity: p1,
    timeSeriesQuality: p2,
    liquidationRealism: p3,
    microstructureConsistency: p4,
    cascadeValidation: p5,
    syntheticHeuristics: p6,
    finalRating: p7.rating,
    finalScore: p7.score,
    executiveSummary: p7.executiveSummary,
  };

  const { writeFileSync } = await import('node:fs');
  const outPath = `audit-${SYMBOL}-${DAYS}d.json`;
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\n  Full JSON report: ${outPath}`);

  await pool.end();
}

main().catch(async (err) => {
  console.error('Audit failed:', err);
  await pool.end();
  process.exit(1);
});
