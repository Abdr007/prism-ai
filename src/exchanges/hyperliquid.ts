import { BaseExchangeClient } from './base.js';
import type { OpenInterest, FundingRate, MarkPrice, ExchangeData } from './types.js';

const BASE_URL = 'https://api.hyperliquid.xyz';

interface HyperliquidMeta {
  universe: Array<{ name: string; szDecimals: number }>;
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

export class HyperliquidClient extends BaseExchangeClient {
  readonly name = 'hyperliquid';
  private metaCache: HyperliquidMeta | null = null;

  constructor() {
    super(BASE_URL);
  }

  private async getMeta(): Promise<HyperliquidMeta> {
    if (this.metaCache) return this.metaCache;
    const res = await this.request<HyperliquidMeta>('POST', '/info', { data: { type: 'meta' } });
    this.metaCache = res;
    return res;
  }

  private async getAssetCtxs(): Promise<[HyperliquidMeta, HyperliquidAssetCtx[]]> {
    const res = await this.request<[HyperliquidMeta, HyperliquidAssetCtx[]]>('POST', '/info', {
      data: { type: 'metaAndAssetCtxs' },
    });
    this.metaCache = res[0];
    return res;
  }

  private findIndex(meta: HyperliquidMeta, symbol: string): number {
    const idx = meta.universe.findIndex((u) => u.name === symbol);
    if (idx === -1) throw new Error(`Symbol ${symbol} not found on Hyperliquid`);
    return idx;
  }

  async getOpenInterest(symbol: string): Promise<OpenInterest> {
    const [meta, ctxs] = await this.getAssetCtxs();
    const idx = this.findIndex(meta, symbol);
    const ctx = ctxs[idx];
    if (!ctx) throw new Error(`No context for ${symbol}`);

    const oi = this.toNonNegative(ctx.openInterest, 'openInterest');
    const price = this.toNonNegative(ctx.markPx, 'markPx');

    return {
      exchange: this.name,
      symbol,
      openInterest: oi,
      openInterestValue: oi * price,
      timestamp: this.now(),
    };
  }

  async getFundingRate(symbol: string): Promise<FundingRate> {
    const [meta, ctxs] = await this.getAssetCtxs();
    const idx = this.findIndex(meta, symbol);
    const ctx = ctxs[idx];
    if (!ctx) throw new Error(`No context for ${symbol}`);

    // Hyperliquid funding is hourly — convert to 8h equivalent
    const hourlyFunding = this.toFiniteNumber(ctx.funding, 'funding');

    return {
      exchange: this.name,
      symbol,
      fundingRate: hourlyFunding * 8,
      fundingTime: this.now() + 3_600_000,
      timestamp: this.now(),
    };
  }

  async getMarkPrice(symbol: string): Promise<MarkPrice> {
    const [meta, ctxs] = await this.getAssetCtxs();
    const idx = this.findIndex(meta, symbol);
    const ctx = ctxs[idx];
    if (!ctx) throw new Error(`No context for ${symbol}`);

    const markPrice = this.toNonNegative(ctx.markPx, 'markPx');
    const indexPrice = this.toNonNegative(ctx.oraclePx, 'oraclePx');

    this.assertPriceDeviation(markPrice, indexPrice, symbol);

    return {
      exchange: this.name,
      symbol,
      markPrice,
      indexPrice,
      timestamp: this.now(),
    };
  }

  /** Batch: single API call for all symbols. */
  async getAllData(symbols: string[]): Promise<ExchangeData> {
    const [meta, ctxs] = await this.getAssetCtxs();

    const openInterest: OpenInterest[] = [];
    const fundingRates: FundingRate[] = [];
    const markPrices: MarkPrice[] = [];

    for (const symbol of symbols) {
      const idx = meta.universe.findIndex((u) => u.name === symbol);
      if (idx === -1) continue;
      const ctx = ctxs[idx];
      if (!ctx) continue;

      try {
        const oi = this.toNonNegative(ctx.openInterest, 'openInterest');
        const mark = this.toNonNegative(ctx.markPx, 'markPx');
        const oracle = this.toNonNegative(ctx.oraclePx, 'oraclePx');
        const hourlyFunding = this.toFiniteNumber(ctx.funding, 'funding');

        this.assertPriceDeviation(mark, oracle, symbol);

        const ts = this.now();

        openInterest.push({
          exchange: this.name, symbol,
          openInterest: oi, openInterestValue: oi * mark, timestamp: ts,
        });
        fundingRates.push({
          exchange: this.name, symbol,
          fundingRate: hourlyFunding * 8, fundingTime: ts + 3_600_000, timestamp: ts,
        });
        markPrices.push({
          exchange: this.name, symbol,
          markPrice: mark, indexPrice: oracle, timestamp: ts,
        });
      } catch {
        this.logger.warn({ symbol }, 'Skipping symbol due to validation failure');
      }
    }

    return { exchange: this.name, openInterest, fundingRates, markPrices, timestamp: this.now() };
  }
}
