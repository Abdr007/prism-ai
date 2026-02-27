/**
 * Phase 4 — Live Data Ingestion
 *
 * Real-time ingestion from Binance Futures:
 *
 *   1. WebSocket — mark price stream (all symbols, 1s updates → 1m bucketing)
 *   2. WebSocket — liquidation stream (forceOrder)
 *   3. Scheduled  — open interest polling (every 1 minute)
 *   4. Scheduled  — funding rate polling (every 1 minute, captures on 8h boundary)
 *
 * Features:
 *   - Auto-reconnect with exponential backoff
 *   - Heartbeat monitoring (pong-based liveness)
 *   - Structured logging
 *   - Idempotent writes (ON CONFLICT DO NOTHING)
 *   - No duplicate rows
 *   - Validation before insert
 */

import WebSocket from 'ws';
import axios from 'axios';
import { logger as rootLogger } from '../lib/logger.js';
import {
  ensureHistoricalSchema,
  insertOneMarkPrice,
  insertOneLiquidation,
  insertOneFundingRate,
  insertOneOpenInterest,
  closePool,
} from './db.js';
import {
  validateMarkPrice,
  validateLiquidation,
  validateFundingRate,
  validateOpenInterest,
} from './validate.js';
import type {
  BinanceForceOrder,
  BinanceMarkPriceWs,
  IngestionConfig,
  LiquidationRow,
} from './types.js';

const log = rootLogger.child({ component: 'live-ingest' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BINANCE_WS_BASE = 'wss://fstream.binance.com';
const BINANCE_REST_BASE = 'https://fapi.binance.com';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function toFinite(val: string | number): number {
  const n = typeof val === 'string' ? Number(val) : val;
  if (!Number.isFinite(n)) return NaN;
  return n;
}

// ---------------------------------------------------------------------------
// Mark Price Bucketing
// ---------------------------------------------------------------------------

/**
 * Buckets 1-second mark price updates into 1-minute rows.
 * Keeps last price per symbol per minute. Flushes once per minute.
 */
class MarkPriceBucket {
  /** Map<symbol, { minuteKey, lastPrice, timestamp }> */
  private current = new Map<string, { minute: number; price: number; ts: Date }>();
  private prevPrices = new Map<string, number>();

  /**
   * Ingest a mark price tick. Returns a row to flush if the minute rolled over.
   */
  ingest(
    symbol: string,
    price: number,
    eventTime: number,
  ): { symbol: string; timestamp: Date; markPrice: number } | null {
    const minute = Math.floor(eventTime / 60_000) * 60_000;
    const existing = this.current.get(symbol);

    if (existing && existing.minute === minute) {
      // Same minute — update last price
      existing.price = price;
      existing.ts = new Date(eventTime);
      return null;
    }

    let flushed: { symbol: string; timestamp: Date; markPrice: number } | null = null;

    if (existing && existing.minute < minute) {
      // Minute rolled — flush previous
      flushed = {
        symbol,
        timestamp: new Date(existing.minute),
        markPrice: existing.price,
      };
    }

    // Start new minute
    this.current.set(symbol, { minute, price, ts: new Date(eventTime) });
    return flushed;
  }

  getPrevPrice(symbol: string): number | null {
    return this.prevPrices.get(symbol) ?? null;
  }

  setPrevPrice(symbol: string, price: number): void {
    this.prevPrices.set(symbol, price);
  }
}

// ---------------------------------------------------------------------------
// WebSocket Manager
// ---------------------------------------------------------------------------

class ReconnectingWebSocket {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private closed = false;
  private lastPong = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly url: string,
    private readonly label: string,
    private readonly onMessage: (data: unknown) => void,
    private readonly baseDelayMs: number,
    private readonly maxDelayMs: number,
    private readonly heartbeatMs: number,
  ) {}

  connect(): void {
    if (this.closed) return;

    log.info({ url: this.url, label: this.label }, 'WS connecting');
    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      log.info({ label: this.label }, 'WS connected');
      this.reconnectAttempt = 0;
      this.lastPong = Date.now();
      this.startHeartbeat();
    });

    this.ws.on('message', (raw: Buffer) => {
      try {
        const parsed = JSON.parse(raw.toString());
        this.onMessage(parsed);
      } catch (err) {
        log.warn({ label: this.label, err: (err as Error).message }, 'WS message parse error');
      }
    });

    this.ws.on('pong', () => {
      this.lastPong = Date.now();
    });

    this.ws.on('close', (code, reason) => {
      log.warn({ label: this.label, code, reason: reason.toString() }, 'WS closed');
      this.stopHeartbeat();
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      log.error({ label: this.label, err: err.message }, 'WS error');
      // 'close' event will fire after error, triggering reconnect
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

      // Check if pong was received within 2x heartbeat interval
      if (Date.now() - this.lastPong > this.heartbeatMs * 2) {
        log.warn({ label: this.label }, 'WS heartbeat timeout, forcing reconnect');
        this.ws.terminate();
        return;
      }

      this.ws.ping();
    }, this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;

    const delay = Math.min(
      this.baseDelayMs * Math.pow(2, this.reconnectAttempt),
      this.maxDelayMs,
    );
    this.reconnectAttempt++;
    log.info({ label: this.label, delay, attempt: this.reconnectAttempt }, 'WS scheduling reconnect');

    setTimeout(() => this.connect(), delay);
  }

  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.terminate();
      this.ws = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Live Ingestion Engine
// ---------------------------------------------------------------------------

export class LiveIngestionEngine {
  private readonly config: IngestionConfig;
  private readonly bucket = new MarkPriceBucket();
  private markPriceWs: ReconnectingWebSocket | null = null;
  private liquidationWs: ReconnectingWebSocket | null = null;
  private oiTimer: ReturnType<typeof setInterval> | null = null;
  private fundingTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  // Counters for observability
  private stats = {
    markPriceTicks: 0,
    markPriceRows: 0,
    liquidations: 0,
    oiPolls: 0,
    fundingPolls: 0,
    validationRejects: 0,
  };

  constructor(config: Partial<IngestionConfig> = {}) {
    this.config = {
      symbols: config.symbols ?? ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
      oiIntervalMs: config.oiIntervalMs ?? 60_000,
      fundingIntervalMs: config.fundingIntervalMs ?? 60_000,
      wsReconnectBaseMs: config.wsReconnectBaseMs ?? 1_000,
      wsReconnectMaxMs: config.wsReconnectMaxMs ?? 60_000,
      wsHeartbeatMs: config.wsHeartbeatMs ?? 30_000,
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    await ensureHistoricalSchema();
    log.info({ symbols: this.config.symbols }, 'Live ingestion starting');

    this.startMarkPriceStream();
    this.startLiquidationStream();
    this.startOiPolling();
    this.startFundingPolling();

    // Log stats every 60 seconds
    setInterval(() => {
      log.info({ ...this.stats }, 'Ingestion stats');
    }, 60_000);
  }

  stop(): void {
    this.running = false;
    this.markPriceWs?.close();
    this.liquidationWs?.close();
    if (this.oiTimer) clearInterval(this.oiTimer);
    if (this.fundingTimer) clearInterval(this.fundingTimer);
    log.info('Live ingestion stopped');
  }

  getStats(): typeof this.stats {
    return { ...this.stats };
  }

  // -------------------------------------------------------------------------
  // 1. Mark Price WebSocket
  // -------------------------------------------------------------------------

  private startMarkPriceStream(): void {
    // Subscribe to all mark price updates (1s interval)
    const streams = this.config.symbols.map((s) => `${s.toLowerCase()}@markPrice@1s`);
    const url = `${BINANCE_WS_BASE}/stream?streams=${streams.join('/')}`;

    this.markPriceWs = new ReconnectingWebSocket(
      url,
      'markPrice',
      (data) => this.handleMarkPriceMessage(data),
      this.config.wsReconnectBaseMs,
      this.config.wsReconnectMaxMs,
      this.config.wsHeartbeatMs,
    );
    this.markPriceWs.connect();
  }

  private async handleMarkPriceMessage(data: unknown): Promise<void> {
    try {
      const wrapper = data as { stream?: string; data?: BinanceMarkPriceWs };
      const msg = wrapper.data ?? (data as BinanceMarkPriceWs);
      if (msg.e !== 'markPriceUpdate') return;

      const symbol = msg.s;
      const price = toFinite(msg.p);
      const eventTime = msg.E;

      if (!Number.isFinite(price) || price <= 0) return;
      this.stats.markPriceTicks++;

      const flushed = this.bucket.ingest(symbol, price, eventTime);
      if (!flushed) return;

      // Validate before insert
      const prevPrice = this.bucket.getPrevPrice(symbol);
      const vResult = validateMarkPrice(flushed.markPrice, flushed.timestamp, prevPrice);
      if (!vResult.valid) {
        this.stats.validationRejects++;
        log.warn({ symbol, reason: vResult.reason }, 'Mark price tick rejected');
        return;
      }

      this.bucket.setPrevPrice(symbol, flushed.markPrice);
      await insertOneMarkPrice(flushed.symbol, flushed.timestamp, flushed.markPrice);
      this.stats.markPriceRows++;
    } catch (err) {
      log.error({ err: (err as Error).message }, 'Mark price handler error');
    }
  }

  // -------------------------------------------------------------------------
  // 2. Liquidation WebSocket
  // -------------------------------------------------------------------------

  private startLiquidationStream(): void {
    // All liquidation events across all symbols
    const url = `${BINANCE_WS_BASE}/ws/!forceOrder@arr`;

    this.liquidationWs = new ReconnectingWebSocket(
      url,
      'liquidations',
      (data) => this.handleLiquidationMessage(data),
      this.config.wsReconnectBaseMs,
      this.config.wsReconnectMaxMs,
      this.config.wsHeartbeatMs,
    );
    this.liquidationWs.connect();
  }

  private async handleLiquidationMessage(data: unknown): Promise<void> {
    try {
      const msg = data as BinanceForceOrder;
      if (msg.e !== 'forceOrder') return;

      const o = msg.o;
      const symbol = o.s;

      // Only process symbols we're tracking
      if (!this.config.symbols.includes(symbol)) return;

      const side = o.S as 'BUY' | 'SELL';
      const price = toFinite(o.ap); // average price
      const quantity = toFinite(o.z); // cumulative filled qty
      const tradeTime = o.T;
      const usdValue = price * quantity;

      // Validate
      const vResult = validateLiquidation(price, quantity, usdValue, side, new Date(tradeTime));
      if (!vResult.valid) {
        this.stats.validationRejects++;
        log.warn({ symbol, reason: vResult.reason }, 'Liquidation rejected');
        return;
      }

      // Deterministic ID to prevent duplicates from reconnects
      const id = `${symbol}:${side}:${tradeTime}`;

      const row: LiquidationRow = {
        id,
        symbol,
        side,
        price,
        quantity,
        usd_value: usdValue,
        timestamp: new Date(tradeTime),
      };

      await insertOneLiquidation(row);
      this.stats.liquidations++;
    } catch (err) {
      log.error({ err: (err as Error).message }, 'Liquidation handler error');
    }
  }

  // -------------------------------------------------------------------------
  // 3. Open Interest Polling (every 1 minute)
  // -------------------------------------------------------------------------

  private startOiPolling(): void {
    const poll = async () => {
      for (const symbol of this.config.symbols) {
        try {
          const resp = await axios.get<{ openInterest: string; symbol: string; time: number }>(
            `${BINANCE_REST_BASE}/fapi/v1/openInterest`,
            { params: { symbol }, timeout: 5_000 },
          );

          const oiContracts = toFinite(resp.data.openInterest);
          if (!Number.isFinite(oiContracts) || oiContracts < 0) continue;

          // Get current price for USD conversion
          const priceResp = await axios.get<{ price: string }>(
            `${BINANCE_REST_BASE}/fapi/v1/ticker/price`,
            { params: { symbol }, timeout: 5_000 },
          );
          const price = toFinite(priceResp.data.price);
          if (!Number.isFinite(price) || price <= 0) continue;

          const oiUsd = oiContracts * price;
          const now = new Date();

          const vResult = validateOpenInterest(oiUsd, now);
          if (!vResult.valid) {
            this.stats.validationRejects++;
            log.warn({ symbol, reason: vResult.reason }, 'OI rejected');
            continue;
          }

          // Bucket to nearest minute
          const minuteTs = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
          await insertOneOpenInterest(symbol, minuteTs, oiUsd);
          this.stats.oiPolls++;
        } catch (err) {
          log.error({ symbol, err: (err as Error).message }, 'OI poll error');
        }
      }
    };

    // Poll immediately, then on interval
    poll();
    this.oiTimer = setInterval(poll, this.config.oiIntervalMs);
  }

  // -------------------------------------------------------------------------
  // 4. Funding Rate Polling (every 1 minute, captures 8h boundary)
  // -------------------------------------------------------------------------

  private startFundingPolling(): void {
    const poll = async () => {
      for (const symbol of this.config.symbols) {
        try {
          const resp = await axios.get<Array<{
            symbol: string;
            fundingRate: string;
            fundingTime: number;
            markPrice: string;
          }>>(
            `${BINANCE_REST_BASE}/fapi/v1/fundingRate`,
            { params: { symbol, limit: 1 }, timeout: 5_000 },
          );

          if (resp.data.length === 0) continue;

          const latest = resp.data[0];
          const rate = toFinite(latest.fundingRate);
          const fundingTime = new Date(latest.fundingTime);

          const vResult = validateFundingRate(rate, fundingTime);
          if (!vResult.valid) {
            this.stats.validationRejects++;
            log.warn({ symbol, reason: vResult.reason }, 'Funding rate rejected');
            continue;
          }

          // ON CONFLICT DO NOTHING handles duplicates
          await insertOneFundingRate(symbol, fundingTime, rate);
          this.stats.fundingPolls++;
        } catch (err) {
          log.error({ symbol, err: (err as Error).message }, 'Funding poll error');
        }
      }
    };

    // Poll immediately, then on interval
    poll();
    this.fundingTimer = setInterval(poll, this.config.fundingIntervalMs);
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const symbols = args.length > 0
    ? args.map((s) => s.toUpperCase())
    : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

  const engine = new LiveIngestionEngine({ symbols });
  await engine.start();

  // Graceful shutdown
  const shutdown = async () => {
    log.info('Shutting down live ingestion');
    engine.stop();
    await closePool();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  log.info({ symbols }, 'Live ingestion running. Press Ctrl+C to stop.');
}

const isMain = process.argv[1]?.includes('ingest');
if (isMain) {
  main().catch((err) => {
    log.error({ err: err instanceof Error ? err.message : err }, 'Ingestion failed');
    process.exit(1);
  });
}
