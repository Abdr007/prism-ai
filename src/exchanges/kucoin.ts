import axios from 'axios';
import type { ExchangeClient, OpenInterest, FundingRate, MarkPrice, ExchangeData } from './types.js';

const BASE_URL = 'https://api-futures.kucoin.com';

// KuCoin uses format: XBTUSDTM for BTC, ETHUSDTM for others
function toExchangeSymbol(symbol: string): string {
  if (symbol === 'BTC') return 'XBTUSDTM';
  return `${symbol}USDTM`;
}

export class KuCoinClient implements ExchangeClient {
  name = 'kucoin';

  async getOpenInterest(symbol: string): Promise<OpenInterest> {
    const exchangeSymbol = toExchangeSymbol(symbol);

    try {
      const response = await axios.get(`${BASE_URL}/api/v1/openInterest`, {
        params: { symbol: exchangeSymbol }
      });

      const data = response.data.data;
      const oi = parseFloat(data?.openInterest || '0');

      // Get price
      const tickerRes = await axios.get(`${BASE_URL}/api/v1/ticker`, {
        params: { symbol: exchangeSymbol }
      });
      const price = parseFloat(tickerRes.data.data?.price || '0');

      return {
        exchange: this.name,
        symbol,
        openInterest: oi,
        openInterestValue: oi * price,
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
    const exchangeSymbol = toExchangeSymbol(symbol);

    try {
      const response = await axios.get(`${BASE_URL}/api/v1/funding-rate/${exchangeSymbol}/current`);
      const data = response.data.data;

      return {
        exchange: this.name,
        symbol,
        fundingRate: parseFloat(data?.value || '0'),
        fundingTime: data?.timePoint || Date.now(),
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
    const exchangeSymbol = toExchangeSymbol(symbol);

    try {
      const response = await axios.get(`${BASE_URL}/api/v1/mark-price/${exchangeSymbol}/current`);
      const data = response.data.data;

      return {
        exchange: this.name,
        symbol,
        markPrice: parseFloat(data?.value || '0'),
        indexPrice: parseFloat(data?.indexPrice || '0'),
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
