/**
 * Phase 8 — Observability & Monitoring
 *
 * - Latency measurement per exchange
 * - Error rate tracking
 * - Health endpoint data
 * - No console.log — structured logging only
 */

import { logger as rootLogger } from '../lib/logger.js';
import type { BaseExchangeClient, ExchangeHealth } from '../exchanges/base.js';

const log = rootLogger.child({ component: 'observability' });

// ---------------------------------------------------------------------------
// Exchange Latency Tracker
// ---------------------------------------------------------------------------

interface LatencyBucket {
  exchange: string;
  samples: number[];
  maxSamples: number;
  errorCount: number;
  successCount: number;
  lastError: string | null;
  lastErrorAt: number;
}

export class ExchangeMetrics {
  private buckets: Map<string, LatencyBucket> = new Map();
  private readonly maxSamples: number;

  constructor(maxSamples = 100) {
    this.maxSamples = maxSamples;
  }

  recordSuccess(exchange: string, latencyMs: number): void {
    const bucket = this.getOrCreate(exchange);
    bucket.samples.push(latencyMs);
    if (bucket.samples.length > bucket.maxSamples) bucket.samples.shift();
    bucket.successCount++;
  }

  recordError(exchange: string, error: string): void {
    const bucket = this.getOrCreate(exchange);
    bucket.errorCount++;
    bucket.lastError = error;
    bucket.lastErrorAt = Date.now();
  }

  getStats(exchange: string): ExchangeLatencyStats {
    const bucket = this.buckets.get(exchange);
    if (!bucket || bucket.samples.length === 0) {
      return {
        exchange,
        p50: 0,
        p95: 0,
        p99: 0,
        avg: 0,
        min: 0,
        max: 0,
        sampleCount: 0,
        errorCount: bucket?.errorCount ?? 0,
        successCount: bucket?.successCount ?? 0,
        errorRate: 0,
        lastError: bucket?.lastError ?? null,
        lastErrorAt: bucket?.lastErrorAt ?? 0,
      };
    }

    const sorted = [...bucket.samples].sort((a, b) => a - b);
    const total = bucket.successCount + bucket.errorCount;

    return {
      exchange,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      avg: sorted.reduce((s, v) => s + v, 0) / sorted.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      sampleCount: sorted.length,
      errorCount: bucket.errorCount,
      successCount: bucket.successCount,
      errorRate: total > 0 ? bucket.errorCount / total : 0,
      lastError: bucket.lastError,
      lastErrorAt: bucket.lastErrorAt,
    };
  }

  getAllStats(): ExchangeLatencyStats[] {
    return Array.from(this.buckets.keys()).map((e) => this.getStats(e));
  }

  private getOrCreate(exchange: string): LatencyBucket {
    let bucket = this.buckets.get(exchange);
    if (!bucket) {
      bucket = {
        exchange,
        samples: [],
        maxSamples: this.maxSamples,
        errorCount: 0,
        successCount: 0,
        lastError: null,
        lastErrorAt: 0,
      };
      this.buckets.set(exchange, bucket);
    }
    return bucket;
  }
}

export interface ExchangeLatencyStats {
  exchange: string;
  p50: number;
  p95: number;
  p99: number;
  avg: number;
  min: number;
  max: number;
  sampleCount: number;
  errorCount: number;
  successCount: number;
  errorRate: number;
  lastError: string | null;
  lastErrorAt: number;
}

// ---------------------------------------------------------------------------
// Health Check
// ---------------------------------------------------------------------------

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  timestamp: string;
  exchanges: ExchangeHealthEntry[];
  websocket: {
    connected: boolean;
    clientCount: number;
  };
  riskEngine: {
    lastComputeAt: number;
    symbolCount: number;
  };
  latency: ExchangeLatencyStats[];
}

export interface ExchangeHealthEntry {
  name: string;
  status: 'up' | 'degraded' | 'down';
  consecutiveFailures: number;
  lastSuccessAt: number;
  isRateLimited: boolean;
  lastLatencyMs: number;
}

const startTime = Date.now();

export function buildHealthStatus(
  exchangeClients: BaseExchangeClient[],
  wsClientCount: number,
  lastRiskComputeAt: number,
  symbolCount: number,
  metrics: ExchangeMetrics,
): HealthStatus {
  const exchanges: ExchangeHealthEntry[] = exchangeClients.map((c) => {
    const h = c.getHealth();
    let status: ExchangeHealthEntry['status'] = 'up';
    if (h.consecutiveFailures >= 5) status = 'down';
    else if (h.consecutiveFailures >= 2 || h.isRateLimited) status = 'degraded';

    return {
      name: h.exchange,
      status,
      consecutiveFailures: h.consecutiveFailures,
      lastSuccessAt: h.lastSuccessAt,
      isRateLimited: h.isRateLimited,
      lastLatencyMs: h.lastLatencyMs,
    };
  });

  const downCount = exchanges.filter((e) => e.status === 'down').length;
  const totalExchanges = exchanges.length;

  let overallStatus: HealthStatus['status'] = 'healthy';
  if (downCount > totalExchanges * 0.5) overallStatus = 'unhealthy';
  else if (downCount > 0) overallStatus = 'degraded';

  return {
    status: overallStatus,
    uptime: Date.now() - startTime,
    timestamp: new Date().toISOString(),
    exchanges,
    websocket: {
      connected: wsClientCount > 0,
      clientCount: wsClientCount,
    },
    riskEngine: {
      lastComputeAt: lastRiskComputeAt,
      symbolCount,
    },
    latency: metrics.getAllStats(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}
