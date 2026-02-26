import WebSocket from 'ws';

// ============ Types ============

export interface PrismConfig {
  apiKey: string;
  baseUrl?: string;
  wsUrl?: string;
  onData?: (data: MarketData) => void;
  onRisk?: (risks: CascadeRisk[]) => void;
  onAlert?: (alert: RiskAlert) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Error) => void;
  autoReconnect?: boolean;
  reconnectInterval?: number;
}

export interface MarketData {
  timestamp: number;
  symbols: string[];
  exchanges: string[];
  metrics: Record<string, SymbolMetrics>;
}

export interface SymbolMetrics {
  totalOpenInterestValue: number;
  avgFundingRate: number;
  avgMarkPrice: number;
  priceDeviation: number;
  openInterestByExchange: Record<string, number>;
  fundingRateByExchange: Record<string, number>;
}

export interface CascadeRisk {
  symbol: string;
  riskScore: number;
  riskLevel: 'low' | 'moderate' | 'elevated' | 'high' | 'critical';
  prediction: CascadePrediction | null;
  factors: RiskFactor[];
  timestamp: number;
}

export interface CascadePrediction {
  direction: 'long_squeeze' | 'short_squeeze';
  probability: number;
  estimatedImpact: number;
  triggerPrice: number;
  triggerDistance: number;
  timeWindow: string;
}

export interface RiskFactor {
  name: string;
  score: number;
  weight: number;
  value: number;
  threshold: number;
  description: string;
}

export interface RiskAlert {
  level: 'elevated' | 'high' | 'critical';
  risks: Array<{
    symbol: string;
    riskScore: number;
    riskLevel: string;
    prediction: CascadePrediction | null;
  }>;
  timestamp: number;
}

export interface WebhookConfig {
  url: string;
  events: ('data' | 'risk' | 'alert')[];
  symbols?: string[];
  minRiskLevel?: 'low' | 'moderate' | 'elevated' | 'high' | 'critical';
  headers?: Record<string, string>;
  secret?: string;
}

// ============ SDK Client ============

export class PrismClient {
  private config: Required<PrismConfig>;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isConnected = false;

  constructor(config: PrismConfig) {
    this.config = {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl || 'https://api.prism-ai.io',
      wsUrl: config.wsUrl || 'wss://api.prism-ai.io/ws',
      onData: config.onData || (() => {}),
      onRisk: config.onRisk || (() => {}),
      onAlert: config.onAlert || (() => {}),
      onConnect: config.onConnect || (() => {}),
      onDisconnect: config.onDisconnect || (() => {}),
      onError: config.onError || (() => {}),
      autoReconnect: config.autoReconnect ?? true,
      reconnectInterval: config.reconnectInterval || 5000,
    };
  }

  // ============ REST API Methods ============

  private async fetch<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const url = `${this.config.baseUrl}${endpoint}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': this.config.apiKey,
        ...options?.headers,
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.json();
  }

  /**
   * Get current market data for all symbols
   */
  async getData(): Promise<{ success: boolean; data: MarketData }> {
    return this.fetch('/api/v1/data');
  }

  /**
   * Get cascade risk analysis for all symbols
   */
  async getRisk(): Promise<{ success: boolean; risks: CascadeRisk[] }> {
    return this.fetch('/api/v1/risk');
  }

  /**
   * Get data for a specific symbol
   */
  async getSymbol(symbol: string): Promise<{
    success: boolean;
    symbol: string;
    metrics: SymbolMetrics;
    risk: CascadeRisk;
  }> {
    return this.fetch(`/api/v1/symbols/${symbol.toUpperCase()}`);
  }

  /**
   * Get list of supported symbols
   */
  async getSymbols(): Promise<{ success: boolean; symbols: string[] }> {
    return this.fetch('/api/v1/symbols');
  }

  /**
   * Get active risk alerts
   */
  async getAlerts(): Promise<{
    success: boolean;
    alertCount: number;
    alerts: Array<{
      symbol: string;
      riskLevel: string;
      riskScore: number;
      prediction: CascadePrediction | null;
    }>;
  }> {
    return this.fetch('/api/v1/alerts');
  }

  /**
   * Get historical data for a symbol
   */
  async getHistory(symbol: string, hours = 24): Promise<{
    success: boolean;
    symbol: string;
    hours: number;
    dataPoints: number;
    history: unknown[];
  }> {
    return this.fetch(`/api/v1/history/${symbol.toUpperCase()}?hours=${hours}`);
  }

  /**
   * Get risk score history for a symbol
   */
  async getRiskHistory(symbol: string, hours = 24): Promise<{
    success: boolean;
    symbol: string;
    hours: number;
    dataPoints: number;
    history: unknown[];
  }> {
    return this.fetch(`/api/v1/history/${symbol.toUpperCase()}/risk?hours=${hours}`);
  }

  // ============ Webhook Management ============

  /**
   * Register a webhook endpoint to receive alerts
   */
  async registerWebhook(webhook: WebhookConfig): Promise<{
    success: boolean;
    webhookId: string;
  }> {
    return this.fetch('/api/v1/webhooks', {
      method: 'POST',
      body: JSON.stringify(webhook),
    });
  }

  /**
   * List registered webhooks
   */
  async listWebhooks(): Promise<{
    success: boolean;
    webhooks: Array<WebhookConfig & { id: string; createdAt: number }>;
  }> {
    return this.fetch('/api/v1/webhooks');
  }

  /**
   * Delete a webhook
   */
  async deleteWebhook(webhookId: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/v1/webhooks/${webhookId}`, {
      method: 'DELETE',
    });
  }

  /**
   * Test a webhook endpoint
   */
  async testWebhook(webhookId: string): Promise<{
    success: boolean;
    statusCode: number;
    responseTime: number;
  }> {
    return this.fetch(`/api/v1/webhooks/${webhookId}/test`, {
      method: 'POST',
    });
  }

  // ============ WebSocket Methods ============

  /**
   * Connect to WebSocket for real-time updates
   */
  connect(): void {
    if (this.ws) {
      this.ws.close();
    }

    const wsUrl = `${this.config.wsUrl}?apiKey=${this.config.apiKey}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      this.isConnected = true;
      this.config.onConnect();
    });

    this.ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());

        switch (message.type) {
          case 'data':
            this.config.onData(message.payload);
            break;
          case 'risk':
            this.config.onRisk(message.payload);
            break;
          case 'alert':
            this.config.onAlert(message.payload);
            break;
        }
      } catch {
        // Ignore parse errors
      }
    });

    this.ws.on('close', () => {
      this.isConnected = false;
      this.config.onDisconnect();

      if (this.config.autoReconnect) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (error) => {
      this.config.onError(error);
    });
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.isConnected = false;
  }

  /**
   * Check if WebSocket is connected
   */
  isWebSocketConnected(): boolean {
    return this.isConnected;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.config.reconnectInterval);
  }
}

// ============ Helper Functions ============

/**
 * Format USD value for display
 */
export function formatUSD(value: number): string {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(2)}K`;
  return `$${value.toFixed(2)}`;
}

/**
 * Format funding rate for display
 */
export function formatFundingRate(rate: number): string {
  const pct = (rate * 100).toFixed(4);
  return rate >= 0 ? `+${pct}%` : `${pct}%`;
}

/**
 * Get risk level color
 */
export function getRiskColor(level: CascadeRisk['riskLevel']): string {
  const colors = {
    critical: '#ef4444',
    high: '#f97316',
    elevated: '#f59e0b',
    moderate: '#3b82f6',
    low: '#10b981',
  };
  return colors[level];
}

// ============ Express Middleware ============

/**
 * Express middleware to verify Prism webhook signatures
 */
export function verifyWebhookSignature(secret: string) {
  return (req: any, res: any, next: any) => {
    const signature = req.headers['x-prism-signature'];
    const timestamp = req.headers['x-prism-timestamp'];

    if (!signature || !timestamp) {
      return res.status(401).json({ error: 'Missing signature headers' });
    }

    // Verify timestamp is within 5 minutes
    const now = Date.now();
    const ts = parseInt(timestamp, 10);
    if (Math.abs(now - ts) > 300000) {
      return res.status(401).json({ error: 'Timestamp too old' });
    }

    // Verify signature (HMAC-SHA256)
    const crypto = require('crypto');
    const payload = `${timestamp}.${JSON.stringify(req.body)}`;
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');

    if (signature !== expectedSignature) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    next();
  };
}

// Default export
export default PrismClient;
