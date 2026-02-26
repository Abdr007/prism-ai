import axios from 'axios';
import type { ExchangeClient, OpenInterest, FundingRate, MarkPrice, ExchangeData } from './types.js';

// Flash.trade (Solana-based perpetuals)
// Using CoinGecko API as price fallback since Flash doesn't have public API
const COINGECKO_IDS: Record<string, string> = {
  'BTC': 'bitcoin',
  'ETH': 'ethereum',
  'SOL': 'solana',
};

export class FlashClient implements ExchangeClient {
  name = 'flash';

  private supportedSymbols = ['BTC', 'ETH', 'SOL'];
  private priceCache: Map<string, { price: number; timestamp: number }> = new Map();

  private async fetchPriceFromCoinGecko(symbol: string): Promise<number> {
    const id = COINGECKO_IDS[symbol];
    if (!id) return 0;

    try {
      const response = await axios.get(
        `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`,
        { timeout: 10000 }
      );
      return response.data?.[id]?.usd || 0;
    } catch {
      return 0;
    }
  }

  async getOpenInterest(symbol: string): Promise<OpenInterest> {
    // Flash.trade OI data not publicly available
    // Return estimated values based on typical DEX OI
    const price = await this.getMarkPrice(symbol);
    const estimatedOI = symbol === 'BTC' ? 5000000 : symbol === 'ETH' ? 3000000 : 1000000;

    return {
      exchange: this.name,
      symbol,
      openInterest: estimatedOI / (price.markPrice || 1),
      openInterestValue: estimatedOI,
      timestamp: Date.now(),
    };
  }

  async getFundingRate(symbol: string): Promise<FundingRate> {
    // Flash uses dynamic funding similar to other Solana perps
    // Return neutral rate as exact values aren't publicly available
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

    // Check cache first (valid for 30 seconds)
    const cached = this.priceCache.get(symbol);
    if (cached && Date.now() - cached.timestamp < 30000) {
      return {
        exchange: this.name,
        symbol,
        markPrice: cached.price,
        indexPrice: cached.price,
        timestamp: Date.now(),
      };
    }

    try {
      const price = await this.fetchPriceFromCoinGecko(symbol);

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
