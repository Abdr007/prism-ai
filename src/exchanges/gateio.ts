import { BaseExchangeClient } from './base.js';
import type { OpenInterest, FundingRate, MarkPrice, ExchangeData } from './types.js';

const BASE_URL = 'https://api.gateio.ws/api/v4';

function toExchangeSymbol(symbol: string): string {
  return `${symbol}_USDT`;
}

interface GateContract {
  position_size: string;
  quanto_multiplier: string;
  last_price: string;
  funding_rate: string;
  funding_next_apply: number;
  mark_price: string;
  index_price: string;
}

export class GateIOClient extends BaseExchangeClient {
  readonly name = 'gateio';

  constructor() {
    super(BASE_URL);
  }

  /** Fetch the full contract info once — OI, funding, mark all come from it. */
  private async getContract(symbol: string): Promise<GateContract> {
    const exchangeSymbol = toExchangeSymbol(symbol);
    return this.request<GateContract>('GET', `/futures/usdt/contracts/${exchangeSymbol}`);
  }

  async getOpenInterest(symbol: string): Promise<OpenInterest> {
    const data = await this.getContract(symbol);

    const positionSize = this.toNonNegative(data.position_size, 'position_size');
    const quantoMultiplier = this.toFiniteNumber(data.quanto_multiplier, 'quanto_multiplier');
    const price = this.toNonNegative(data.last_price, 'last_price');

    const actualOI = positionSize * quantoMultiplier;

    return {
      exchange: this.name,
      symbol,
      openInterest: actualOI,
      openInterestValue: actualOI * price,
      timestamp: this.now(),
    };
  }

  async getFundingRate(symbol: string): Promise<FundingRate> {
    const data = await this.getContract(symbol);

    const fundingRate = this.toFiniteNumber(data.funding_rate, 'funding_rate');
    const fundingTime = this.toFiniteNumber(data.funding_next_apply, 'funding_next_apply') * 1000;

    return {
      exchange: this.name,
      symbol,
      fundingRate,
      fundingTime,
      timestamp: this.now(),
    };
  }

  async getMarkPrice(symbol: string): Promise<MarkPrice> {
    const data = await this.getContract(symbol);

    const markPrice = this.toNonNegative(data.mark_price, 'mark_price');
    const indexPrice = this.toNonNegative(data.index_price, 'index_price');

    this.assertPriceDeviation(markPrice, indexPrice, symbol);

    return {
      exchange: this.name,
      symbol,
      markPrice,
      indexPrice,
      timestamp: this.now(),
    };
  }

  /**
   * Batch-optimized: 1 contract call per symbol.
   * Single endpoint returns OI, funding, and mark/index price.
   * Down from 3 calls/symbol to 1 call/symbol.
   */
  async getAllData(symbols: string[]): Promise<ExchangeData> {
    const openInterest: OpenInterest[] = [];
    const fundingRates: FundingRate[] = [];
    const markPrices: MarkPrice[] = [];
    const now = this.now();

    const results = await Promise.all(
      symbols.map(async (symbol) => {
        try {
          const data = await this.getContract(symbol);
          return { symbol, data };
        } catch (err) {
          this.logger.warn({ symbol, err: (err as Error).message }, 'getAllData fetch failed');
          return null;
        }
      }),
    );

    for (const result of results) {
      if (!result) continue;
      const { symbol, data } = result;
      try {
        const positionSize = this.toNonNegative(data.position_size, 'position_size');
        const quantoMultiplier = this.toFiniteNumber(data.quanto_multiplier, 'quanto_multiplier');
        const price = this.toNonNegative(data.last_price, 'last_price');
        const actualOI = positionSize * quantoMultiplier;
        const fundingRate = this.toFiniteNumber(data.funding_rate, 'funding_rate');
        const fundingTime = this.toFiniteNumber(data.funding_next_apply, 'funding_next_apply') * 1000;
        const markPrice = this.toNonNegative(data.mark_price, 'mark_price');
        const indexPrice = this.toNonNegative(data.index_price, 'index_price');

        this.assertPriceDeviation(markPrice, indexPrice, symbol);

        openInterest.push({
          exchange: this.name, symbol,
          openInterest: actualOI,
          openInterestValue: actualOI * price,
          timestamp: now,
        });
        fundingRates.push({
          exchange: this.name, symbol,
          fundingRate,
          fundingTime,
          timestamp: now,
        });
        markPrices.push({
          exchange: this.name, symbol,
          markPrice,
          indexPrice,
          timestamp: now,
        });
      } catch (err) {
        this.logger.warn({ symbol, err: (err as Error).message }, 'getAllData parse failed');
      }
    }

    return { exchange: this.name, openInterest, fundingRates, markPrices, timestamp: now };
  }
}
