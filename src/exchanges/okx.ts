import axios from 'axios';
import type { ExchangeClient, OpenInterest, FundingRate, MarkPrice, ExchangeData } from './types.js';

const BASE_URL = 'https://www.okx.com';

// OKX uses: BTC-USDT-SWAP, ETH-USDT-SWAP for perpetual swaps
function toExchangeSymbol(symbol: string): string {
  return `${symbol}-USDT-SWAP`;
}

export class OKXClient implements ExchangeClient {
  name = 'okx';

  async getOpenInterest(symbol: string): Promise<OpenInterest> {
    const exchangeSymbol = toExchangeSymbol(symbol);

    const [oiResponse, tickerResponse] = await Promise.all([
      axios.get(`${BASE_URL}/api/v5/public/open-interest`, {
        params: { instType: 'SWAP', instId: exchangeSymbol }
      }),
      axios.get(`${BASE_URL}/api/v5/market/ticker`, {
        params: { instId: exchangeSymbol }
      })
    ]);

    const oiData = oiResponse.data.data[0];
    const tickerData = tickerResponse.data.data[0];
    const oi = parseFloat(oiData.oi);
    const price = parseFloat(tickerData.last);

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
    const response = await axios.get(`${BASE_URL}/api/v5/public/funding-rate`, {
      params: { instId: exchangeSymbol }
    });

    const data = response.data.data[0];

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
    const response = await axios.get(`${BASE_URL}/api/v5/public/mark-price`, {
      params: { instType: 'SWAP', instId: exchangeSymbol }
    });

    const data = response.data.data[0];

    // OKX doesn't provide index price in mark-price endpoint, fetch separately
    const indexResponse = await axios.get(`${BASE_URL}/api/v5/market/index-tickers`, {
      params: { instId: `${symbol}-USDT` }
    });
    const indexData = indexResponse.data.data[0];

    return {
      exchange: this.name,
      symbol,
      markPrice: parseFloat(data.markPx),
      indexPrice: parseFloat(indexData.idxPx),
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
