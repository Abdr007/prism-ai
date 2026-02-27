import { BaseExchangeClient } from './base.js';
import type { OpenInterest, FundingRate, MarkPrice, ExchangeData } from './types.js';

const BASE_URL = 'https://futures.kraken.com/derivatives/api/v3';

function toExchangeSymbol(symbol: string): string {
  if (symbol === 'BTC') return 'PF_XBTUSD';
  return `PF_${symbol}USD`;
}

interface KrakenTicker {
  symbol: string;
  openInterest: string;
  markPrice: string;
  indexPrice?: string;
  fundingRate: string;
  fundingRatePrediction?: string;
}

interface KrakenTickersResponse {
  tickers: KrakenTicker[];
}

export class KrakenClient extends BaseExchangeClient {
  readonly name = 'kraken';

  constructor() {
    super(BASE_URL);
  }

  /** Fetch all tickers once — single call serves OI, funding, mark price. */
  private async fetchTicker(symbol: string): Promise<KrakenTicker> {
    const exchangeSymbol = toExchangeSymbol(symbol);
    const res = await this.request<KrakenTickersResponse>('GET', '/tickers');
    const tickers = res.tickers || [];
    const ticker = tickers.find((t) => t.symbol === exchangeSymbol);
    if (!ticker) throw new Error(`Symbol ${exchangeSymbol} not found on Kraken`);
    return ticker;
  }

  /** Normalize Kraken's funding rate: handle percentage format + 4h→8h conversion. */
  private normalizeFundingRate(ticker: KrakenTicker): number {
    let fundingRate = this.toFiniteNumber(ticker.fundingRate, 'fundingRate');

    // Kraken: if value seems like a percentage (>1%), convert to decimal
    if (Math.abs(fundingRate) > 0.01) {
      fundingRate = fundingRate / 100;
    }

    // Normalize 4h rate → 8h rate
    fundingRate = fundingRate * 2;

    // Use predicted rate if it's more conservative
    const predicted = parseFloat(ticker.fundingRatePrediction || '0');
    if (Number.isFinite(predicted) && predicted !== 0) {
      const normalizedPredicted = (Math.abs(predicted) > 0.01 ? predicted / 100 : predicted) * 2;
      if (Math.abs(normalizedPredicted) < Math.abs(fundingRate)) {
        fundingRate = normalizedPredicted;
      }
    }

    return fundingRate;
  }

  async getOpenInterest(symbol: string): Promise<OpenInterest> {
    const ticker = await this.fetchTicker(symbol);
    const oi = this.toNonNegative(ticker.openInterest, 'openInterest');
    const price = this.toNonNegative(ticker.markPrice, 'markPrice');

    return {
      exchange: this.name,
      symbol,
      openInterest: oi,
      openInterestValue: oi * price,
      timestamp: this.now(),
    };
  }

  async getFundingRate(symbol: string): Promise<FundingRate> {
    const ticker = await this.fetchTicker(symbol);
    const fundingRate = this.normalizeFundingRate(ticker);

    return {
      exchange: this.name,
      symbol,
      fundingRate,
      fundingTime: this.now() + 4 * 3_600_000, // Kraken 4h funding
      timestamp: this.now(),
    };
  }

  async getMarkPrice(symbol: string): Promise<MarkPrice> {
    const ticker = await this.fetchTicker(symbol);
    const markPrice = this.toNonNegative(ticker.markPrice, 'markPrice');
    const indexPrice = this.toNonNegative(ticker.indexPrice ?? ticker.markPrice, 'indexPrice');

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
   * Batch-optimized: 1 API call total for ALL symbols.
   * /tickers returns every instrument — fetched once, looped for each symbol.
   * Down from 3 calls/symbol (75 total) to 1 call total.
   */
  async getAllData(symbols: string[]): Promise<ExchangeData> {
    const openInterest: OpenInterest[] = [];
    const fundingRates: FundingRate[] = [];
    const markPrices: MarkPrice[] = [];
    const now = this.now();

    const res = await this.request<KrakenTickersResponse>('GET', '/tickers');
    const tickers = res.tickers || [];

    for (const symbol of symbols) {
      const exchangeSymbol = toExchangeSymbol(symbol);
      const ticker = tickers.find((t) => t.symbol === exchangeSymbol);
      if (!ticker) {
        this.logger.warn({ symbol, exchangeSymbol }, 'Symbol not found in Kraken tickers');
        continue;
      }

      try {
        const oi = this.toNonNegative(ticker.openInterest, 'openInterest');
        const markPrice = this.toNonNegative(ticker.markPrice, 'markPrice');
        const indexPrice = this.toNonNegative(ticker.indexPrice ?? ticker.markPrice, 'indexPrice');
        const fundingRate = this.normalizeFundingRate(ticker);

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
          fundingTime: now + 4 * 3_600_000,
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
