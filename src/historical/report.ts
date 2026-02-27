/**
 * Phase 6 — Data Sanity Check Report
 *
 * Generates a comprehensive quality report for a given symbol
 * and time period. All statistics are computed directly in PostgreSQL
 * — no data is loaded into application memory.
 *
 * Output:
 *   - Total rows per table
 *   - Missing minute gaps (mark price)
 *   - Liquidation volume distribution
 *   - Mark price 1-minute return distribution
 *   - Funding rate distribution
 *   - Open interest distribution
 *
 * Usage:
 *   npx tsx src/historical/report.ts BTCUSDT 30
 */

import {
  ensureHistoricalSchema,
  getTableStats,
  getDistribution,
  getMarkPriceGaps,
  getMarkPriceReturnDistribution,
  closePool,
} from './db.js';
import { logger as rootLogger } from '../lib/logger.js';
import type { DataReport } from './types.js';

const log = rootLogger.child({ component: 'data-report' });

// ---------------------------------------------------------------------------
// Report Generator
// ---------------------------------------------------------------------------

export async function generateDataReport(
  symbol: string,
  days: number,
): Promise<DataReport> {
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);

  log.info({ symbol, days, start: startDate.toISOString(), end: endDate.toISOString() }, 'Generating data report');

  await ensureHistoricalSchema();

  // Gather all stats in parallel
  const [
    markStats,
    liqStats,
    fundingStats,
    oiStats,
    markGaps,
    returnDist,
    liqVolDist,
    fundingDist,
    oiDist,
  ] = await Promise.all([
    getTableStats('mark_prices', symbol, 'timestamp', startDate, endDate),
    getTableStats('liquidations', symbol, 'timestamp', startDate, endDate),
    getTableStats('funding_rates', symbol, 'funding_time', startDate, endDate),
    getTableStats('open_interest', symbol, 'timestamp', startDate, endDate),
    getMarkPriceGaps(symbol, startDate, endDate),
    getMarkPriceReturnDistribution(symbol, startDate, endDate),
    getDistribution('liquidations', 'usd_value', symbol, 'timestamp', startDate, endDate),
    getDistribution('funding_rates', 'funding_rate', symbol, 'funding_time', startDate, endDate),
    getDistribution('open_interest', 'open_interest_usd', symbol, 'timestamp', startDate, endDate),
  ]);

  const report: DataReport = {
    symbol,
    period: {
      start: startDate.toISOString(),
      end: endDate.toISOString(),
      days,
    },
    tables: {
      mark_prices: markStats,
      liquidations: liqStats,
      funding_rates: fundingStats,
      open_interest: oiStats,
    },
    gaps: {
      mark_price_missing_minutes: markGaps.totalMissing,
      mark_price_gap_ranges: markGaps.ranges,
    },
    distributions: {
      liquidation_volume: liqVolDist,
      mark_price_returns: returnDist,
      funding_rate: fundingDist,
      open_interest_usd: oiDist,
    },
  };

  log.info({
    symbol,
    mark_prices: markStats.total_rows,
    liquidations: liqStats.total_rows,
    funding_rates: fundingStats.total_rows,
    open_interest: oiStats.total_rows,
    missing_minutes: markGaps.totalMissing,
  }, 'Data report generated');

  return report;
}

// ---------------------------------------------------------------------------
// Pretty-print report
// ---------------------------------------------------------------------------

function formatNumber(n: number, decimals = 4): string {
  if (Math.abs(n) < 0.0001 && n !== 0) return n.toExponential(2);
  return n.toFixed(decimals);
}

function formatUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

export function printReport(report: DataReport): void {
  const divider = '='.repeat(68);
  const lines: string[] = [];

  lines.push('');
  lines.push(divider);
  lines.push(`  PRISM Data Quality Report — ${report.symbol}`);
  lines.push(divider);
  lines.push(`  Period: ${report.period.start.slice(0, 10)} to ${report.period.end.slice(0, 10)} (${report.period.days} days)`);
  lines.push('');

  // Table stats
  lines.push('  TABLE ROW COUNTS');
  lines.push('  ' + '-'.repeat(50));
  const tables = report.tables;
  lines.push(`  mark_prices     : ${tables.mark_prices.total_rows.toLocaleString()} rows`);
  lines.push(`    range          : ${tables.mark_prices.earliest ?? 'N/A'} → ${tables.mark_prices.latest ?? 'N/A'}`);
  lines.push(`  liquidations    : ${tables.liquidations.total_rows.toLocaleString()} rows`);
  lines.push(`    range          : ${tables.liquidations.earliest ?? 'N/A'} → ${tables.liquidations.latest ?? 'N/A'}`);
  lines.push(`  funding_rates   : ${tables.funding_rates.total_rows.toLocaleString()} rows`);
  lines.push(`    range          : ${tables.funding_rates.earliest ?? 'N/A'} → ${tables.funding_rates.latest ?? 'N/A'}`);
  lines.push(`  open_interest   : ${tables.open_interest.total_rows.toLocaleString()} rows`);
  lines.push(`    range          : ${tables.open_interest.earliest ?? 'N/A'} → ${tables.open_interest.latest ?? 'N/A'}`);
  lines.push('');

  // Expected minutes
  const expectedMinutes = report.period.days * 24 * 60;
  const coverage = tables.mark_prices.total_rows > 0
    ? ((tables.mark_prices.total_rows / expectedMinutes) * 100).toFixed(1)
    : '0.0';
  lines.push('  MARK PRICE COVERAGE');
  lines.push('  ' + '-'.repeat(50));
  lines.push(`  Expected minutes : ${expectedMinutes.toLocaleString()}`);
  lines.push(`  Present          : ${tables.mark_prices.total_rows.toLocaleString()}`);
  lines.push(`  Missing          : ${report.gaps.mark_price_missing_minutes.toLocaleString()}`);
  lines.push(`  Coverage         : ${coverage}%`);

  if (report.gaps.mark_price_gap_ranges.length > 0) {
    lines.push(`  Gap ranges (top ${Math.min(10, report.gaps.mark_price_gap_ranges.length)}):`);
    for (const g of report.gaps.mark_price_gap_ranges.slice(0, 10)) {
      lines.push(`    ${g.start} → ${g.end}  (${g.missing} min)`);
    }
  }
  lines.push('');

  // Distributions
  const dist = report.distributions;

  lines.push('  MARK PRICE 1-MIN RETURNS (log)');
  lines.push('  ' + '-'.repeat(50));
  if (dist.mark_price_returns.count > 0) {
    lines.push(`  count  : ${dist.mark_price_returns.count.toLocaleString()}`);
    lines.push(`  mean   : ${formatNumber(dist.mark_price_returns.mean, 8)}`);
    lines.push(`  std    : ${formatNumber(dist.mark_price_returns.std, 8)}`);
    lines.push(`  min    : ${formatNumber(dist.mark_price_returns.min, 6)}`);
    lines.push(`  p25    : ${formatNumber(dist.mark_price_returns.p25, 8)}`);
    lines.push(`  median : ${formatNumber(dist.mark_price_returns.median, 8)}`);
    lines.push(`  p75    : ${formatNumber(dist.mark_price_returns.p75, 8)}`);
    lines.push(`  max    : ${formatNumber(dist.mark_price_returns.max, 6)}`);
  } else {
    lines.push('  No data');
  }
  lines.push('');

  lines.push('  LIQUIDATION VOLUME (USD)');
  lines.push('  ' + '-'.repeat(50));
  if (dist.liquidation_volume.count > 0) {
    lines.push(`  count  : ${dist.liquidation_volume.count.toLocaleString()}`);
    lines.push(`  mean   : ${formatUsd(dist.liquidation_volume.mean)}`);
    lines.push(`  std    : ${formatUsd(dist.liquidation_volume.std)}`);
    lines.push(`  min    : ${formatUsd(dist.liquidation_volume.min)}`);
    lines.push(`  p25    : ${formatUsd(dist.liquidation_volume.p25)}`);
    lines.push(`  median : ${formatUsd(dist.liquidation_volume.median)}`);
    lines.push(`  p75    : ${formatUsd(dist.liquidation_volume.p75)}`);
    lines.push(`  max    : ${formatUsd(dist.liquidation_volume.max)}`);
  } else {
    lines.push('  No data (liquidations require live WebSocket collection)');
  }
  lines.push('');

  lines.push('  FUNDING RATE DISTRIBUTION');
  lines.push('  ' + '-'.repeat(50));
  if (dist.funding_rate.count > 0) {
    lines.push(`  count  : ${dist.funding_rate.count.toLocaleString()}`);
    lines.push(`  mean   : ${formatNumber(dist.funding_rate.mean, 6)}`);
    lines.push(`  std    : ${formatNumber(dist.funding_rate.std, 6)}`);
    lines.push(`  min    : ${formatNumber(dist.funding_rate.min, 6)}`);
    lines.push(`  p25    : ${formatNumber(dist.funding_rate.p25, 6)}`);
    lines.push(`  median : ${formatNumber(dist.funding_rate.median, 6)}`);
    lines.push(`  p75    : ${formatNumber(dist.funding_rate.p75, 6)}`);
    lines.push(`  max    : ${formatNumber(dist.funding_rate.max, 6)}`);
  } else {
    lines.push('  No data');
  }
  lines.push('');

  lines.push('  OPEN INTEREST DISTRIBUTION (USD)');
  lines.push('  ' + '-'.repeat(50));
  if (dist.open_interest_usd.count > 0) {
    lines.push(`  count  : ${dist.open_interest_usd.count.toLocaleString()}`);
    lines.push(`  mean   : ${formatUsd(dist.open_interest_usd.mean)}`);
    lines.push(`  std    : ${formatUsd(dist.open_interest_usd.std)}`);
    lines.push(`  min    : ${formatUsd(dist.open_interest_usd.min)}`);
    lines.push(`  p25    : ${formatUsd(dist.open_interest_usd.p25)}`);
    lines.push(`  median : ${formatUsd(dist.open_interest_usd.median)}`);
    lines.push(`  p75    : ${formatUsd(dist.open_interest_usd.p75)}`);
    lines.push(`  max    : ${formatUsd(dist.open_interest_usd.max)}`);
  } else {
    lines.push('  No data');
  }

  lines.push('');
  lines.push(divider);

  // Print all at once
  process.stdout.write(lines.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const symbol = args[0] || 'BTCUSDT';
  const days = Number(args[1]) || 30;

  const report = await generateDataReport(symbol, days);

  // Print human-readable report
  printReport(report);

  // Also output JSON for programmatic use
  const jsonPath = `data-report-${symbol}-${days}d.json`;
  const { writeFileSync } = await import('node:fs');
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  log.info({ path: jsonPath }, 'JSON report written');

  await closePool();
}

const isMain = process.argv[1]?.includes('report');
if (isMain) {
  main().catch((err) => {
    log.error({ err: err instanceof Error ? err.message : err }, 'Report failed');
    process.exit(1);
  });
}
