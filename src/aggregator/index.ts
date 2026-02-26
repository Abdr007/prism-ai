import type { ExchangeClient, ExchangeData } from '../exchanges/types.js';
import { pythOracle, type PythPrice } from '../oracle/index.js';

// Data validation thresholds to filter out obviously bad exchange data
const VALIDATION = {
  // Max funding rate we'll accept (1% is extremely rare)
  MAX_FUNDING_RATE: 0.01,
  // Max OI value per exchange ($500B is more than total crypto market)
  MAX_OI_VALUE: 500_000_000_000,
  // Max price deviation from median before we filter (50%)
  MAX_PRICE_DEVIATION: 0.5,
};

export interface PriceComparison {
  exchange: string;
  price: number;
  deviation: number; // % deviation from oracle price
  deviationUSD: number; // $ deviation from oracle price
}

export interface AggregatedData {
  timestamp: number;
  symbols: string[];
  exchanges: string[];

  // Aggregated metrics per symbol
  metrics: {
    [symbol: string]: {
      // Oracle price (source of truth)
      oraclePrice: number;
      oracleConfidence: number;
      oracleSource: string;

      // Exchange prices with comparison
      avgMarkPrice: number;
      markPriceByExchange: { [exchange: string]: number };
      priceComparison: PriceComparison[];
      maxDeviation: number; // Max % deviation from oracle
      priceDeviation: number; // Max deviation between exchanges

      // Open Interest
      totalOpenInterestValue: number;
      openInterestByExchange: { [exchange: string]: number };

      // Funding rates
      avgFundingRate: number;
      fundingRateByExchange: { [exchange: string]: number };
    };
  };

  // Risk signals
  riskSignals: RiskSignal[];
}

export interface RiskSignal {
  type: 'HIGH_FUNDING' | 'OI_SPIKE' | 'PRICE_DEVIATION' | 'CASCADE_WARNING';
  severity: 'low' | 'medium' | 'high' | 'critical';
  symbol: string;
  message: string;
  data: Record<string, unknown>;
}

export class DataAggregator {
  private clients: ExchangeClient[];

  constructor(clients: ExchangeClient[]) {
    this.clients = clients;
  }

  async fetchAll(symbols: string[]): Promise<ExchangeData[]> {
    const results = await Promise.allSettled(
      this.clients.map(client => client.getAllData(symbols))
    );

    return results
      .filter((r): r is PromiseFulfilledResult<ExchangeData> => r.status === 'fulfilled')
      .map(r => r.value);
  }

  async aggregate(exchangeData: ExchangeData[], symbols: string[]): Promise<AggregatedData> {
    const metrics: AggregatedData['metrics'] = {};
    const riskSignals: RiskSignal[] = [];

    // Fetch oracle prices
    const oraclePrices = await pythOracle.getAllPrices(symbols);

    for (const symbol of symbols) {
      const oiByExchange: { [exchange: string]: number } = {};
      const fundingByExchange: { [exchange: string]: number } = {};
      const priceByExchange: { [exchange: string]: number } = {};

      let totalOI = 0;
      let fundingSum = 0;
      let fundingCount = 0;
      let priceSum = 0;
      let priceCount = 0;

      for (const data of exchangeData) {
        // Open Interest (with validation)
        const oi = data.openInterest.find(o => o.symbol === symbol);
        if (oi && oi.openInterestValue > 0) {
          // Filter out obviously bad OI values (> $500B per exchange)
          if (oi.openInterestValue < VALIDATION.MAX_OI_VALUE) {
            oiByExchange[data.exchange] = oi.openInterestValue;
            totalOI += oi.openInterestValue;
          }
        }

        // Funding Rate (with validation)
        const funding = data.fundingRates.find(f => f.symbol === symbol);
        if (funding && funding.fundingRate !== 0) {
          // Filter out obviously bad funding rates (> 1%)
          if (Math.abs(funding.fundingRate) < VALIDATION.MAX_FUNDING_RATE) {
            fundingByExchange[data.exchange] = funding.fundingRate;
            fundingSum += funding.fundingRate;
            fundingCount++;
          }
        }

        // Mark Price
        const price = data.markPrices.find(p => p.symbol === symbol);
        if (price && price.markPrice > 0) {
          priceByExchange[data.exchange] = price.markPrice;
          priceSum += price.markPrice;
          priceCount++;
        }
      }

      // Second pass: filter out prices that are way off from median
      if (priceCount >= 2) {
        const prices = Object.entries(priceByExchange);
        const sortedPrices = prices.sort((a, b) => a[1] - b[1]);
        const medianPrice = sortedPrices[Math.floor(sortedPrices.length / 2)][1];

        // Remove prices that deviate more than 50% from median
        for (const [exchange, price] of prices) {
          const deviation = Math.abs(price - medianPrice) / medianPrice;
          if (deviation > VALIDATION.MAX_PRICE_DEVIATION) {
            priceSum -= price;
            priceCount--;
            delete priceByExchange[exchange];
          }
        }
      }

      // Calculate averages with NaN protection
      let avgFunding = fundingCount > 0 ? fundingSum / fundingCount : 0;
      let avgPrice = priceCount > 0 ? priceSum / priceCount : 0;

      // Ensure values are valid numbers
      if (!isFinite(avgFunding)) avgFunding = 0;
      if (!isFinite(avgPrice)) avgPrice = 0;

      // Get oracle price (use Pyth, fallback to avg exchange price)
      const pythPrice = oraclePrices.get(symbol);
      const oraclePrice = pythPrice?.price || avgPrice;
      const oracleConfidence = pythPrice?.confidence || 0;

      // Calculate price comparisons for each exchange
      const priceComparison: PriceComparison[] = [];
      let maxDeviation = 0;

      for (const [exchange, price] of Object.entries(priceByExchange)) {
        if (price > 0 && oraclePrice > 0) {
          const deviation = ((price - oraclePrice) / oraclePrice) * 100;
          const deviationUSD = price - oraclePrice;

          priceComparison.push({
            exchange,
            price,
            deviation,
            deviationUSD,
          });

          if (Math.abs(deviation) > Math.abs(maxDeviation)) {
            maxDeviation = deviation;
          }
        }
      }

      // Sort by deviation (highest first)
      priceComparison.sort((a, b) => Math.abs(b.deviation) - Math.abs(a.deviation));

      // Calculate price deviation between exchanges with validation
      const prices = Object.values(priceByExchange).filter(p => p > 0 && isFinite(p));
      const maxPrice = prices.length > 0 ? Math.max(...prices) : 0;
      const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
      let priceDeviation = 0;
      if (oraclePrice > 0 && isFinite(oraclePrice) && maxPrice > 0 && minPrice > 0) {
        priceDeviation = ((maxPrice - minPrice) / oraclePrice) * 100;
        // Sanity check: deviation should be < 50%
        if (!isFinite(priceDeviation) || priceDeviation > 50) {
          priceDeviation = 0;
        }
      }

      metrics[symbol] = {
        oraclePrice,
        oracleConfidence,
        oracleSource: pythPrice ? 'Pyth Network' : 'Exchange Average',
        avgMarkPrice: avgPrice,
        markPriceByExchange: priceByExchange,
        priceComparison,
        maxDeviation,
        priceDeviation,
        totalOpenInterestValue: totalOI,
        openInterestByExchange: oiByExchange,
        avgFundingRate: avgFunding,
        fundingRateByExchange: fundingByExchange,
      };

      // Generate risk signals
      // High funding rate warning
      if (Math.abs(avgFunding) > 0.001) {
        riskSignals.push({
          type: 'HIGH_FUNDING',
          severity: Math.abs(avgFunding) > 0.002 ? 'critical' : 'high',
          symbol,
          message: `Elevated funding rate: ${(avgFunding * 100).toFixed(4)}%`,
          data: { avgFunding, fundingByExchange },
        });
      } else if (Math.abs(avgFunding) > 0.0005) {
        riskSignals.push({
          type: 'HIGH_FUNDING',
          severity: 'medium',
          symbol,
          message: `Moderate funding rate: ${(avgFunding * 100).toFixed(4)}%`,
          data: { avgFunding, fundingByExchange },
        });
      }

      // Price deviation warning
      if (Math.abs(maxDeviation) > 0.5) {
        riskSignals.push({
          type: 'PRICE_DEVIATION',
          severity: Math.abs(maxDeviation) > 1 ? 'high' : 'medium',
          symbol,
          message: `Exchange price deviation from oracle: ${maxDeviation.toFixed(2)}%`,
          data: { maxDeviation, priceComparison, oraclePrice },
        });
      }
    }

    return {
      timestamp: Date.now(),
      symbols,
      exchanges: exchangeData.map(d => d.exchange),
      metrics,
      riskSignals,
    };
  }

  async run(symbols: string[]): Promise<AggregatedData> {
    const data = await this.fetchAll(symbols);
    return this.aggregate(data, symbols);
  }
}
