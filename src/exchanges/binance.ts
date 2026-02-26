import axios from 'axios';
import type { ExchangeClient, OpenInterest, FundingRate, MarkPrice, ExchangeData } from './types.js';

const BASE_URL = 'https://fapi.binance.com';

// Binance uses specific symbol format: BTCUSDT, ETHUSDT
function toExchangeSymbol(symbol: string): string {
  return `${symbol}USDT`;
}

export class BinanceClient implements ExchangeClient {
  name = 'binance';

  async getOpenInterest(symbol: string): Promise<OpenInterest> {
    const exchangeSymbol = toExchangeSymbol(symbol);

    try {
      const [oiResponse, priceResponse] = await Promise.all([
        axios.get(`${BASE_URL}/fapi/v1/openInterest`, {
          params: { symbol: exchangeSymbol },
          timeout: 10000,
        }),
        axios.get(`${BASE_URL}/fapi/v1/ticker/price`, {
          params: { symbol: exchangeSymbol },
          timeout: 10000,
        }),
      ]);

      const oi = parseFloat(oiResponse.data.openInterest) || 0;
      const price = parseFloat(priceResponse.data.price) || 0;

      // Sanity check: OI value should be reasonable (< $500B)
      const oiValue = oi * price;
      if (isNaN(oiValue) || oiValue > 500_000_000_000) {
        return { exchange: this.name, symbol, openInterest: 0, openInterestValue: 0, timestamp: Date.now() };
      }

      return {
        exchange: this.name,
        symbol,
        openInterest: oi,
        openInterestValue: oiValue,
        timestamp: Date.now(),
      };
    } catch {
      return { exchange: this.name, symbol, openInterest: 0, openInterestValue: 0, timestamp: Date.now() };
    }
  }

  async getFundingRate(symbol: string): Promise<FundingRate> {
    const exchangeSymbol = toExchangeSymbol(symbol);

    try {
      const response = await axios.get(`${BASE_URL}/fapi/v1/premiumIndex`, {
        params: { symbol: exchangeSymbol },
        timeout: 10000,
      });

      const fundingRate = parseFloat(response.data.lastFundingRate) || 0;

      // Sanity check: funding rate should be reasonable (< 1%)
      if (isNaN(fundingRate) || Math.abs(fundingRate) > 0.01) {
        return { exchange: this.name, symbol, fundingRate: 0, fundingTime: Date.now(), timestamp: Date.now() };
      }

      return {
        exchange: this.name,
        symbol,
        fundingRate,
        fundingTime: response.data.nextFundingTime || Date.now(),
        timestamp: Date.now(),
      };
    } catch {
      return { exchange: this.name, symbol, fundingRate: 0, fundingTime: Date.now(), timestamp: Date.now() };
    }
  }

  async getMarkPrice(symbol: string): Promise<MarkPrice> {
    const exchangeSymbol = toExchangeSymbol(symbol);

    try {
      const response = await axios.get(`${BASE_URL}/fapi/v1/premiumIndex`, {
        params: { symbol: exchangeSymbol },
        timeout: 10000,
      });

      const markPrice = parseFloat(response.data.markPrice) || 0;
      const indexPrice = parseFloat(response.data.indexPrice) || 0;

      // Sanity check: prices should be positive
      if (isNaN(markPrice) || markPrice <= 0) {
        return { exchange: this.name, symbol, markPrice: 0, indexPrice: 0, timestamp: Date.now() };
      }

      return {
        exchange: this.name,
        symbol,
        markPrice,
        indexPrice: indexPrice || markPrice,
        timestamp: Date.now(),
      };
    } catch {
      return { exchange: this.name, symbol, markPrice: 0, indexPrice: 0, timestamp: Date.now() };
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
