import axios from 'axios';
import type { ExchangeClient, OpenInterest, FundingRate, MarkPrice, ExchangeData } from './types.js';

const BASE_URL = 'https://api.bitget.com';

// Bitget uses format: BTCUSDT_UMCBL for USDT-M futures
function toExchangeSymbol(symbol: string): string {
  return `${symbol}USDT_UMCBL`;
}

export class BitgetClient implements ExchangeClient {
  name = 'bitget';

  async getOpenInterest(symbol: string): Promise<OpenInterest> {
    const exchangeSymbol = toExchangeSymbol(symbol);

    try {
      const response = await axios.get(`${BASE_URL}/api/mix/v1/market/open-interest`, {
        params: { symbol: exchangeSymbol }
      });

      const data = response.data.data;
      const oi = parseFloat(data.amount || '0');

      // Get price for value calculation
      const tickerRes = await axios.get(`${BASE_URL}/api/mix/v1/market/ticker`, {
        params: { symbol: exchangeSymbol }
      });
      const price = parseFloat(tickerRes.data.data?.last || '0');

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
      const response = await axios.get(`${BASE_URL}/api/mix/v1/market/current-fundRate`, {
        params: { symbol: exchangeSymbol }
      });

      return {
        exchange: this.name,
        symbol,
        fundingRate: parseFloat(response.data.data?.fundingRate || '0'),
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
    const exchangeSymbol = toExchangeSymbol(symbol);

    try {
      const response = await axios.get(`${BASE_URL}/api/mix/v1/market/mark-price`, {
        params: { symbol: exchangeSymbol }
      });

      const markPrice = parseFloat(response.data.data?.markPrice || '0');

      return {
        exchange: this.name,
        symbol,
        markPrice,
        indexPrice: markPrice,
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
