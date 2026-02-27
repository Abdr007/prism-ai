import { BaseExchangeClient } from './base.js';
import type { OpenInterest, FundingRate, MarkPrice, ExchangeData } from './types.js';

const BASE_URL = 'https://indexer.dydx.trade/v4';

function toExchangeSymbol(symbol: string): string {
  return `${symbol}-USD`;
}

interface DYDXMarket {
  openInterest: string;
  oraclePrice: string;
  nextFundingRate: string;
}

interface DYDXMarketsResponse {
  markets: Record<string, DYDXMarket>;
}

export class DYDXClient extends BaseExchangeClient {
  readonly name = 'dydx';

  constructor() {
    super(BASE_URL);
  }

  async getOpenInterest(symbol: string): Promise<OpenInterest> {
    const exchangeSymbol = toExchangeSymbol(symbol);

    const res = await this.request<DYDXMarketsResponse>('GET', '/perpetualMarkets', {
      params: { ticker: exchangeSymbol },
    });

    const market = res.markets[exchangeSymbol];
    if (!market) throw new Error(`Market ${exchangeSymbol} not found on dYdX`);

    const oi = this.toNonNegative(market.openInterest, 'openInterest');
    const price = this.toNonNegative(market.oraclePrice, 'oraclePrice');

    return {
      exchange: this.name,
      symbol,
      openInterest: oi,
      openInterestValue: oi * price,
      timestamp: this.now(),
    };
  }

  async getFundingRate(symbol: string): Promise<FundingRate> {
    const exchangeSymbol = toExchangeSymbol(symbol);

    const res = await this.request<DYDXMarketsResponse>('GET', '/perpetualMarkets', {
      params: { ticker: exchangeSymbol },
    });

    const market = res.markets[exchangeSymbol];
    if (!market) throw new Error(`Market ${exchangeSymbol} not found on dYdX`);

    const fundingRate = this.toFiniteNumber(market.nextFundingRate, 'nextFundingRate');

    return {
      exchange: this.name,
      symbol,
      fundingRate,
      fundingTime: this.now() + 3_600_000,
      timestamp: this.now(),
    };
  }

  async getMarkPrice(symbol: string): Promise<MarkPrice> {
    const exchangeSymbol = toExchangeSymbol(symbol);

    const res = await this.request<DYDXMarketsResponse>('GET', '/perpetualMarkets', {
      params: { ticker: exchangeSymbol },
    });

    const market = res.markets[exchangeSymbol];
    if (!market) throw new Error(`Market ${exchangeSymbol} not found on dYdX`);

    const oraclePrice = this.toNonNegative(market.oraclePrice, 'oraclePrice');

    return {
      exchange: this.name,
      symbol,
      markPrice: oraclePrice,
      indexPrice: oraclePrice, // dYdX uses oracle as index
      timestamp: this.now(),
    };
  }

  /** dYdX supports fetching all markets in one call — override for efficiency. */
  async getAllData(symbols: string[]): Promise<ExchangeData> {
    const res = await this.request<DYDXMarketsResponse>('GET', '/perpetualMarkets');
    const markets = res.markets;

    const openInterest: OpenInterest[] = [];
    const fundingRates: FundingRate[] = [];
    const markPrices: MarkPrice[] = [];

    for (const symbol of symbols) {
      const exchangeSymbol = toExchangeSymbol(symbol);
      const market = markets[exchangeSymbol];
      if (!market) continue;

      try {
        const oi = this.toNonNegative(market.openInterest, 'openInterest');
        const price = this.toNonNegative(market.oraclePrice, 'oraclePrice');
        const funding = this.toFiniteNumber(market.nextFundingRate, 'nextFundingRate');
        const ts = this.now();

        openInterest.push({
          exchange: this.name, symbol,
          openInterest: oi, openInterestValue: oi * price, timestamp: ts,
        });
        fundingRates.push({
          exchange: this.name, symbol,
          fundingRate: funding, fundingTime: ts + 3_600_000, timestamp: ts,
        });
        markPrices.push({
          exchange: this.name, symbol,
          markPrice: price, indexPrice: price, timestamp: ts,
        });
      } catch {
        this.logger.warn({ symbol }, 'Skipping symbol due to validation failure');
      }
    }

    return { exchange: this.name, openInterest, fundingRates, markPrices, timestamp: this.now() };
  }
}
