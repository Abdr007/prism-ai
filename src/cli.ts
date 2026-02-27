import { BinanceClient, BybitClient, OKXClient, DYDXClient, HyperliquidClient } from './exchanges/index.js';
import { PrismMonitor } from './monitor/index.js';
import type { CascadeRisk } from './predictor/index.js';
import type { AggregatedData } from './aggregator/index.js';
import { logger as rootLogger } from './lib/logger.js';

const log = rootLogger.child({ component: 'cli' });

const SYMBOLS = ['BTC', 'ETH'];
const POLL_INTERVAL_MS = 30_000; // 30 seconds

function clearScreen(): void {
  process.stdout.write('\x1B[2J\x1B[0f');
}

function formatUSD(value: number): string {
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function formatFundingRate(rate: number): string {
  const pct = (rate * 100).toFixed(4);
  return rate >= 0 ? `+${pct}%` : `${pct}%`;
}

function getRiskIcon(level: CascadeRisk['riskLevel']): string {
  switch (level) {
    case 'critical': return '🔴';
    case 'high': return '🟠';
    case 'elevated': return '🟡';
    case 'moderate': return '🔵';
    case 'low': return '🟢';
  }
}

function getRiskBar(score: number): string {
  const filled = Math.round(score / 10);
  const empty = 10 - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

function renderData(data: AggregatedData, cascadeRisks: CascadeRisk[], dbStats?: { snapshotCount: number }): void {
  clearScreen();

  const w = (s: string) => process.stdout.write(s + '\n');
  w('╔══════════════════════════════════════════════════════════════════════╗');
  w('║              PRISM - Cross-Exchange Risk Intelligence                ║');
  w('║                    Liquidation Cascade Predictor                     ║');
  w('╚══════════════════════════════════════════════════════════════════════╝');
  w('');
  w(`  Exchanges: ${data.exchanges.join(', ')}`);
  w(`  Updated:   ${new Date(data.timestamp).toLocaleTimeString()}`);
  if (dbStats) {
    w(`  DB Records: ${dbStats.snapshotCount.toLocaleString()}`);
  }
  w('');

  for (const symbol of data.symbols) {
    const m = data.metrics[symbol];
    const risk = cascadeRisks.find(r => r.symbol === symbol);
    if (!m || !risk) continue;

    // Header with risk level
    w('┌──────────────────────────────────────────────────────────────────────┐');
    w(`│  ${symbol}/USDT  ${getRiskIcon(risk.riskLevel)} Risk: ${risk.riskScore}/100 [${getRiskBar(risk.riskScore)}] ${risk.riskLevel.toUpperCase().padStart(10)}  │`);
    w('├──────────────────────────────────────────────────────────────────────┤');

    // Market data
    w(`│  Price: $${m.avgMarkPrice.toLocaleString(undefined, { maximumFractionDigits: 2 }).padEnd(12)} OI: ${formatUSD(m.totalOpenInterestValue).padEnd(10)} Funding: ${formatFundingRate(m.avgFundingRate).padEnd(10)}│`);
    w('├──────────────────────────────────────────────────────────────────────┤');

    // Risk factors
    w('│  Risk Factors:                                                       │');
    for (const factor of risk.factors) {
      const scoreBar = '▓'.repeat(Math.round(factor.score / 20)) + '░'.repeat(5 - Math.round(factor.score / 20));
      const line = `│    ${factor.name.padEnd(20)} [${scoreBar}] ${factor.score.toFixed(0).padStart(3)}/100`;
      w(line.padEnd(72) + '│');
    }

    // Prediction if elevated risk
    if (risk.prediction) {
      w('├──────────────────────────────────────────────────────────────────────┤');
      w('│  ⚠️  CASCADE PREDICTION:                                             │');
      const pred = risk.prediction;
      const direction = pred.direction === 'long_squeeze' ? '📉 LONG SQUEEZE' : '📈 SHORT SQUEEZE';
      w(`│    Direction:    ${direction.padEnd(52)}│`);
      w(`│    Probability:  ${(pred.probability * 100).toFixed(0)}%`.padEnd(72) + '│');
      w(`│    Est. Impact:  ${formatUSD(pred.estimatedImpact)} in liquidations`.padEnd(72) + '│');
      w(`│    Trigger:      $${pred.triggerPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })} (${pred.triggerDistance.toFixed(1)}% away)`.padEnd(72) + '│');
      w(`│    Time Window:  ${pred.timeWindow}`.padEnd(72) + '│');
    }

    w('└──────────────────────────────────────────────────────────────────────┘');
    w('');
  }

  // Alert summary
  const criticalRisks = cascadeRisks.filter(r => r.riskLevel === 'critical' || r.riskLevel === 'high');
  if (criticalRisks.length > 0) {
    w('⚠️  HIGH RISK ASSETS: ' + criticalRisks.map(r => `${r.symbol} (${r.riskScore})`).join(', '));
  } else {
    w('✅ All assets within normal risk parameters');
  }

  w('');
  w('  Press Ctrl+C to stop');
}

async function main(): Promise<void> {
  const clients = [
    new BinanceClient(),
    new BybitClient(),
    new OKXClient(),
    new DYDXClient(),
    new HyperliquidClient(),
  ];

  const monitor = new PrismMonitor(clients, {
    symbols: SYMBOLS,
    intervalMs: POLL_INTERVAL_MS,
    persistData: true, // Enable database persistence
  });

  monitor.on('cascade', async (risks: CascadeRisk[]) => {
    const data = monitor.getLastData();
    if (!data) return;

    const db = monitor.getDatabase();
    const dbStats = db ? await db.getStats() : undefined;
    renderData(data, risks, dbStats);
  });

  monitor.on('error', (error: Error) => {
    log.error({ err: error.message }, 'Monitor error');
  });

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    log.info('Shutting down');
    await monitor.stop();
    process.exit(0);
  });

  log.info('Starting Prism monitor with cascade prediction');
  log.info('Data will be persisted to PostgreSQL');
  await monitor.start();
}

main().catch((err) => log.error({ err: err instanceof Error ? err.message : err }, 'Fatal error'));
