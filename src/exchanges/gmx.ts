import axios from 'axios';
import type { ExchangeClient, OpenInterest, FundingRate, MarkPrice, ExchangeData } from './types.js';

// GMX V2 API on Arbitrum
const BASE_URL = 'https://arbitrum-api.gmxinfra.io';

// GMX market tokens mapping
const MARKET_TOKENS: Record<string, string> = {
  'BTC': '0x47c031236e19d024b42f8AE6780E44A573170703',
  'ETH': '0x70d95587d40A2caf56bd97485aB3Eec10Bee6336',
  'SOL': '0x09400D9DB990D5ed3f35D7be61DfAEB900Af03C9',
  'LINK': '0x7f1fa204bb700853D36994DA19F830b6Ad18455C',
  'ARB': '0xC25cEf6061Cf5dE5eb761b50E4743c1F5D7E5407',
  'DOGE': '0x6853EA96FF216fAb11D2d930CE3C508556A4bdc4',
  'XRP': '0x0CCB4fAa6f1F1B30911619f1184082aB4E25813c',
};

export class GMXClient implements ExchangeClient {
  name = 'gmx';

  async getOpenInterest(symbol: string): Promise<OpenInterest> {
    try {
      const response = await axios.get(`${BASE_URL}/markets`);
      const markets = response.data.markets || [];

      const marketToken = MARKET_TOKENS[symbol];
      const market = markets.find((m: { marketToken: string }) => m.marketToken === marketToken);

      if (!market) {
        return {
          exchange: this.name,
          symbol,
          openInterest: 0,
          openInterestValue: 0,
          timestamp: Date.now(),
        };
      }

      const longOI = parseFloat(market.longInterestUsd || '0') / 1e30;
      const shortOI = parseFloat(market.shortInterestUsd || '0') / 1e30;
      const totalOI = longOI + shortOI;
      const price = parseFloat(market.indexTokenPrice?.max || '0') / 1e30;

      return {
        exchange: this.name,
        symbol,
        openInterest: price > 0 ? totalOI / price : 0,
        openInterestValue: totalOI,
        timestamp: Date.now(),
      };
    } catch {
      return {
        exchange: this.name,
        symbol,
        openInterest: 0,
        openInterestValue: 0,
        timestamp: Date.now(),
      };
    }
  }

  async getFundingRate(symbol: string): Promise<FundingRate> {
    try {
      const response = await axios.get(`${BASE_URL}/markets`);
      const markets = response.data.markets || [];

      const marketToken = MARKET_TOKENS[symbol];
      const market = markets.find((m: { marketToken: string }) => m.marketToken === marketToken);

      // GMX V2 uses borrowing fees instead of traditional funding
      const borrowingFactorLong = parseFloat(market?.borrowingFactorPerSecondForLongs || '0');
      const borrowingFactorShort = parseFloat(market?.borrowingFactorPerSecondForShorts || '0');

      // Convert to approximate 8h funding rate equivalent
      const avgBorrowing = (borrowingFactorLong + borrowingFactorShort) / 2;
      const fundingRate = avgBorrowing * 8 * 3600;

      return {
        exchange: this.name,
        symbol,
        fundingRate,
        fundingTime: Date.now() + 8 * 60 * 60 * 1000,
        timestamp: Date.now(),
      };
    } catch {
      return {
        exchange: this.name,
        symbol,
        fundingRate: 0,
        fundingTime: Date.now(),
        timestamp: Date.now(),
      };
    }
  }

  async getMarkPrice(symbol: string): Promise<MarkPrice> {
    try {
      const response = await axios.get(`${BASE_URL}/prices/tickers`);
      const prices = response.data || {};

      // Find price for symbol
      const priceKey = Object.keys(prices).find(k => k.includes(symbol));
      const price = priceKey ? parseFloat(prices[priceKey]?.maxPrice || '0') / 1e30 : 0;

      return {
        exchange: this.name,
        symbol,
        markPrice: price,
        indexPrice: price,
        timestamp: Date.now(),
      };
    } catch {
      return {
        exchange: this.name,
        symbol,
        markPrice: 0,
        indexPrice: 0,
        timestamp: Date.now(),
      };
    }
  }

  async getAllData(symbols: string[]): Promise<ExchangeData> {
    const [openInterest, fundingRates, markPrices] = await Promise.all([
      Promise.all(symbols.map(s => this.getOpenInterest(s))),
      Promise.all(symbols.map(s => this.getFundingRate(s))),
      Promise.all(symbols.map(s => this.getMarkPrice(s))),
    ]);

    return {
      exchange: this.name,
      openInterest,
      fundingRates,
      markPrices,
      timestamp: Date.now(),
    };
  }
}
