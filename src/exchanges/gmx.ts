import { BaseExchangeClient } from './base.js';
import type { OpenInterest, FundingRate, MarkPrice, ExchangeData } from './types.js';

const BASE_URL = 'https://arbitrum-api.gmxinfra.io';

const MARKET_TOKENS: Record<string, string> = {
  BTC: '0x47c031236e19d024b42f8AE6780E44A573170703',
  ETH: '0x70d95587d40A2caf56bd97485aB3Eec10Bee6336',
  SOL: '0x09400D9DB990D5ed3f35D7be61DfAEB900Af03C9',
  LINK: '0x7f1fa204bb700853D36994DA19F830b6Ad18455C',
  ARB: '0xC25cEf6061Cf5dE5eb761b50E4743c1F5D7E5407',
  DOGE: '0x6853EA96FF216fAb11D2d930CE3C508556A4bdc4',
  XRP: '0x0CCB4fAa6f1F1B30911619f1184082aB4E25813c',
};

interface GMXMarket {
  marketToken: string;
  longInterestUsd: string;
  shortInterestUsd: string;
  indexTokenPrice?: { max: string };
  borrowingFactorPerSecondForLongs: string;
  borrowingFactorPerSecondForShorts: string;
}

export class GMXClient extends BaseExchangeClient {
  readonly name = 'gmx';

  constructor() {
    super(BASE_URL);
  }

  private findMarket(markets: GMXMarket[], symbol: string): GMXMarket | null {
    const token = MARKET_TOKENS[symbol];
    if (!token) return null;
    return markets.find((m) => m.marketToken === token) ?? null;
  }

  async getOpenInterest(symbol: string): Promise<OpenInterest> {
    const res = await this.request<{ markets: GMXMarket[] }>('GET', '/markets');
    const market = this.findMarket(res.markets || [], symbol);
    if (!market) {
      return { exchange: this.name, symbol, openInterest: 0, openInterestValue: 0, timestamp: this.now() };
    }

    const longOI = this.toNonNegative(market.longInterestUsd, 'longInterestUsd') / 1e30;
    const shortOI = this.toNonNegative(market.shortInterestUsd, 'shortInterestUsd') / 1e30;
    const totalOI = longOI + shortOI;
    const price = this.toNonNegative(market.indexTokenPrice?.max ?? '0', 'indexTokenPrice') / 1e30;

    return {
      exchange: this.name,
      symbol,
      openInterest: price > 0 ? totalOI / price : 0,
      openInterestValue: totalOI,
      timestamp: this.now(),
    };
  }

  async getFundingRate(symbol: string): Promise<FundingRate> {
    const res = await this.request<{ markets: GMXMarket[] }>('GET', '/markets');
    const market = this.findMarket(res.markets || [], symbol);

    // GMX V2 uses borrowing fees instead of traditional funding
    const borrowLong = this.toFiniteNumber(market?.borrowingFactorPerSecondForLongs ?? '0', 'borrowLong');
    const borrowShort = this.toFiniteNumber(market?.borrowingFactorPerSecondForShorts ?? '0', 'borrowShort');

    // Convert per-second borrow to 8h equivalent funding rate
    const avgBorrow = (borrowLong + borrowShort) / 2;
    const fundingRate = avgBorrow * 8 * 3600;

    return {
      exchange: this.name,
      symbol,
      fundingRate,
      fundingTime: this.now() + 8 * 3_600_000,
      timestamp: this.now(),
    };
  }

  async getMarkPrice(symbol: string): Promise<MarkPrice> {
    const res = await this.request<Record<string, { maxPrice: string }>>('GET', '/prices/tickers');
    const priceKey = Object.keys(res).find((k) => k.includes(symbol));
    const price = priceKey ? this.toNonNegative(res[priceKey]?.maxPrice, 'maxPrice') / 1e30 : 0;

    return {
      exchange: this.name,
      symbol,
      markPrice: price,
      indexPrice: price, // GMX uses same index for both
      timestamp: this.now(),
    };
  }

  /**
   * Batch-optimized: 2 API calls total for ALL symbols.
   * /markets (OI + funding) and /prices/tickers (mark price) each fetched once.
   * Down from 3 calls/symbol (75 total) to 2 calls total.
   */
  async getAllData(symbols: string[]): Promise<ExchangeData> {
    const openInterest: OpenInterest[] = [];
    const fundingRates: FundingRate[] = [];
    const markPrices: MarkPrice[] = [];
    const now = this.now();

    const [marketsRes, pricesRes] = await Promise.all([
      this.request<{ markets: GMXMarket[] }>('GET', '/markets'),
      this.request<Record<string, { maxPrice: string }>>('GET', '/prices/tickers'),
    ]);

    const markets = marketsRes.markets || [];

    for (const symbol of symbols) {
      try {
        // OI + funding from /markets
        const market = this.findMarket(markets, symbol);
        if (market) {
          const longOI = this.toNonNegative(market.longInterestUsd, 'longInterestUsd') / 1e30;
          const shortOI = this.toNonNegative(market.shortInterestUsd, 'shortInterestUsd') / 1e30;
          const totalOI = longOI + shortOI;
          const tokenPrice = this.toNonNegative(market.indexTokenPrice?.max ?? '0', 'indexTokenPrice') / 1e30;

          openInterest.push({
            exchange: this.name, symbol,
            openInterest: tokenPrice > 0 ? totalOI / tokenPrice : 0,
            openInterestValue: totalOI,
            timestamp: now,
          });

          const borrowLong = this.toFiniteNumber(market.borrowingFactorPerSecondForLongs, 'borrowLong');
          const borrowShort = this.toFiniteNumber(market.borrowingFactorPerSecondForShorts, 'borrowShort');
          const avgBorrow = (borrowLong + borrowShort) / 2;
          const fundingRate = avgBorrow * 8 * 3600;

          fundingRates.push({
            exchange: this.name, symbol,
            fundingRate,
            fundingTime: now + 8 * 3_600_000,
            timestamp: now,
          });
        }

        // Mark price from /prices/tickers
        const priceKey = Object.keys(pricesRes).find((k) => k.includes(symbol));
        const price = priceKey ? this.toNonNegative(pricesRes[priceKey]?.maxPrice, 'maxPrice') / 1e30 : 0;

        if (price > 0) {
          markPrices.push({
            exchange: this.name, symbol,
            markPrice: price,
            indexPrice: price,
            timestamp: now,
          });
        }
      } catch (err) {
        this.logger.warn({ symbol, err: (err as Error).message }, 'getAllData parse failed');
      }
    }

    return { exchange: this.name, openInterest, fundingRates, markPrices, timestamp: now };
  }
}
