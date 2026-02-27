import { BaseExchangeClient } from './base.js';
import type { OpenInterest, FundingRate, MarkPrice, ExchangeData } from './types.js';

const BASE_URL = 'https://api.bitget.com';

function toExchangeSymbol(symbol: string): string {
  return `${symbol}USDT_UMCBL`;
}

interface BitgetResponse<T> {
  data: T;
}

export class BitgetClient extends BaseExchangeClient {
  readonly name = 'bitget';

  constructor() {
    super(BASE_URL);
  }

  async getOpenInterest(symbol: string): Promise<OpenInterest> {
    const exchangeSymbol = toExchangeSymbol(symbol);

    const [oiRes, tickerRes] = await Promise.all([
      this.request<BitgetResponse<{ amount: string }>>('GET', '/api/mix/v1/market/open-interest', {
        params: { symbol: exchangeSymbol },
      }),
      this.request<BitgetResponse<{ last: string }>>('GET', '/api/mix/v1/market/ticker', {
        params: { symbol: exchangeSymbol },
      }),
    ]);

    const oi = this.toNonNegative(oiRes.data?.amount, 'amount');
    const price = this.toNonNegative(tickerRes.data?.last, 'last');

    return {
      exchange: this.name,
      symbol,
      openInterest: oi,
      openInterestValue: oi * price,
      timestamp: this.now(),
    };
  }

  async getFundingRate(symbol: string): Promise<FundingRate> {
    const exchangeSymbol = toExchangeSymbol(symbol);

    const res = await this.request<BitgetResponse<{ fundingRate: string }>>('GET', '/api/mix/v1/market/current-fundRate', {
      params: { symbol: exchangeSymbol },
    });

    const fundingRate = this.toFiniteNumber(res.data?.fundingRate, 'fundingRate');

    return {
      exchange: this.name,
      symbol,
      fundingRate,
      fundingTime: this.now() + 8 * 3_600_000,
      timestamp: this.now(),
    };
  }

  async getMarkPrice(symbol: string): Promise<MarkPrice> {
    const exchangeSymbol = toExchangeSymbol(symbol);

    const res = await this.request<BitgetResponse<{ markPrice: string }>>('GET', '/api/mix/v1/market/mark-price', {
      params: { symbol: exchangeSymbol },
    });

    const markPrice = this.toNonNegative(res.data?.markPrice, 'markPrice');

    return {
      exchange: this.name,
      symbol,
      markPrice,
      indexPrice: markPrice, // Bitget mark-price endpoint doesn't return index
      timestamp: this.now(),
    };
  }

  /**
   * Batch-optimized: 3 calls per symbol (dropped separate /ticker).
   * Uses mark price for OI value instead of fetching /ticker separately.
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
          const [oiRes, fundingRes, markRes] = await Promise.all([
            this.request<BitgetResponse<{ amount: string }>>('GET', '/api/mix/v1/market/open-interest', {
              params: { symbol: exchangeSymbol },
            }),
            this.request<BitgetResponse<{ fundingRate: string }>>('GET', '/api/mix/v1/market/current-fundRate', {
              params: { symbol: exchangeSymbol },
            }),
            this.request<BitgetResponse<{ markPrice: string }>>('GET', '/api/mix/v1/market/mark-price', {
              params: { symbol: exchangeSymbol },
            }),
          ]);
          return { symbol, oiRes, fundingRes, markRes };
        } catch (err) {
          this.logger.warn({ symbol, err: (err as Error).message }, 'getAllData fetch failed');
          return null;
        }
      }),
    );

    for (const result of results) {
      if (!result) continue;
      const { symbol, oiRes, fundingRes, markRes } = result;
      try {
        const markPrice = this.toNonNegative(markRes.data?.markPrice, 'markPrice');
        const oi = this.toNonNegative(oiRes.data?.amount, 'amount');
        const fundingRate = this.toFiniteNumber(fundingRes.data?.fundingRate, 'fundingRate');

        openInterest.push({
          exchange: this.name, symbol,
          openInterest: oi,
          openInterestValue: oi * markPrice,
          timestamp: now,
        });
        fundingRates.push({
          exchange: this.name, symbol,
          fundingRate,
          fundingTime: now + 8 * 3_600_000,
          timestamp: now,
        });
        markPrices.push({
          exchange: this.name, symbol,
          markPrice,
          indexPrice: markPrice,
          timestamp: now,
        });
      } catch (err) {
        this.logger.warn({ symbol, err: (err as Error).message }, 'getAllData parse failed');
      }
    }

    return { exchange: this.name, openInterest, fundingRates, markPrices, timestamp: now };
  }
}
