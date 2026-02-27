import { BaseExchangeClient } from './base.js';
import type { OpenInterest, FundingRate, MarkPrice, ExchangeData } from './types.js';

const BASE_URL = 'https://contract.mexc.com';

function toExchangeSymbol(symbol: string): string {
  return `${symbol}_USDT`;
}

interface MEXCResponse<T> {
  data: T;
}

export class MEXCClient extends BaseExchangeClient {
  readonly name = 'mexc';

  constructor() {
    super(BASE_URL);
  }

  async getOpenInterest(symbol: string): Promise<OpenInterest> {
    const exchangeSymbol = toExchangeSymbol(symbol);

    const [oiRes, tickerRes] = await Promise.all([
      this.request<MEXCResponse<{ value: string }>>('GET', `/api/v1/contract/open_interest/${exchangeSymbol}`),
      this.request<MEXCResponse<{ lastPrice: string }>>('GET', '/api/v1/contract/ticker', {
        params: { symbol: exchangeSymbol },
      }),
    ]);

    const oiValue = this.toNonNegative(oiRes.data?.value, 'value');
    const price = this.toNonNegative(tickerRes.data?.lastPrice, 'lastPrice');

    return {
      exchange: this.name,
      symbol,
      openInterest: price > 0 ? oiValue / price : 0, // MEXC returns USD value
      openInterestValue: oiValue,
      timestamp: this.now(),
    };
  }

  async getFundingRate(symbol: string): Promise<FundingRate> {
    const exchangeSymbol = toExchangeSymbol(symbol);

    const res = await this.request<MEXCResponse<{
      fundingRate: string;
      nextSettleTime: number;
    }>>('GET', `/api/v1/contract/funding_rate/${exchangeSymbol}`);

    const fundingRate = this.toFiniteNumber(res.data?.fundingRate, 'fundingRate');

    return {
      exchange: this.name,
      symbol,
      fundingRate,
      fundingTime: res.data?.nextSettleTime || this.now(),
      timestamp: this.now(),
    };
  }

  async getMarkPrice(symbol: string): Promise<MarkPrice> {
    const exchangeSymbol = toExchangeSymbol(symbol);

    const res = await this.request<MEXCResponse<{ indexPrice: string }>>('GET', `/api/v1/contract/index_price/${exchangeSymbol}`);

    const price = this.toNonNegative(res.data?.indexPrice, 'indexPrice');

    return {
      exchange: this.name,
      symbol,
      markPrice: price,
      indexPrice: price,
      timestamp: this.now(),
    };
  }

  /**
   * Batch-optimized: 3 calls per symbol (dropped separate /ticker).
   * Uses index price for OI contract conversion instead of fetching /ticker separately.
   * Down from 4 calls/symbol to 3 calls/symbol.
   */
  async getAllData(symbols: string[]): Promise<ExchangeData> {
    const openInterest: OpenInterest[] = [];
    const fundingRates: FundingRate[] = [];
    const markPrices: MarkPrice[] = [];
    const now = this.now();

    const results = await Promise.all(
      symbols.map(async (symbol) => {
        const exchangeSymbol = toExchangeSymbol(symbol);
        try {
          const [oiRes, fundingRes, priceRes] = await Promise.all([
            this.request<MEXCResponse<{ value: string }>>('GET', `/api/v1/contract/open_interest/${exchangeSymbol}`),
            this.request<MEXCResponse<{ fundingRate: string; nextSettleTime: number }>>('GET', `/api/v1/contract/funding_rate/${exchangeSymbol}`),
            this.request<MEXCResponse<{ indexPrice: string }>>('GET', `/api/v1/contract/index_price/${exchangeSymbol}`),
          ]);
          return { symbol, oiRes, fundingRes, priceRes };
        } catch (err) {
          this.logger.warn({ symbol, err: (err as Error).message }, 'getAllData fetch failed');
          return null;
        }
      }),
    );

    for (const result of results) {
      if (!result) continue;
      const { symbol, oiRes, fundingRes, priceRes } = result;
      try {
        const oiValue = this.toNonNegative(oiRes.data?.value, 'value');
        const price = this.toNonNegative(priceRes.data?.indexPrice, 'indexPrice');
        const fundingRate = this.toFiniteNumber(fundingRes.data?.fundingRate, 'fundingRate');

        openInterest.push({
          exchange: this.name, symbol,
          openInterest: price > 0 ? oiValue / price : 0,
          openInterestValue: oiValue,
          timestamp: now,
        });
        fundingRates.push({
          exchange: this.name, symbol,
          fundingRate,
          fundingTime: fundingRes.data?.nextSettleTime || now,
          timestamp: now,
        });
        markPrices.push({
          exchange: this.name, symbol,
          markPrice: price,
          indexPrice: price,
          timestamp: now,
        });
      } catch (err) {
        this.logger.warn({ symbol, err: (err as Error).message }, 'getAllData parse failed');
      }
    }

    return { exchange: this.name, openInterest, fundingRates, markPrices, timestamp: now };
  }
}
