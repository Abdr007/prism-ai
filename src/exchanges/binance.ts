import { BaseExchangeClient } from './base.js';
import type { OpenInterest, FundingRate, MarkPrice, ExchangeData } from './types.js';

const BASE_URL = 'https://fapi.binance.com';

function toExchangeSymbol(symbol: string): string {
  return `${symbol}USDT`;
}

interface BinancePremiumIndex {
  markPrice: string;
  indexPrice: string;
  lastFundingRate: string;
  nextFundingTime: number;
}

export class BinanceClient extends BaseExchangeClient {
  readonly name = 'binance';

  constructor() {
    super(BASE_URL);
  }

  async getOpenInterest(symbol: string): Promise<OpenInterest> {
    const exchangeSymbol = toExchangeSymbol(symbol);

    const [oiRes, priceRes] = await Promise.all([
      this.request<{ openInterest: string }>('GET', '/fapi/v1/openInterest', {
        params: { symbol: exchangeSymbol },
      }),
      this.request<{ price: string }>('GET', '/fapi/v1/ticker/price', {
        params: { symbol: exchangeSymbol },
      }),
    ]);

    const oi = this.toNonNegative(oiRes.openInterest, 'openInterest');
    const price = this.toNonNegative(priceRes.price, 'price');
    const oiValue = oi * price;

    return {
      exchange: this.name,
      symbol,
      openInterest: oi,
      openInterestValue: oiValue,
      timestamp: this.now(),
    };
  }

  async getFundingRate(symbol: string): Promise<FundingRate> {
    const exchangeSymbol = toExchangeSymbol(symbol);

    const res = await this.request<BinancePremiumIndex>('GET', '/fapi/v1/premiumIndex', {
      params: { symbol: exchangeSymbol },
    });

    const fundingRate = this.toFiniteNumber(res.lastFundingRate, 'lastFundingRate');

    return {
      exchange: this.name,
      symbol,
      fundingRate,
      fundingTime: res.nextFundingTime || this.now(),
      timestamp: this.now(),
    };
  }

  async getMarkPrice(symbol: string): Promise<MarkPrice> {
    const exchangeSymbol = toExchangeSymbol(symbol);

    const res = await this.request<BinancePremiumIndex>('GET', '/fapi/v1/premiumIndex', {
      params: { symbol: exchangeSymbol },
    });

    const markPrice = this.toNonNegative(res.markPrice, 'markPrice');
    const indexPrice = this.toNonNegative(res.indexPrice, 'indexPrice');

    this.assertPriceDeviation(markPrice, indexPrice, symbol);

    return {
      exchange: this.name,
      symbol,
      markPrice,
      indexPrice: indexPrice || markPrice,
      timestamp: this.now(),
    };
  }

  /**
   * Batch-optimized: 2 calls per symbol (premiumIndex + openInterest).
   * Eliminates duplicate premiumIndex calls and separate ticker/price fetch.
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
          const [premiumIndex, oiRes] = await Promise.all([
            this.request<BinancePremiumIndex>('GET', '/fapi/v1/premiumIndex', {
              params: { symbol: exchangeSymbol },
            }),
            this.request<{ openInterest: string }>('GET', '/fapi/v1/openInterest', {
              params: { symbol: exchangeSymbol },
            }),
          ]);
          return { symbol, premiumIndex, oiRes };
        } catch (err) {
          this.logger.warn({ symbol, err: (err as Error).message }, 'getAllData fetch failed');
          return null;
        }
      }),
    );

    for (const result of results) {
      if (!result) continue;
      const { symbol, premiumIndex, oiRes } = result;
      try {
        const markPrice = this.toNonNegative(premiumIndex.markPrice, 'markPrice');
        const indexPrice = this.toNonNegative(premiumIndex.indexPrice, 'indexPrice');
        const oi = this.toNonNegative(oiRes.openInterest, 'openInterest');
        const fundingRate = this.toFiniteNumber(premiumIndex.lastFundingRate, 'lastFundingRate');

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
          fundingTime: premiumIndex.nextFundingTime || now,
          timestamp: now,
        });
        markPrices.push({
          exchange: this.name, symbol,
          markPrice,
          indexPrice: indexPrice || markPrice,
          timestamp: now,
        });
      } catch (err) {
        this.logger.warn({ symbol, err: (err as Error).message }, 'getAllData parse failed');
      }
    }

    return { exchange: this.name, openInterest, fundingRates, markPrices, timestamp: now };
  }
}
