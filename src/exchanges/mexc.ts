import axios from 'axios';
import type { ExchangeClient, OpenInterest, FundingRate, MarkPrice, ExchangeData } from './types.js';

const BASE_URL = 'https://contract.mexc.com';

// MEXC uses format: BTC_USDT
function toExchangeSymbol(symbol: string): string {
  return `${symbol}_USDT`;
}

export class MEXCClient implements ExchangeClient {
  name = 'mexc';

  async getOpenInterest(symbol: string): Promise<OpenInterest> {
    const exchangeSymbol = toExchangeSymbol(symbol);

    try {
      const response = await axios.get(`${BASE_URL}/api/v1/contract/open_interest/${exchangeSymbol}`);
      const data = response.data.data;

      const oi = parseFloat(data?.value || '0');

      // Get price
      const tickerRes = await axios.get(`${BASE_URL}/api/v1/contract/ticker`, {
        params: { symbol: exchangeSymbol }
      });
      const price = parseFloat(tickerRes.data.data?.lastPrice || '0');

      return {
        exchange: this.name,
        symbol,
        openInterest: oi / price, // MEXC returns value, convert to quantity
        openInterestValue: oi,
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
      const response = await axios.get(`${BASE_URL}/api/v1/contract/funding_rate/${exchangeSymbol}`);
      const data = response.data.data;

      return {
        exchange: this.name,
        symbol,
        fundingRate: parseFloat(data?.fundingRate || '0'),
        fundingTime: data?.nextSettleTime || Date.now(),
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
      const response = await axios.get(`${BASE_URL}/api/v1/contract/index_price/${exchangeSymbol}`);
      const data = response.data.data;

      const price = parseFloat(data?.indexPrice || '0');

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
