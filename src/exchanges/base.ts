/**
 * BaseExchangeClient — Phase 2: Data Ingestion Hardening
 *
 * Production-grade base class for all exchange clients.
 *
 * Features:
 *  - 5-second timeout per HTTP request
 *  - Retry logic: max 3 attempts with exponential backoff
 *  - Rate limit detection (HTTP 429 + Retry-After)
 *  - Strict numeric validation: no null, no NaN, no Infinity
 *  - markPrice vs indexPrice deviation rejection (>10%)
 *  - Structured JSON logging (no console.log)
 *  - Per-exchange health tracking
 *  - UTC timestamps
 *
 * Preserves existing ExchangeClient interface contract.
 */

import axios, { type AxiosInstance, type AxiosError } from 'axios';
import { logger as rootLogger, type Logger } from '../lib/logger.js';
import type {
  ExchangeClient,
  OpenInterest,
  FundingRate,
  MarkPrice,
  ExchangeData,
} from './types.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface HttpConfig {
  /** Request timeout in ms. Default: 5000 */
  timeoutMs: number;
  /** Maximum retry attempts. Default: 3 */
  maxRetries: number;
  /** Base delay between retries in ms (doubles each attempt). Default: 1000 */
  retryBaseDelayMs: number;
}

const DEFAULT_HTTP_CONFIG: HttpConfig = {
  timeoutMs: 5_000,
  maxRetries: 3,
  retryBaseDelayMs: 1_000,
};

// ---------------------------------------------------------------------------
// Validation Error
// ---------------------------------------------------------------------------

export class ValidationError extends Error {
  constructor(
    public readonly exchange: string,
    public readonly field: string,
    public readonly rawValue: unknown,
    detail: string,
  ) {
    super(`[${exchange}] Validation failed — ${field}: ${detail}`);
    this.name = 'ValidationError';
  }
}

// ---------------------------------------------------------------------------
// Rate Limit State
// ---------------------------------------------------------------------------

interface RateLimitState {
  limited: boolean;
  resetAt: number;
  consecutiveHits: number;
}

// ---------------------------------------------------------------------------
// Health Info
// ---------------------------------------------------------------------------

export interface ExchangeHealth {
  exchange: string;
  consecutiveFailures: number;
  lastSuccessAt: number;
  isRateLimited: boolean;
  lastLatencyMs: number;
}

// ---------------------------------------------------------------------------
// Base Class
// ---------------------------------------------------------------------------

export abstract class BaseExchangeClient implements ExchangeClient {
  abstract readonly name: string;

  protected readonly http: AxiosInstance;
  protected readonly log: Logger;
  private readonly cfg: HttpConfig;
  private rateLimit: RateLimitState = { limited: false, resetAt: 0, consecutiveHits: 0 };
  private failures = 0;
  private lastSuccess = 0;
  private lastLatency = 0;

  constructor(baseURL: string, httpConfig?: Partial<HttpConfig>) {
    this.cfg = { ...DEFAULT_HTTP_CONFIG, ...httpConfig };

    this.http = axios.create({
      baseURL,
      timeout: this.cfg.timeoutMs,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'PrismAI/1.0',
      },
    });

    // Logger is lazily bound to exchange name via child()
    this.log = rootLogger.child({ component: 'exchange' });
  }

  /** Lazy logger that includes exchange name (available after subclass sets `name`). */
  protected get logger(): Logger {
    return this.log.child({ exchange: this.name });
  }

  // -----------------------------------------------------------------------
  // HTTP with retry + rate limit + exponential backoff
  // -----------------------------------------------------------------------

  protected async request<T>(
    method: 'GET' | 'POST',
    url: string,
    options?: { params?: Record<string, unknown>; data?: unknown },
  ): Promise<T> {
    // Wait out rate limit window
    if (this.rateLimit.limited && Date.now() < this.rateLimit.resetAt) {
      const waitMs = this.rateLimit.resetAt - Date.now();
      this.logger.warn({ waitMs }, 'Waiting for rate limit reset');
      await sleep(Math.min(waitMs, 60_000));
    }

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.cfg.maxRetries; attempt++) {
      const t0 = Date.now();
      try {
        const response =
          method === 'GET'
            ? await this.http.get<T>(url, { params: options?.params })
            : await this.http.post<T>(url, options?.data, { params: options?.params });

        const latencyMs = Date.now() - t0;
        this.lastLatency = latencyMs;
        this.failures = 0;
        this.lastSuccess = Date.now();
        this.rateLimit.limited = false;
        this.rateLimit.consecutiveHits = 0;

        this.logger.debug({ method, url, latencyMs, attempt, status: response.status }, 'Request OK');
        return response.data;
      } catch (err) {
        const axErr = err as AxiosError;
        lastError = axErr;

        // Rate limit detection
        if (axErr.response?.status === 429) {
          const retryAfter = parseInt(
            (axErr.response.headers?.['retry-after'] as string) ?? '60',
            10,
          );
          this.rateLimit = {
            limited: true,
            resetAt: Date.now() + retryAfter * 1_000,
            consecutiveHits: this.rateLimit.consecutiveHits + 1,
          };
          this.logger.warn(
            { url, retryAfterSec: retryAfter, hits: this.rateLimit.consecutiveHits },
            'Rate limit hit',
          );
          await sleep(retryAfter * 1_000);
          continue;
        }

        this.logger.warn(
          {
            method,
            url,
            attempt,
            maxRetries: this.cfg.maxRetries,
            status: axErr.response?.status,
            errMsg: axErr.message,
          },
          'Request failed, retrying',
        );

        if (attempt < this.cfg.maxRetries) {
          const delay = this.cfg.retryBaseDelayMs * Math.pow(2, attempt - 1);
          await sleep(delay);
        }
      }
    }

    this.failures++;
    this.logger.error(
      { url, consecutiveFailures: this.failures, errMsg: lastError?.message },
      'All retries exhausted',
    );
    throw lastError ?? new Error(`${this.name}: request failed after ${this.cfg.maxRetries} retries`);
  }

  // -----------------------------------------------------------------------
  // Validation helpers
  // -----------------------------------------------------------------------

  /** Parse and validate a numeric field. Rejects null, undefined, NaN, Infinity. */
  protected toFiniteNumber(raw: unknown, field: string): number {
    const n = typeof raw === 'string' ? parseFloat(raw) : Number(raw);
    if (raw === null || raw === undefined || !Number.isFinite(n)) {
      throw new ValidationError(this.name, field, raw, 'Must be a finite number');
    }
    return n;
  }

  /** Validate non-negative number. */
  protected toNonNegative(raw: unknown, field: string): number {
    const n = this.toFiniteNumber(raw, field);
    if (n < 0) {
      throw new ValidationError(this.name, field, raw, 'Must be >= 0');
    }
    return n;
  }

  /**
   * Reject markPrice if it deviates >10% from indexPrice.
   * If either price is zero/missing, skip check (missing data, not deviation).
   */
  protected assertPriceDeviation(markPrice: number, indexPrice: number, symbol: string): void {
    if (markPrice <= 0 || indexPrice <= 0) return;
    const deviation = Math.abs(markPrice - indexPrice) / indexPrice;
    if (deviation > 0.10) {
      throw new ValidationError(
        this.name,
        'markPrice',
        markPrice,
        `Deviates ${(deviation * 100).toFixed(2)}% from indexPrice (${indexPrice}) for ${symbol}. Max: 10%`,
      );
    }
  }

  /** Current UTC epoch ms. */
  protected now(): number {
    return Date.now();
  }

  // -----------------------------------------------------------------------
  // Default getAllData implementation (can be overridden for batch endpoints)
  // -----------------------------------------------------------------------

  async getAllData(symbols: string[]): Promise<ExchangeData> {
    const [openInterest, fundingRates, markPrices] = await Promise.all([
      Promise.all(symbols.map((s) => this.safeGetOpenInterest(s))),
      Promise.all(symbols.map((s) => this.safeGetFundingRate(s))),
      Promise.all(symbols.map((s) => this.safeGetMarkPrice(s))),
    ]);

    return {
      exchange: this.name,
      openInterest: openInterest.filter(nonNull),
      fundingRates: fundingRates.filter(nonNull),
      markPrices: markPrices.filter(nonNull),
      timestamp: this.now(),
    };
  }

  // Safe wrappers that log and return null on failure instead of throwing
  private async safeGetOpenInterest(symbol: string): Promise<OpenInterest | null> {
    try {
      return await this.getOpenInterest(symbol);
    } catch (err) {
      this.logger.warn(
        { symbol, err: (err as Error).message },
        'getOpenInterest failed',
      );
      return null;
    }
  }

  private async safeGetFundingRate(symbol: string): Promise<FundingRate | null> {
    try {
      return await this.getFundingRate(symbol);
    } catch (err) {
      this.logger.warn(
        { symbol, err: (err as Error).message },
        'getFundingRate failed',
      );
      return null;
    }
  }

  private async safeGetMarkPrice(symbol: string): Promise<MarkPrice | null> {
    try {
      return await this.getMarkPrice(symbol);
    } catch (err) {
      this.logger.warn(
        { symbol, err: (err as Error).message },
        'getMarkPrice failed',
      );
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Health
  // -----------------------------------------------------------------------

  getHealth(): ExchangeHealth {
    return {
      exchange: this.name,
      consecutiveFailures: this.failures,
      lastSuccessAt: this.lastSuccess,
      isRateLimited: this.rateLimit.limited && Date.now() < this.rateLimit.resetAt,
      lastLatencyMs: this.lastLatency,
    };
  }

  // -----------------------------------------------------------------------
  // Abstract — each exchange implements these
  // -----------------------------------------------------------------------

  abstract getOpenInterest(symbol: string): Promise<OpenInterest>;
  abstract getFundingRate(symbol: string): Promise<FundingRate>;
  abstract getMarkPrice(symbol: string): Promise<MarkPrice>;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nonNull<T>(v: T | null): v is T {
  return v !== null;
}
