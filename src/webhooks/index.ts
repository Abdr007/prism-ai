import crypto from 'crypto';
import axios from 'axios';
import type { CascadeRisk } from '../predictor/index.js';
import type { AggregatedData } from '../aggregator/index.js';

export interface WebhookConfig {
  id: string;
  exchangeId: string;
  url: string;
  events: ('data' | 'risk' | 'alert')[];
  symbols?: string[];
  minRiskLevel?: 'low' | 'moderate' | 'elevated' | 'high' | 'critical';
  headers?: Record<string, string>;
  secret?: string;
  enabled: boolean;
  createdAt: number;
  lastTriggered?: number;
  lastStatus?: number;
  failCount: number;
}

export interface WebhookPayload {
  type: 'data' | 'risk' | 'alert';
  timestamp: number;
  payload: unknown;
}

const RISK_LEVELS = ['low', 'moderate', 'elevated', 'high', 'critical'] as const;

export class WebhookManager {
  private webhooks: Map<string, WebhookConfig> = new Map();
  private maxRetries = 3;
  private retryDelayMs = 1000;

  // Register a new webhook
  register(exchangeId: string, config: Omit<WebhookConfig, 'id' | 'exchangeId' | 'createdAt' | 'failCount' | 'enabled'>): WebhookConfig {
    const id = `wh_${crypto.randomBytes(12).toString('hex')}`;

    const webhook: WebhookConfig = {
      id,
      exchangeId,
      url: config.url,
      events: config.events,
      symbols: config.symbols,
      minRiskLevel: config.minRiskLevel || 'elevated',
      headers: config.headers,
      secret: config.secret || crypto.randomBytes(32).toString('hex'),
      enabled: true,
      createdAt: Date.now(),
      failCount: 0,
    };

    this.webhooks.set(id, webhook);
    return webhook;
  }

  // Get webhook by ID
  get(id: string): WebhookConfig | undefined {
    return this.webhooks.get(id);
  }

  // Get all webhooks for an exchange
  getByExchange(exchangeId: string): WebhookConfig[] {
    return Array.from(this.webhooks.values())
      .filter(w => w.exchangeId === exchangeId);
  }

  // Update webhook
  update(id: string, updates: Partial<Pick<WebhookConfig, 'url' | 'events' | 'symbols' | 'minRiskLevel' | 'headers' | 'enabled'>>): WebhookConfig | null {
    const webhook = this.webhooks.get(id);
    if (!webhook) return null;

    Object.assign(webhook, updates);
    return webhook;
  }

  // Delete webhook
  delete(id: string): boolean {
    return this.webhooks.delete(id);
  }

  // Generate signature for payload
  private sign(payload: string, secret: string): string {
    return crypto.createHmac('sha256', secret).update(payload).digest('hex');
  }

  // Send webhook with retry
  private async send(webhook: WebhookConfig, payload: WebhookPayload): Promise<{ success: boolean; statusCode?: number; error?: string }> {
    const timestamp = Date.now().toString();
    const body = JSON.stringify(payload);
    const signature = webhook.secret ? this.sign(`${timestamp}.${body}`, webhook.secret) : undefined;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Prism-Timestamp': timestamp,
      'X-Prism-Event': payload.type,
      ...webhook.headers,
    };

    if (signature) {
      headers['X-Prism-Signature'] = signature;
    }

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await axios.post(webhook.url, payload, {
          headers,
          timeout: 10000,
        });

        webhook.lastTriggered = Date.now();
        webhook.lastStatus = response.status;
        webhook.failCount = 0;

        return { success: true, statusCode: response.status };
      } catch (error) {
        if (attempt === this.maxRetries - 1) {
          webhook.failCount++;

          // Disable webhook after 10 consecutive failures
          if (webhook.failCount >= 10) {
            webhook.enabled = false;
          }

          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          };
        }

        await new Promise(resolve => setTimeout(resolve, this.retryDelayMs * (attempt + 1)));
      }
    }

    return { success: false, error: 'Max retries exceeded' };
  }

  // Test webhook endpoint
  async test(id: string): Promise<{ success: boolean; statusCode?: number; responseTime?: number; error?: string }> {
    const webhook = this.webhooks.get(id);
    if (!webhook) {
      return { success: false, error: 'Webhook not found' };
    }

    const startTime = Date.now();

    const payload: WebhookPayload = {
      type: 'alert',
      timestamp: Date.now(),
      payload: {
        test: true,
        message: 'This is a test webhook from Prism',
      },
    };

    const result = await this.send(webhook, payload);

    return {
      ...result,
      responseTime: Date.now() - startTime,
    };
  }

  // Dispatch data to all relevant webhooks
  async dispatchData(data: AggregatedData): Promise<void> {
    const webhooks = Array.from(this.webhooks.values())
      .filter(w => w.enabled && w.events.includes('data'));

    const payload: WebhookPayload = {
      type: 'data',
      timestamp: Date.now(),
      payload: data,
    };

    await Promise.allSettled(
      webhooks.map(w => this.send(w, this.filterPayload(w, payload, data.symbols)))
    );
  }

  // Dispatch risk updates to all relevant webhooks
  async dispatchRisk(risks: CascadeRisk[]): Promise<void> {
    const webhooks = Array.from(this.webhooks.values())
      .filter(w => w.enabled && w.events.includes('risk'));

    for (const webhook of webhooks) {
      const filteredRisks = this.filterRisks(webhook, risks);
      if (filteredRisks.length === 0) continue;

      const payload: WebhookPayload = {
        type: 'risk',
        timestamp: Date.now(),
        payload: filteredRisks,
      };

      await this.send(webhook, payload);
    }
  }

  // Dispatch alerts to all relevant webhooks
  async dispatchAlert(risks: CascadeRisk[]): Promise<void> {
    const webhooks = Array.from(this.webhooks.values())
      .filter(w => w.enabled && w.events.includes('alert'));

    for (const webhook of webhooks) {
      const filteredRisks = this.filterRisks(webhook, risks);
      const alertRisks = filteredRisks.filter(r =>
        r.riskLevel === 'critical' || r.riskLevel === 'high' || r.riskLevel === 'elevated'
      );

      if (alertRisks.length === 0) continue;

      const payload: WebhookPayload = {
        type: 'alert',
        timestamp: Date.now(),
        payload: {
          level: alertRisks[0]?.riskLevel || 'elevated',
          count: alertRisks.length,
          risks: alertRisks.map(r => ({
            symbol: r.symbol,
            riskScore: r.riskScore,
            riskLevel: r.riskLevel,
            prediction: r.prediction,
          })),
        },
      };

      await this.send(webhook, payload);
    }
  }

  // Filter payload by webhook's symbol preferences
  private filterPayload(webhook: WebhookConfig, payload: WebhookPayload, symbols: string[]): WebhookPayload {
    if (!webhook.symbols || webhook.symbols.length === 0) {
      return payload;
    }

    // Filter to only requested symbols
    const filteredSymbols = symbols.filter(s =>
      webhook.symbols!.includes(s.toUpperCase())
    );

    return {
      ...payload,
      payload: {
        ...(payload.payload as Record<string, unknown>),
        symbols: filteredSymbols,
      },
    };
  }

  // Filter risks by webhook's preferences
  private filterRisks(webhook: WebhookConfig, risks: CascadeRisk[]): CascadeRisk[] {
    let filtered = risks;

    // Filter by symbols
    if (webhook.symbols && webhook.symbols.length > 0) {
      const upperSymbols = webhook.symbols.map(s => s.toUpperCase());
      filtered = filtered.filter(r => upperSymbols.includes(r.symbol));
    }

    // Filter by minimum risk level
    if (webhook.minRiskLevel) {
      const minLevelIndex = RISK_LEVELS.indexOf(webhook.minRiskLevel);
      filtered = filtered.filter(r => {
        const riskLevelIndex = RISK_LEVELS.indexOf(r.riskLevel);
        return riskLevelIndex >= minLevelIndex;
      });
    }

    return filtered;
  }

  // Get stats
  getStats(): { total: number; enabled: number; disabled: number } {
    const all = Array.from(this.webhooks.values());
    return {
      total: all.length,
      enabled: all.filter(w => w.enabled).length,
      disabled: all.filter(w => !w.enabled).length,
    };
  }
}

// Singleton instance
export const webhookManager = new WebhookManager();
