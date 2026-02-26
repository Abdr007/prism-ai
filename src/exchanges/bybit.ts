import axios from 'axios';
import type { ExchangeClient, OpenInterest, FundingRate, MarkPrice, ExchangeData } from './types.js';

const BASE_URL = 'https://api.bybit.com';

// Bybit uses: BTCUSDT, ETHUSDT for linear perpetuals
function toExchangeSymbol(symbol: string): string {
  return `${symbol}USDT`;
}

export class BybitClient implements ExchangeClient {
  name = 'bybit';

  async getOpenInterest(symbol: string): Promise<OpenInterest> {
    const exchangeSymbol = toExchangeSymbol(symbol);

    const [oiResponse, tickerResponse] = await Promise.all([
      axios.get(`${BASE_URL}/v5/market/open-interest`, {
        params: { category: 'linear', symbol: exchangeSymbol, intervalTime: '5min', limit: 1 }
      }),
      axios.get(`${BASE_URL}/v5/market/tickers`, {
        params: { category: 'linear', symbol: exchangeSymbol }
      })
    ]);

    const oiData = oiResponse.data.result.list[0];
    const tickerData = tickerResponse.data.result.list[0];
    const oi = parseFloat(oiData.openInterest);
    const price = parseFloat(tickerData.lastPrice);

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
    const response = await axios.get(`${BASE_URL}/v5/market/tickers`, {
      params: { category: 'linear', symbol: exchangeSymbol }
    });

    const data = response.data.result.list[0];

    return {
      exchange: this.name,
      symbol,
      fundingRate: parseFloat(data.fundingRate),
      fundingTime: parseInt(data.nextFundingTime),
      timestamp: Date.now(),
    };
  }

  async getMarkPrice(symbol: string): Promise<MarkPrice> {
    const exchangeSymbol = toExchangeSymbol(symbol);
    const response = await axios.get(`${BASE_URL}/v5/market/tickers`, {
      params: { category: 'linear', symbol: exchangeSymbol }
    });

    const data = response.data.result.list[0];

    return {
      exchange: this.name,
      symbol,
      markPrice: parseFloat(data.markPrice),
      indexPrice: parseFloat(data.indexPrice),
      timestamp: Date.now(),
    };
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
