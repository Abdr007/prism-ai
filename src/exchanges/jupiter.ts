import axios from 'axios';
import type { ExchangeClient, OpenInterest, FundingRate, MarkPrice, ExchangeData } from './types.js';

// Jupiter Perpetuals API
const BASE_URL = 'https://perps-api.jup.ag';

// Jupiter mint addresses for each symbol
const MINT_ADDRESSES: Record<string, string> = {
  'SOL': 'So11111111111111111111111111111111111111112',
  'ETH': '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
  'BTC': '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
};

export class JupiterClient implements ExchangeClient {
  name = 'jupiter';

  private supportedSymbols = ['BTC', 'ETH', 'SOL'];
  private priceCache: Map<string, { price: number; timestamp: number }> = new Map();

  private async getMarketStats(symbol: string): Promise<{
    price: number;
    volume: number;
    priceChange24H: number;
  } | null> {
    const mint = MINT_ADDRESSES[symbol];
    if (!mint) return null;

    try {
      const response = await axios.get(`${BASE_URL}/v1/market-stats`, {
        params: { mint },
        timeout: 10000,
      });

      const data = response.data;
      return {
        price: parseFloat(data.price || '0'),
        volume: parseFloat(data.volume || '0'),
        priceChange24H: parseFloat(data.priceChange24H || '0'),
      };
    } catch {
      return null;
    }
  }

  async getOpenInterest(symbol: string): Promise<OpenInterest> {
    if (!this.supportedSymbols.includes(symbol)) {
      return {
        exchange: this.name,
        symbol,
        openInterest: 0,
        openInterestValue: 0,
        timestamp: Date.now(),
      };
    }

    try {
      const stats = await this.getMarketStats(symbol);
      // Jupiter doesn't provide OI directly, estimate from volume
      const estimatedOI = stats ? stats.volume * 0.1 : 0; // Rough estimate

      return {
        exchange: this.name,
        symbol,
        openInterest: estimatedOI / (stats?.price || 1),
        openInterestValue: estimatedOI,
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
    if (!this.supportedSymbols.includes(symbol)) {
      return {
        exchange: this.name,
        symbol,
        fundingRate: 0,
        fundingTime: Date.now(),
        timestamp: Date.now(),
      };
    }

    // Jupiter uses dynamic funding based on pool utilization
    // Typically ranges from -0.01% to +0.01% per hour
    // We'll return a neutral rate since exact funding isn't exposed
    return {
      exchange: this.name,
      symbol,
      fundingRate: 0,
      fundingTime: Date.now() + 60 * 60 * 1000,
      timestamp: Date.now(),
    };
  }

  async getMarkPrice(symbol: string): Promise<MarkPrice> {
    if (!this.supportedSymbols.includes(symbol)) {
      return {
        exchange: this.name,
        symbol,
        markPrice: 0,
        indexPrice: 0,
        timestamp: Date.now(),
      };
    }

    try {
      const stats = await this.getMarketStats(symbol);
      const price = stats?.price || 0;

      // Cache the price
      if (price > 0) {
        this.priceCache.set(symbol, { price, timestamp: Date.now() });
      }

      return {
        exchange: this.name,
        symbol,
        markPrice: price,
        indexPrice: price,
        timestamp: Date.now(),
      };
    } catch {
      // Return cached price if available
      const cached = this.priceCache.get(symbol);
      return {
        exchange: this.name,
        symbol,
        markPrice: cached?.price || 0,
        indexPrice: cached?.price || 0,
        timestamp: Date.now(),
      };
    }
  }

  async getAllData(symbols: string[]): Promise<ExchangeData> {
    // Filter to only supported symbols
    const supportedSymbols = symbols.filter(s => this.supportedSymbols.includes(s));

    const [openInterest, fundingRates, markPrices] = await Promise.all([
      Promise.all(supportedSymbols.map(s => this.getOpenInterest(s))),
      Promise.all(supportedSymbols.map(s => this.getFundingRate(s))),
      Promise.all(supportedSymbols.map(s => this.getMarkPrice(s))),
    ]);

    // Add empty results for unsupported symbols
    const unsupportedSymbols = symbols.filter(s => !this.supportedSymbols.includes(s));
    for (const symbol of unsupportedSymbols) {
      openInterest.push({
        exchange: this.name,
        symbol,
        openInterest: 0,
        openInterestValue: 0,
        timestamp: Date.now(),
      });
      fundingRates.push({
        exchange: this.name,
        symbol,
        fundingRate: 0,
        fundingTime: Date.now(),
        timestamp: Date.now(),
      });
      markPrices.push({
        exchange: this.name,
        symbol,
        markPrice: 0,
        indexPrice: 0,
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
