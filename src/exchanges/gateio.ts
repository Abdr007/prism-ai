import axios from 'axios';
import type { ExchangeClient, OpenInterest, FundingRate, MarkPrice, ExchangeData } from './types.js';

const BASE_URL = 'https://api.gateio.ws/api/v4';

// Gate.io uses format: BTC_USDT
function toExchangeSymbol(symbol: string): string {
  return `${symbol}_USDT`;
}

export class GateIOClient implements ExchangeClient {
  name = 'gateio';

  async getOpenInterest(symbol: string): Promise<OpenInterest> {
    const exchangeSymbol = toExchangeSymbol(symbol);

    try {
      const response = await axios.get(`${BASE_URL}/futures/usdt/contracts/${exchangeSymbol}`);
      const data = response.data;

      // Gate.io returns position_size as number of contracts
      // quanto_multiplier converts contracts to base currency units
      // For USDT-settled contracts, we multiply by quanto_multiplier then by price
      const positionSize = parseFloat(data.position_size || '0');
      const quantoMultiplier = parseFloat(data.quanto_multiplier || '1');
      const price = parseFloat(data.last_price || '0');

      // Convert contracts to actual position value
      // positionSize * quantoMultiplier = base currency amount (e.g., BTC)
      // base currency amount * price = USD value
      const actualOI = positionSize * quantoMultiplier;
      const oiValue = actualOI * price;

      return {
        exchange: this.name,
        symbol,
        openInterest: actualOI,
        openInterestValue: oiValue,
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
      const response = await axios.get(`${BASE_URL}/futures/usdt/contracts/${exchangeSymbol}`);
      const data = response.data;

      return {
        exchange: this.name,
        symbol,
        fundingRate: parseFloat(data.funding_rate || '0'),
        fundingTime: (data.funding_next_apply || 0) * 1000,
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
      const response = await axios.get(`${BASE_URL}/futures/usdt/contracts/${exchangeSymbol}`);
      const data = response.data;

      return {
        exchange: this.name,
        symbol,
        markPrice: parseFloat(data.mark_price || '0'),
        indexPrice: parseFloat(data.index_price || '0'),
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
