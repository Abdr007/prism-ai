import axios from 'axios';
import type { ExchangeClient, OpenInterest, FundingRate, MarkPrice, ExchangeData } from './types.js';

// Hyperliquid API
const BASE_URL = 'https://api.hyperliquid.xyz';

// Hyperliquid uses simple symbols: BTC, ETH
function toExchangeSymbol(symbol: string): string {
  return symbol;
}

interface HyperliquidMeta {
  universe: Array<{
    name: string;
    szDecimals: number;
  }>;
}

interface HyperliquidAssetCtx {
  funding: string;
  openInterest: string;
  prevDayPx: string;
  dayNtlVlm: string;
  premium: string;
  oraclePx: string;
  markPx: string;
  midPx: string;
  impactPxs: [string, string];
}

export class HyperliquidClient implements ExchangeClient {
  name = 'hyperliquid';
  private metaCache: HyperliquidMeta | null = null;

  private async getMeta(): Promise<HyperliquidMeta> {
    if (this.metaCache) return this.metaCache;

    const response = await axios.post(`${BASE_URL}/info`, {
      type: 'meta'
    });

    this.metaCache = response.data as HyperliquidMeta;
    return this.metaCache;
  }

  private async getAssetCtxs(): Promise<HyperliquidAssetCtx[]> {
    const response = await axios.post(`${BASE_URL}/info`, {
      type: 'metaAndAssetCtxs'
    });

    return response.data[1] as HyperliquidAssetCtx[];
  }

  private async getSymbolIndex(symbol: string): Promise<number> {
    const meta = await this.getMeta();
    const index = meta.universe.findIndex(u => u.name === symbol);
    if (index === -1) {
      throw new Error(`Symbol ${symbol} not found on Hyperliquid`);
    }
    return index;
  }

  async getOpenInterest(symbol: string): Promise<OpenInterest> {
    const [meta, ctxs] = await Promise.all([
      this.getMeta(),
      this.getAssetCtxs()
    ]);

    const index = meta.universe.findIndex(u => u.name === symbol);
    if (index === -1) {
      throw new Error(`Symbol ${symbol} not found`);
    }

    const ctx = ctxs[index];
    if (!ctx) {
      throw new Error(`No context for ${symbol}`);
    }

    const oi = parseFloat(ctx.openInterest);
    const price = parseFloat(ctx.markPx);

    return {
      exchange: this.name,
      symbol,
      openInterest: oi,
      openInterestValue: oi * price,
      timestamp: Date.now(),
    };
  }

  async getFundingRate(symbol: string): Promise<FundingRate> {
    const [meta, ctxs] = await Promise.all([
      this.getMeta(),
      this.getAssetCtxs()
    ]);

    const index = meta.universe.findIndex(u => u.name === symbol);
    if (index === -1) {
      throw new Error(`Symbol ${symbol} not found`);
    }

    const ctx = ctxs[index];
    if (!ctx) {
      throw new Error(`No context for ${symbol}`);
    }

    // Hyperliquid funding is hourly, convert to 8h equivalent for comparison
    const hourlyFunding = parseFloat(ctx.funding);

    return {
      exchange: this.name,
      symbol,
      fundingRate: hourlyFunding * 8, // Convert to 8h rate
      fundingTime: Date.now() + 3600000, // Next hour
      timestamp: Date.now(),
    };
  }

  async getMarkPrice(symbol: string): Promise<MarkPrice> {
    const [meta, ctxs] = await Promise.all([
      this.getMeta(),
      this.getAssetCtxs()
    ]);

    const index = meta.universe.findIndex(u => u.name === symbol);
    if (index === -1) {
      throw new Error(`Symbol ${symbol} not found`);
    }

    const ctx = ctxs[index];
    if (!ctx) {
      throw new Error(`No context for ${symbol}`);
    }

    return {
      exchange: this.name,
      symbol,
      markPrice: parseFloat(ctx.markPx),
      indexPrice: parseFloat(ctx.oraclePx),
      timestamp: Date.now(),
    };
  }

  async getAllData(symbols: string[]): Promise<ExchangeData> {
    const [meta, ctxs] = await Promise.all([
      this.getMeta(),
      this.getAssetCtxs()
    ]);

    const openInterest: OpenInterest[] = [];
    const fundingRates: FundingRate[] = [];
    const markPrices: MarkPrice[] = [];

    for (const symbol of symbols) {
      const index = meta.universe.findIndex(u => u.name === symbol);
      if (index === -1) continue;

      const ctx = ctxs[index];
      if (!ctx) continue;

      const oi = parseFloat(ctx.openInterest);
      const markPrice = parseFloat(ctx.markPx);
      const oraclePrice = parseFloat(ctx.oraclePx);
      const hourlyFunding = parseFloat(ctx.funding);

      openInterest.push({
        exchange: this.name,
        symbol,
        openInterest: oi,
        openInterestValue: oi * markPrice,
        timestamp: Date.now(),
      });

      fundingRates.push({
        exchange: this.name,
        symbol,
        fundingRate: hourlyFunding * 8, // Convert to 8h
        fundingTime: Date.now() + 3600000,
        timestamp: Date.now(),
      });

      markPrices.push({
        exchange: this.name,
        symbol,
        markPrice,
        indexPrice: oraclePrice,
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
