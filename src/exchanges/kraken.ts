import axios from 'axios';
import type { ExchangeClient, OpenInterest, FundingRate, MarkPrice, ExchangeData } from './types.js';

const BASE_URL = 'https://futures.kraken.com/derivatives/api/v3';

// Kraken uses format: PF_XBTUSD for BTC perpetual
function toExchangeSymbol(symbol: string): string {
  if (symbol === 'BTC') return 'PF_XBTUSD';
  return `PF_${symbol}USD`;
}

export class KrakenClient implements ExchangeClient {
  name = 'kraken';

  async getOpenInterest(symbol: string): Promise<OpenInterest> {
    const exchangeSymbol = toExchangeSymbol(symbol);

    try {
      const response = await axios.get(`${BASE_URL}/tickers`);
      const tickers = response.data.tickers || [];
      const ticker = tickers.find((t: { symbol: string }) => t.symbol === exchangeSymbol);

      if (!ticker) {
        throw new Error('Symbol not found');
      }

      const oi = parseFloat(ticker.openInterest || '0');
      const price = parseFloat(ticker.markPrice || '0');

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
      const response = await axios.get(`${BASE_URL}/tickers`);
      const tickers = response.data.tickers || [];
      const ticker = tickers.find((t: { symbol: string }) => t.symbol === exchangeSymbol);

      // Kraken returns fundingRate as a decimal (e.g., 0.0001 for 0.01%)
      // Kraken uses 4h funding periods, so we normalize to 8h by multiplying by 2
      let fundingRate = parseFloat(ticker?.fundingRate || '0');

      // Sanity check: if the value seems too high (> 1% = 0.01), it's likely wrong
      if (isNaN(fundingRate)) {
        fundingRate = 0;
      } else if (Math.abs(fundingRate) > 0.01) {
        // Likely a percentage representation, convert to decimal
        fundingRate = fundingRate / 100;
      }

      // Normalize 4h rate to 8h rate (multiply by 2)
      fundingRate = fundingRate * 2;

      // Use fundingRatePrediction if available and seems more reasonable
      const predictedRate = parseFloat(ticker?.fundingRatePrediction || '0');
      if (!isNaN(predictedRate) && predictedRate !== 0 && Math.abs(predictedRate * 2) < Math.abs(fundingRate)) {
        fundingRate = predictedRate * 2; // Also normalize prediction to 8h
      }

      // Final sanity check
      if (Math.abs(fundingRate) > 0.01) {
        fundingRate = 0; // Discard unreasonable values
      }

      return {
        exchange: this.name,
        symbol,
        fundingRate,
        fundingTime: Date.now() + 4 * 60 * 60 * 1000, // Kraken uses 4h funding
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
      const response = await axios.get(`${BASE_URL}/tickers`);
      const tickers = response.data.tickers || [];
      const ticker = tickers.find((t: { symbol: string }) => t.symbol === exchangeSymbol);

      return {
        exchange: this.name,
        symbol,
        markPrice: parseFloat(ticker?.markPrice || '0'),
        indexPrice: parseFloat(ticker?.indexPrice || ticker?.markPrice || '0'),
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
