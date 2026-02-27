/**
 * Binance Futures historical API client.
 *
 * Thin wrapper over REST endpoints with:
 *  - Rate-limit awareness (X-MBX-USED-WEIGHT headers)
 *  - Retry with exponential backoff
 *  - Strict numeric parsing
 *  - Structured logging
 *
 * No synthetic data. Every value originates from Binance.
 */

import axios, { type AxiosInstance, type AxiosError } from 'axios';
import { logger as rootLogger } from '../lib/logger.js';
import type {
  BinanceKline,
  BinanceMarkPriceKline,
  BinanceFundingRate,
  BinanceOpenInterestHist,
} from './types.js';

const log = rootLogger.child({ component: 'binance-historical' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_URL = 'https://fapi.binance.com';

/** Binance kline limit per request. */
const KLINE_LIMIT = 1500;

/** Binance funding rate limit per request. */
const FUNDING_LIMIT = 1000;

/** Binance OI history limit per request. */
const OI_LIMIT = 500;

/** Rate-limit safety: sleep after each paginated request (ms). */
const RATE_LIMIT_SLEEP_MS = 200;

/** Max retries per request. */
const MAX_RETRIES = 3;

/** Base delay for exponential backoff (ms). */
const RETRY_BASE_MS = 1_000;

/** Request timeout (ms). */
const TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function toFinite(val: string | number | null | undefined, label: string): number {
  const n = typeof val === 'string' ? Number(val) : (val ?? NaN);
  if (!Number.isFinite(n)) throw new Error(`Non-finite value for ${label}: ${val}`);
  return n;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class BinanceHistoricalClient {
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: BASE_URL,
      timeout: TIMEOUT_MS,
    });
  }

  // -------------------------------------------------------------------------
  // Generic request with retry
  // -------------------------------------------------------------------------

  private async request<T>(path: string, params: Record<string, unknown>): Promise<T> {
    let lastErr: Error | undefined;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const resp = await this.http.get<T>(path, { params });

        // Track weight usage from response headers
        const weight = resp.headers['x-mbx-used-weight-1m'];
        if (weight && Number(weight) > 1000) {
          log.warn({ weight, path }, 'Approaching Binance weight limit');
          await sleep(5_000);
        }

        return resp.data;
      } catch (err) {
        const axErr = err as AxiosError;
        lastErr = axErr;

        if (axErr.response?.status === 429 || axErr.response?.status === 418) {
          const retryAfter = Number(axErr.response.headers['retry-after'] || 60);
          log.warn({ retryAfter, path, attempt }, 'Rate limited, sleeping');
          await sleep(retryAfter * 1_000);
          continue;
        }

        if (attempt < MAX_RETRIES) {
          const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
          log.warn({ path, attempt, delay, err: axErr.message }, 'Retrying');
          await sleep(delay);
        }
      }
    }

    throw lastErr ?? new Error(`Request failed: ${path}`);
  }

  // -------------------------------------------------------------------------
  // Mark Price Klines
  // -------------------------------------------------------------------------

  /**
   * Fetch mark price klines (1m) for a symbol between start and end.
   * Paginates automatically — Binance returns max 1500 per call.
   */
  async fetchMarkPriceKlines(
    symbol: string,
    startMs: number,
    endMs: number,
  ): Promise<Array<{ timestamp: Date; markPrice: number }>> {
    const results: Array<{ timestamp: Date; markPrice: number }> = [];
    let cursor = startMs;

    while (cursor < endMs) {
      const raw = await this.request<Array<Array<string | number>>>(
        '/fapi/v1/markPriceKlines',
        {
          symbol,
          interval: '1m',
          startTime: cursor,
          endTime: endMs,
          limit: KLINE_LIMIT,
        },
      );

      if (raw.length === 0) break;

      for (const k of raw) {
        // Format: [openTime, open, high, low, close, ?, closeTime]
        const openTime = k[0] as number;
        const close = toFinite(k[4] as string, 'markPrice.close');
        results.push({
          timestamp: new Date(openTime),
          markPrice: close,
        });
      }

      // Move cursor past last kline
      const lastOpen = raw[raw.length - 1][0] as number;
      cursor = lastOpen + 60_000; // +1 minute

      if (raw.length < KLINE_LIMIT) break;
      await sleep(RATE_LIMIT_SLEEP_MS);
    }

    log.info({ symbol, rows: results.length, startMs, endMs }, 'Fetched mark price klines');
    return results;
  }

  // -------------------------------------------------------------------------
  // Funding Rate History
  // -------------------------------------------------------------------------

  /**
   * Fetch historical funding rates. Binance returns max 1000 per call.
   */
  async fetchFundingRates(
    symbol: string,
    startMs: number,
    endMs: number,
  ): Promise<Array<{ fundingTime: Date; fundingRate: number }>> {
    const results: Array<{ fundingTime: Date; fundingRate: number }> = [];
    let cursor = startMs;

    while (cursor < endMs) {
      const raw = await this.request<BinanceFundingRate[]>(
        '/fapi/v1/fundingRate',
        {
          symbol,
          startTime: cursor,
          endTime: endMs,
          limit: FUNDING_LIMIT,
        },
      );

      if (raw.length === 0) break;

      for (const r of raw) {
        results.push({
          fundingTime: new Date(r.fundingTime),
          fundingRate: toFinite(r.fundingRate, 'fundingRate'),
        });
      }

      const lastTime = raw[raw.length - 1].fundingTime;
      cursor = lastTime + 1;

      if (raw.length < FUNDING_LIMIT) break;
      await sleep(RATE_LIMIT_SLEEP_MS);
    }

    log.info({ symbol, rows: results.length, startMs, endMs }, 'Fetched funding rates');
    return results;
  }

  // -------------------------------------------------------------------------
  // Open Interest History
  // -------------------------------------------------------------------------

  /**
   * Fetch historical open interest. Binance data-api returns max 500 per call.
   * Endpoint: /futures/data/openInterestHist
   * Available periods: 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d.
   * The smallest granularity is 5m.
   */
  async fetchOpenInterestHistory(
    symbol: string,
    startMs: number,
    endMs: number,
    period: '5m' | '15m' | '30m' | '1h' | '4h' | '1d' = '5m',
  ): Promise<Array<{ timestamp: Date; openInterestUsd: number }>> {
    const results: Array<{ timestamp: Date; openInterestUsd: number }> = [];
    let cursor = startMs;

    while (cursor < endMs) {
      const raw = await this.request<BinanceOpenInterestHist[]>(
        '/futures/data/openInterestHist',
        {
          symbol,
          period,
          startTime: cursor,
          endTime: endMs,
          limit: OI_LIMIT,
        },
      );

      if (raw.length === 0) break;

      for (const r of raw) {
        results.push({
          timestamp: new Date(r.timestamp),
          openInterestUsd: toFinite(r.sumOpenInterestValue, 'sumOpenInterestValue'),
        });
      }

      const lastTime = raw[raw.length - 1].timestamp;
      cursor = lastTime + 1;

      if (raw.length < OI_LIMIT) break;
      await sleep(RATE_LIMIT_SLEEP_MS);
    }

    log.info({ symbol, rows: results.length, period, startMs, endMs }, 'Fetched OI history');
    return results;
  }
}
