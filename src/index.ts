import { BinanceClient, BybitClient, OKXClient, DYDXClient, HyperliquidClient } from './exchanges/index.js';
import { DataAggregator } from './aggregator/index.js';
import { DataValidator } from './middleware/validation.js';
import { logger as rootLogger } from './lib/logger.js';

const log = rootLogger.child({ component: 'fetch' });

const SYMBOLS = ['BTC', 'ETH'];

function formatUSD(value: number): string {
  if (value >= 1_000_000_000) {
    return `$${(value / 1_000_000_000).toFixed(2)}B`;
  }
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(2)}M`;
  }
  return `$${value.toLocaleString()}`;
}

function formatFundingRate(rate: number): string {
  return `${(rate * 100).toFixed(4)}%`;
}

async function main() {
  const w = (s: string) => process.stdout.write(s + '\n');
  w('╔════════════════════════════════════════════════════════════╗');
  w('║                    PRISM - Risk Intelligence               ║');
  w('║           Cross-Exchange Perpetual Futures Monitor         ║');
  w('╚════════════════════════════════════════════════════════════╝');
  w('');

  const clients = [
    new BinanceClient(),
    new BybitClient(),
    new OKXClient(),
    new DYDXClient(),
    new HyperliquidClient(),
  ];

  const aggregator = new DataAggregator(clients);
  const validator = new DataValidator();

  w(`Fetching data from ${clients.length} exchanges...`);
  w(`Symbols: ${SYMBOLS.join(', ')}`);
  w('');

  try {
    // Fetch → Validate → Aggregate (no bypass)
    const rawData = await aggregator.fetchAll(SYMBOLS);
    const validatedData = validator.validateBatch(rawData);
    const data = await aggregator.aggregate(validatedData, SYMBOLS);

    w(`✓ Data fetched from: ${data.exchanges.join(', ')}`);
    w(`  Timestamp: ${new Date(data.timestamp).toISOString()}`);
    w('');

    // Display metrics for each symbol
    for (const symbol of SYMBOLS) {
      const m = data.metrics[symbol];
      if (!m) continue;

      w('─'.repeat(60));
      w(`  ${symbol}/USDT PERPETUAL`);
      w('─'.repeat(60));

      w('');
      w('  OPEN INTEREST');
      w(`  Total: ${formatUSD(m.totalOpenInterestValue)}`);
      for (const [exchange, value] of Object.entries(m.openInterestByExchange)) {
        const pct = ((value / m.totalOpenInterestValue) * 100).toFixed(1);
        w(`    ${exchange.padEnd(10)} ${formatUSD(value).padStart(12)}  (${pct}%)`);
      }

      w('');
      w('  FUNDING RATE (8h)');
      w(`  Average: ${formatFundingRate(m.avgFundingRate)}`);
      for (const [exchange, rate] of Object.entries(m.fundingRateByExchange)) {
        w(`    ${exchange.padEnd(10)} ${formatFundingRate(rate).padStart(12)}`);
      }

      w('');
      w('  MARK PRICE');
      w(`  Average: $${m.avgMarkPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
      w(`  Cross-exchange deviation: ${m.priceDeviation.toFixed(4)}%`);
      for (const [exchange, price] of Object.entries(m.markPriceByExchange)) {
        w(`    ${exchange.padEnd(10)} $${price.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
      }
      w('');
    }

    // Display risk signals
    if (data.riskSignals.length > 0) {
      w('═'.repeat(60));
      w('  RISK SIGNALS');
      w('═'.repeat(60));
      w('');

      for (const signal of data.riskSignals) {
        const icon = signal.severity === 'critical' ? '🔴' :
                     signal.severity === 'high' ? '🟠' :
                     signal.severity === 'medium' ? '🟡' : '🟢';
        w(`  ${icon} [${signal.severity.toUpperCase()}] ${signal.symbol}: ${signal.message}`);
      }
      w('');
    } else {
      w('═'.repeat(60));
      w('  ✓ No significant risk signals detected');
      w('═'.repeat(60));
      w('');
    }

  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : error }, 'Error fetching data');
    process.exit(1);
  }
}

main();
