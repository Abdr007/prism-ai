import { BaseExchangeClient } from './base.js';
import type { OpenInterest, FundingRate, MarkPrice, ExchangeData } from './types.js';

const BASE_URL = 'https://api.bybit.com';

function toExchangeSymbol(symbol: string): string {
  return `${symbol}USDT`;
}

interface BybitResult<T> {
  result: { list: T[] };
}

interface BybitTickerItem {
  lastPrice: string;
  fundingRate: string;
  nextFundingTime: string;
  markPrice: string;
  indexPrice: string;
  openInterest: string;
}

export class BybitClient extends BaseExchangeClient {
  readonly name = 'bybit';

  constructor() {
    super(BASE_URL);
  }

  async getOpenInterest(symbol: string): Promise<OpenInterest> {
    const exchangeSymbol = toExchangeSymbol(symbol);

    const [oiRes, tickerRes] = await Promise.all([
      this.request<BybitResult<{ openInterest: string }>>('GET', '/v5/market/open-interest', {
        params: { category: 'linear', symbol: exchangeSymbol, intervalTime: '5min', limit: 1 },
      }),
      this.request<BybitResult<{ lastPrice: string }>>('GET', '/v5/market/tickers', {
        params: { category: 'linear', symbol: exchangeSymbol },
      }),
    ]);

    const oiData = oiRes.result.list[0];
    const tickerData = tickerRes.result.list[0];

    const oi = this.toNonNegative(oiData?.openInterest, 'openInterest');
    const price = this.toNonNegative(tickerData?.lastPrice, 'lastPrice');

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

    const res = await this.request<BybitResult<{
      fundingRate: string;
      nextFundingTime: string;
    }>>('GET', '/v5/market/tickers', {
      params: { category: 'linear', symbol: exchangeSymbol },
    });

    const data = res.result.list[0];
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
    const exchangeSymbol = toExchangeSymbol(symbol);

    const res = await this.request<BybitResult<{
      markPrice: string;
      indexPrice: string;
    }>>('GET', '/v5/market/tickers', {
      params: { category: 'linear', symbol: exchangeSymbol },
    });

    const data = res.result.list[0];
    const markPrice = this.toNonNegative(data?.markPrice, 'markPrice');
    const indexPrice = this.toNonNegative(data?.indexPrice, 'indexPrice');

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
   * Batch-optimized: 1 ticker + 1 open-interest per symbol.
   * Eliminates 2 duplicate /tickers calls per symbol (was 3× /tickers + 1× /open-interest).
   * Down from 4 calls/symbol to 2 calls/symbol.
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
          const [tickerRes, oiRes] = await Promise.all([
            this.request<BybitResult<BybitTickerItem>>('GET', '/v5/market/tickers', {
              params: { category: 'linear', symbol: exchangeSymbol },
            }),
            this.request<BybitResult<{ openInterest: string }>>('GET', '/v5/market/open-interest', {
              params: { category: 'linear', symbol: exchangeSymbol, intervalTime: '5min', limit: 1 },
            }),
          ]);
          return { symbol, tickerRes, oiRes };
        } catch (err) {
          this.logger.warn({ symbol, err: (err as Error).message }, 'getAllData fetch failed');
          return null;
        }
      }),
    );

    for (const result of results) {
      if (!result) continue;
      const { symbol, tickerRes, oiRes } = result;
      try {
        const ticker = tickerRes.result.list[0];
        const oiData = oiRes.result.list[0];

        const oi = this.toNonNegative(oiData?.openInterest, 'openInterest');
        const price = this.toNonNegative(ticker?.lastPrice, 'lastPrice');
        const fundingRate = this.toFiniteNumber(ticker?.fundingRate, 'fundingRate');
        const fundingTime = this.toFiniteNumber(ticker?.nextFundingTime, 'nextFundingTime');
        const markPrice = this.toNonNegative(ticker?.markPrice, 'markPrice');
        const indexPrice = this.toNonNegative(ticker?.indexPrice, 'indexPrice');

        this.assertPriceDeviation(markPrice, indexPrice, symbol);

        openInterest.push({
          exchange: this.name, symbol,
          openInterest: oi,
          openInterestValue: oi * price,
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
