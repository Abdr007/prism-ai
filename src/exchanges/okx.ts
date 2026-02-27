import { BaseExchangeClient } from './base.js';
import type { OpenInterest, FundingRate, MarkPrice, ExchangeData } from './types.js';

const BASE_URL = 'https://www.okx.com';

function toSwapSymbol(symbol: string): string {
  return `${symbol}-USDT-SWAP`;
}

interface OKXResponse<T> {
  data: T[];
}

export class OKXClient extends BaseExchangeClient {
  readonly name = 'okx';

  constructor() {
    super(BASE_URL);
  }

  async getOpenInterest(symbol: string): Promise<OpenInterest> {
    const exchangeSymbol = toSwapSymbol(symbol);

    const [oiRes, tickerRes] = await Promise.all([
      this.request<OKXResponse<{ oi: string }>>('GET', '/api/v5/public/open-interest', {
        params: { instType: 'SWAP', instId: exchangeSymbol },
      }),
      this.request<OKXResponse<{ last: string }>>('GET', '/api/v5/market/ticker', {
        params: { instId: exchangeSymbol },
      }),
    ]);

    const oi = this.toNonNegative(oiRes.data[0]?.oi, 'oi');
    const price = this.toNonNegative(tickerRes.data[0]?.last, 'last');

    return {
      exchange: this.name,
      symbol,
      openInterest: oi,
      openInterestValue: oi * price,
      timestamp: this.now(),
    };
  }

  async getFundingRate(symbol: string): Promise<FundingRate> {
    const exchangeSymbol = toSwapSymbol(symbol);

    const res = await this.request<OKXResponse<{
      fundingRate: string;
      nextFundingTime: string;
    }>>('GET', '/api/v5/public/funding-rate', {
      params: { instId: exchangeSymbol },
    });

    const data = res.data[0];
    const fundingRate = this.toFiniteNumber(data?.fundingRate, 'fundingRate');
    const fundingTime = this.toFiniteNumber(data?.nextFundingTime, 'nextFundingTime');

    return {
      exchange: this.name,
      symbol,
      fundingRate,
      fundingTime,
      timestamp: this.now(),
    };
  }

  async getMarkPrice(symbol: string): Promise<MarkPrice> {
    const exchangeSymbol = toSwapSymbol(symbol);

    // Fetch mark price and index price in parallel
    const [markRes, indexRes] = await Promise.all([
      this.request<OKXResponse<{ markPx: string }>>('GET', '/api/v5/public/mark-price', {
        params: { instType: 'SWAP', instId: exchangeSymbol },
      }),
      this.request<OKXResponse<{ idxPx: string }>>('GET', '/api/v5/market/index-tickers', {
        params: { instId: `${symbol}-USDT` },
      }),
    ]);

    const markPrice = this.toNonNegative(markRes.data[0]?.markPx, 'markPx');
    const indexPrice = this.toNonNegative(indexRes.data[0]?.idxPx, 'idxPx');

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
   * Batch-optimized: 4 calls per symbol (dropped separate /ticker).
   * Uses mark price for OI value instead of fetching /ticker separately.
   * Down from 5 calls/symbol to 4 calls/symbol.
   */
  async getAllData(symbols: string[]): Promise<ExchangeData> {
    const openInterest: OpenInterest[] = [];
    const fundingRates: FundingRate[] = [];
    const markPrices: MarkPrice[] = [];
    const now = this.now();

    const results = await Promise.all(
      symbols.map(async (symbol) => {
        const exchangeSymbol = toSwapSymbol(symbol);
        try {
          const [oiRes, fundingRes, markRes, indexRes] = await Promise.all([
            this.request<OKXResponse<{ oi: string }>>('GET', '/api/v5/public/open-interest', {
              params: { instType: 'SWAP', instId: exchangeSymbol },
            }),
            this.request<OKXResponse<{ fundingRate: string; nextFundingTime: string }>>('GET', '/api/v5/public/funding-rate', {
              params: { instId: exchangeSymbol },
            }),
            this.request<OKXResponse<{ markPx: string }>>('GET', '/api/v5/public/mark-price', {
              params: { instType: 'SWAP', instId: exchangeSymbol },
            }),
            this.request<OKXResponse<{ idxPx: string }>>('GET', '/api/v5/market/index-tickers', {
              params: { instId: `${symbol}-USDT` },
            }),
          ]);
          return { symbol, oiRes, fundingRes, markRes, indexRes };
        } catch (err) {
          this.logger.warn({ symbol, err: (err as Error).message }, 'getAllData fetch failed');
          return null;
        }
      }),
    );

    for (const result of results) {
      if (!result) continue;
      const { symbol, oiRes, fundingRes, markRes, indexRes } = result;
      try {
        const markPrice = this.toNonNegative(markRes.data[0]?.markPx, 'markPx');
        const indexPrice = this.toNonNegative(indexRes.data[0]?.idxPx, 'idxPx');
        const oi = this.toNonNegative(oiRes.data[0]?.oi, 'oi');
        const fundingRate = this.toFiniteNumber(fundingRes.data[0]?.fundingRate, 'fundingRate');
        const fundingTime = this.toFiniteNumber(fundingRes.data[0]?.nextFundingTime, 'nextFundingTime');

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
