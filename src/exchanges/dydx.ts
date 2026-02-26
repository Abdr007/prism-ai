import axios from 'axios';
import type { ExchangeClient, OpenInterest, FundingRate, MarkPrice, ExchangeData } from './types.js';

// dYdX v4 Indexer API
const BASE_URL = 'https://indexer.dydx.trade/v4';

// dYdX uses: BTC-USD, ETH-USD format
function toExchangeSymbol(symbol: string): string {
  return `${symbol}-USD`;
}

export class DYDXClient implements ExchangeClient {
  name = 'dydx';

  async getOpenInterest(symbol: string): Promise<OpenInterest> {
    const exchangeSymbol = toExchangeSymbol(symbol);

    const response = await axios.get(`${BASE_URL}/perpetualMarkets`, {
      params: { ticker: exchangeSymbol }
    });

    const market = response.data.markets[exchangeSymbol];
    const oi = parseFloat(market.openInterest);
    const price = parseFloat(market.oraclePrice);

    return {
      exchange: this.name,
      symbol,
      openInterest: oi,
      openInterestValue: oi * price,
      timestamp: Date.now(),
    };
  }

  async getFundingRate(symbol: string): Promise<FundingRate> {
    const exchangeSymbol = toExchangeSymbol(symbol);

    const response = await axios.get(`${BASE_URL}/perpetualMarkets`, {
      params: { ticker: exchangeSymbol }
    });

    const market = response.data.markets[exchangeSymbol];

    return {
      exchange: this.name,
      symbol,
      fundingRate: parseFloat(market.nextFundingRate),
      fundingTime: Date.now() + 3600000, // Approximate next funding
      timestamp: Date.now(),
    };
  }

  async getMarkPrice(symbol: string): Promise<MarkPrice> {
    const exchangeSymbol = toExchangeSymbol(symbol);

    const response = await axios.get(`${BASE_URL}/perpetualMarkets`, {
      params: { ticker: exchangeSymbol }
    });

    const market = response.data.markets[exchangeSymbol];

    return {
      exchange: this.name,
      symbol,
      markPrice: parseFloat(market.oraclePrice),
      indexPrice: parseFloat(market.oraclePrice), // dYdX uses oracle as index
      timestamp: Date.now(),
    };
  }

  async getAllData(symbols: string[]): Promise<ExchangeData> {
    // dYdX allows fetching all markets at once
    const response = await axios.get(`${BASE_URL}/perpetualMarkets`);
    const markets = response.data.markets;

    const openInterest: OpenInterest[] = [];
    const fundingRates: FundingRate[] = [];
    const markPrices: MarkPrice[] = [];

    for (const symbol of symbols) {
      const exchangeSymbol = toExchangeSymbol(symbol);
      const market = markets[exchangeSymbol];

      if (!market) continue;

      const oi = parseFloat(market.openInterest);
      const price = parseFloat(market.oraclePrice);

      openInterest.push({
        exchange: this.name,
        symbol,
        openInterest: oi,
        openInterestValue: oi * price,
        timestamp: Date.now(),
      });

      fundingRates.push({
        exchange: this.name,
        symbol,
        fundingRate: parseFloat(market.nextFundingRate),
        fundingTime: Date.now() + 3600000,
        timestamp: Date.now(),
      });

      markPrices.push({
        exchange: this.name,
        symbol,
        markPrice: price,
        indexPrice: price,
        timestamp: Date.now(),
      });
    }

    return {
      exchange: this.name,
      openInterest,
      fundingRates,
      markPrices,
      timestamp: Date.now(),
    };
  }
}
