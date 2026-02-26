import { BinanceClient, BybitClient, OKXClient, DYDXClient, HyperliquidClient } from './exchanges/index.js';
import { DataAggregator } from './aggregator/index.js';

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
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║                    PRISM - Risk Intelligence               ║');
  console.log('║           Cross-Exchange Perpetual Futures Monitor         ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log();

  const clients = [
    new BinanceClient(),
    new BybitClient(),
    new OKXClient(),
    new DYDXClient(),
    new HyperliquidClient(),
  ];

  const aggregator = new DataAggregator(clients);

  console.log(`Fetching data from ${clients.length} exchanges...`);
  console.log(`Symbols: ${SYMBOLS.join(', ')}`);
  console.log();

  try {
    const data = await aggregator.run(SYMBOLS);

    console.log(`✓ Data fetched from: ${data.exchanges.join(', ')}`);
    console.log(`  Timestamp: ${new Date(data.timestamp).toISOString()}`);
    console.log();

    // Display metrics for each symbol
    for (const symbol of SYMBOLS) {
      const m = data.metrics[symbol];
      if (!m) continue;

      console.log('─'.repeat(60));
      console.log(`  ${symbol}/USDT PERPETUAL`);
      console.log('─'.repeat(60));

      console.log();
      console.log('  OPEN INTEREST');
      console.log(`  Total: ${formatUSD(m.totalOpenInterestValue)}`);
      for (const [exchange, value] of Object.entries(m.openInterestByExchange)) {
        const pct = ((value / m.totalOpenInterestValue) * 100).toFixed(1);
        console.log(`    ${exchange.padEnd(10)} ${formatUSD(value).padStart(12)}  (${pct}%)`);
      }

      console.log();
      console.log('  FUNDING RATE (8h)');
      console.log(`  Average: ${formatFundingRate(m.avgFundingRate)}`);
      for (const [exchange, rate] of Object.entries(m.fundingRateByExchange)) {
        console.log(`    ${exchange.padEnd(10)} ${formatFundingRate(rate).padStart(12)}`);
      }

      console.log();
      console.log('  MARK PRICE');
      console.log(`  Average: $${m.avgMarkPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
      console.log(`  Cross-exchange deviation: ${m.priceDeviation.toFixed(4)}%`);
      for (const [exchange, price] of Object.entries(m.markPriceByExchange)) {
        console.log(`    ${exchange.padEnd(10)} $${price.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
      }
      console.log();
    }

    // Display risk signals
    if (data.riskSignals.length > 0) {
      console.log('═'.repeat(60));
      console.log('  RISK SIGNALS');
      console.log('═'.repeat(60));
      console.log();

      for (const signal of data.riskSignals) {
        const icon = signal.severity === 'critical' ? '🔴' :
                     signal.severity === 'high' ? '🟠' :
                     signal.severity === 'medium' ? '🟡' : '🟢';
        console.log(`  ${icon} [${signal.severity.toUpperCase()}] ${signal.symbol}: ${signal.message}`);
      }
      console.log();
    } else {
      console.log('═'.repeat(60));
      console.log('  ✓ No significant risk signals detected');
      console.log('═'.repeat(60));
      console.log();
    }

  } catch (error) {
    console.error('Error fetching data:', error);
    process.exit(1);
  }
}

main();
