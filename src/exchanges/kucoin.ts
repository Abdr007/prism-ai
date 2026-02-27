import { BaseExchangeClient } from './base.js';
import type { OpenInterest, FundingRate, MarkPrice, ExchangeData } from './types.js';

const BASE_URL = 'https://api-futures.kucoin.com';

function toExchangeSymbol(symbol: string): string {
  if (symbol === 'BTC') return 'XBTUSDTM';
  return `${symbol}USDTM`;
}

interface KuCoinResponse<T> {
  data: T;
}

export class KuCoinClient extends BaseExchangeClient {
  readonly name = 'kucoin';

  constructor() {
    super(BASE_URL);
  }

  async getOpenInterest(symbol: string): Promise<OpenInterest> {
    const exchangeSymbol = toExchangeSymbol(symbol);

    const [oiRes, tickerRes] = await Promise.all([
      this.request<KuCoinResponse<{ openInterest: string }>>('GET', '/api/v1/openInterest', {
        params: { symbol: exchangeSymbol },
      }),
      this.request<KuCoinResponse<{ price: string }>>('GET', '/api/v1/ticker', {
        params: { symbol: exchangeSymbol },
      }),
    ]);

    const oi = this.toNonNegative(oiRes.data?.openInterest, 'openInterest');
    const price = this.toNonNegative(tickerRes.data?.price, 'price');

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

    const res = await this.request<KuCoinResponse<{
      value: string;
      timePoint: number;
    }>>('GET', `/api/v1/funding-rate/${exchangeSymbol}/current`);

    const fundingRate = this.toFiniteNumber(res.data?.value, 'value');

    return {
      exchange: this.name,
      symbol,
      fundingRate,
      fundingTime: res.data?.timePoint || this.now(),
      timestamp: this.now(),
    };
  }

  async getMarkPrice(symbol: string): Promise<MarkPrice> {
    const exchangeSymbol = toExchangeSymbol(symbol);

    const res = await this.request<KuCoinResponse<{
      value: string;
      indexPrice: string;
    }>>('GET', `/api/v1/mark-price/${exchangeSymbol}/current`);

    const markPrice = this.toNonNegative(res.data?.value, 'value');
    const indexPrice = this.toNonNegative(res.data?.indexPrice, 'indexPrice');

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
            this.request<KuCoinResponse<{ openInterest: string }>>('GET', '/api/v1/openInterest', {
              params: { symbol: exchangeSymbol },
            }),
            this.request<KuCoinResponse<{ value: string; timePoint: number }>>('GET', `/api/v1/funding-rate/${exchangeSymbol}/current`),
            this.request<KuCoinResponse<{ value: string; indexPrice: string }>>('GET', `/api/v1/mark-price/${exchangeSymbol}/current`),
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
        const oi = this.toNonNegative(oiRes.data?.openInterest, 'openInterest');
        const markPrice = this.toNonNegative(markRes.data?.value, 'value');
        const indexPrice = this.toNonNegative(markRes.data?.indexPrice, 'indexPrice');
        const fundingRate = this.toFiniteNumber(fundingRes.data?.value, 'value');

        this.assertPriceDeviation(markPrice, indexPrice, symbol);

        openInterest.push({
          exchange: this.name, symbol,
          openInterest: oi,
          openInterestValue: oi * markPrice,
          timestamp: now,
        });
        fundingRates.push({
          exchange: this.name, symbol,
          fundingRate,
          fundingTime: fundingRes.data?.timePoint || now,
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
