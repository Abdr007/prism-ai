import { BinanceClient, BybitClient, OKXClient, DYDXClient, HyperliquidClient } from './exchanges/index.js';
import { PrismMonitor } from './monitor/index.js';
import type { CascadeRisk } from './predictor/index.js';
import type { AggregatedData } from './aggregator/index.js';

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

  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║              PRISM - Cross-Exchange Risk Intelligence                ║');
  console.log('║                    Liquidation Cascade Predictor                     ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log();
  console.log(`  Exchanges: ${data.exchanges.join(', ')}`);
  console.log(`  Updated:   ${new Date(data.timestamp).toLocaleTimeString()}`);
  if (dbStats) {
    console.log(`  DB Records: ${dbStats.snapshotCount.toLocaleString()}`);
  }
  console.log();

  for (const symbol of data.symbols) {
    const m = data.metrics[symbol];
    const risk = cascadeRisks.find(r => r.symbol === symbol);
    if (!m || !risk) continue;

    // Header with risk level
    console.log('┌──────────────────────────────────────────────────────────────────────┐');
    console.log(`│  ${symbol}/USDT  ${getRiskIcon(risk.riskLevel)} Risk: ${risk.riskScore}/100 [${getRiskBar(risk.riskScore)}] ${risk.riskLevel.toUpperCase().padStart(10)}  │`);
    console.log('├──────────────────────────────────────────────────────────────────────┤');

    // Market data
    console.log(`│  Price: $${m.avgMarkPrice.toLocaleString(undefined, { maximumFractionDigits: 2 }).padEnd(12)} OI: ${formatUSD(m.totalOpenInterestValue).padEnd(10)} Funding: ${formatFundingRate(m.avgFundingRate).padEnd(10)}│`);
    console.log('├──────────────────────────────────────────────────────────────────────┤');

    // Risk factors
    console.log('│  Risk Factors:                                                       │');
    for (const factor of risk.factors) {
      const scoreBar = '▓'.repeat(Math.round(factor.score / 20)) + '░'.repeat(5 - Math.round(factor.score / 20));
      const line = `│    ${factor.name.padEnd(20)} [${scoreBar}] ${factor.score.toFixed(0).padStart(3)}/100`;
      console.log(line.padEnd(72) + '│');
    }

    // Prediction if elevated risk
    if (risk.prediction) {
      console.log('├──────────────────────────────────────────────────────────────────────┤');
      console.log('│  ⚠️  CASCADE PREDICTION:                                             │');
      const pred = risk.prediction;
      const direction = pred.direction === 'long_squeeze' ? '📉 LONG SQUEEZE' : '📈 SHORT SQUEEZE';
      console.log(`│    Direction:    ${direction.padEnd(52)}│`);
      console.log(`│    Probability:  ${(pred.probability * 100).toFixed(0)}%`.padEnd(72) + '│');
      console.log(`│    Est. Impact:  ${formatUSD(pred.estimatedImpact)} in liquidations`.padEnd(72) + '│');
      console.log(`│    Trigger:      $${pred.triggerPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })} (${pred.triggerDistance.toFixed(1)}% away)`.padEnd(72) + '│');
      console.log(`│    Time Window:  ${pred.timeWindow}`.padEnd(72) + '│');
    }

    console.log('└──────────────────────────────────────────────────────────────────────┘');
    console.log();
  }

  // Alert summary
  const criticalRisks = cascadeRisks.filter(r => r.riskLevel === 'critical' || r.riskLevel === 'high');
  if (criticalRisks.length > 0) {
    console.log('⚠️  HIGH RISK ASSETS: ' + criticalRisks.map(r => `${r.symbol} (${r.riskScore})`).join(', '));
  } else {
    console.log('✅ All assets within normal risk parameters');
  }

  console.log();
  console.log('  Press Ctrl+C to stop');
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

  monitor.on('cascade', (risks: CascadeRisk[]) => {
    const data = monitor.getLastData();
    if (!data) return;

    const db = monitor.getDatabase();
    const dbStats = db ? db.getStats() : undefined;
    renderData(data, risks, dbStats);
  });

  monitor.on('error', (error: Error) => {
    console.error('Monitor error:', error.message);
  });

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    monitor.stop();
    process.exit(0);
  });

  console.log('Starting Prism monitor with cascade prediction...');
  console.log('Data will be persisted to ./data/prism.db');
  await monitor.start();
}

main().catch(console.error);
