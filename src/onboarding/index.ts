import crypto from 'crypto';

export interface Exchange {
  id: string;
  name: string;
  email: string;
  website?: string;
  apiKey: string;
  apiSecret: string;
  plan: 'starter' | 'growth' | 'enterprise';
  status: 'pending' | 'active' | 'suspended';
  rateLimit: number;
  symbols: string[];
  createdAt: number;
  lastActive?: number;
  metadata?: Record<string, unknown>;
}

export interface CreateExchangeInput {
  name: string;
  email: string;
  website?: string;
  plan?: 'starter' | 'growth' | 'enterprise';
}

const PLAN_LIMITS = {
  starter: {
    rateLimit: 60,
    symbols: ['BTC', 'ETH', 'SOL']
  },
  growth: {
    rateLimit: 300,
    symbols: ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'ADA', 'AVAX', 'DOGE', 'DOT', 'MATIC']
  },
  enterprise: {
    rateLimit: 1000,
    symbols: [
      'BTC', 'ETH', 'SOL', 'XRP', 'BNB',
      'ADA', 'AVAX', 'DOGE', 'DOT', 'MATIC',
      'LINK', 'LTC', 'ATOM', 'UNI', 'APT',
      'ARB', 'OP', 'INJ', 'SUI', 'SEI',
      'PEPE', 'WIF', 'BONK', 'FET', 'RENDER'
    ]
  },
};

export class ExchangeManager {
  private exchanges: Map<string, Exchange> = new Map();
  private apiKeyIndex: Map<string, string> = new Map(); // apiKey -> exchangeId

  // Create new exchange account
  create(input: CreateExchangeInput): Exchange {
    const id = `ex_${crypto.randomBytes(8).toString('hex')}`;
    const apiKey = `prism_${crypto.randomBytes(24).toString('hex')}`;
    const apiSecret = crypto.randomBytes(32).toString('hex');

    const plan = input.plan || 'starter';
    const planLimits = PLAN_LIMITS[plan];

    const exchange: Exchange = {
      id,
      name: input.name,
      email: input.email,
      website: input.website,
      apiKey,
      apiSecret,
      plan,
      status: 'active',
      rateLimit: planLimits.rateLimit,
      symbols: planLimits.symbols,
      createdAt: Date.now(),
    };

    this.exchanges.set(id, exchange);
    this.apiKeyIndex.set(apiKey, id);

    return exchange;
  }

  // Get exchange by ID
  getById(id: string): Exchange | undefined {
    return this.exchanges.get(id);
  }

  // Get exchange by API key
  getByApiKey(apiKey: string): Exchange | undefined {
    const id = this.apiKeyIndex.get(apiKey);
    if (!id) return undefined;
    return this.exchanges.get(id);
  }

  // Validate API key and return exchange
  validateApiKey(apiKey: string): { valid: boolean; exchange?: Exchange; error?: string } {
    const exchange = this.getByApiKey(apiKey);

    if (!exchange) {
      return { valid: false, error: 'Invalid API key' };
    }

    if (exchange.status === 'suspended') {
      return { valid: false, error: 'Account suspended' };
    }

    if (exchange.status === 'pending') {
      return { valid: false, error: 'Account pending approval' };
    }

    // Update last active
    exchange.lastActive = Date.now();

    return { valid: true, exchange };
  }

  // Update exchange
  update(id: string, updates: Partial<Pick<Exchange, 'name' | 'email' | 'website' | 'plan' | 'status' | 'metadata'>>): Exchange | null {
    const exchange = this.exchanges.get(id);
    if (!exchange) return null;

    // If plan changed, update limits
    if (updates.plan && updates.plan !== exchange.plan) {
      const planLimits = PLAN_LIMITS[updates.plan];
      exchange.rateLimit = planLimits.rateLimit;
      exchange.symbols = planLimits.symbols;
    }

    Object.assign(exchange, updates);
    return exchange;
  }

  // Rotate API key
  rotateApiKey(id: string): { apiKey: string; apiSecret: string } | null {
    const exchange = this.exchanges.get(id);
    if (!exchange) return null;

    // Remove old key from index
    this.apiKeyIndex.delete(exchange.apiKey);

    // Generate new keys
    const newApiKey = `prism_${crypto.randomBytes(24).toString('hex')}`;
    const newApiSecret = crypto.randomBytes(32).toString('hex');

    exchange.apiKey = newApiKey;
    exchange.apiSecret = newApiSecret;

    // Add new key to index
    this.apiKeyIndex.set(newApiKey, id);

    return { apiKey: newApiKey, apiSecret: newApiSecret };
  }

  // Suspend exchange
  suspend(id: string, reason?: string): boolean {
    const exchange = this.exchanges.get(id);
    if (!exchange) return false;

    exchange.status = 'suspended';
    exchange.metadata = { ...exchange.metadata, suspendReason: reason, suspendedAt: Date.now() };

    return true;
  }

  // Reactivate exchange
  reactivate(id: string): boolean {
    const exchange = this.exchanges.get(id);
    if (!exchange) return false;

    exchange.status = 'active';
    delete exchange.metadata?.suspendReason;
    delete exchange.metadata?.suspendedAt;

    return true;
  }

  // Delete exchange
  delete(id: string): boolean {
    const exchange = this.exchanges.get(id);
    if (!exchange) return false;

    this.apiKeyIndex.delete(exchange.apiKey);
    return this.exchanges.delete(id);
  }

  // List all exchanges
  list(): Exchange[] {
    return Array.from(this.exchanges.values());
  }

  // Get stats
  getStats(): {
    total: number;
    active: number;
    suspended: number;
    byPlan: Record<string, number>;
  } {
    const all = Array.from(this.exchanges.values());

    const byPlan: Record<string, number> = { starter: 0, growth: 0, enterprise: 0 };
    for (const ex of all) {
      byPlan[ex.plan]++;
    }

    return {
      total: all.length,
      active: all.filter(e => e.status === 'active').length,
      suspended: all.filter(e => e.status === 'suspended').length,
      byPlan,
    };
  }

  // Generate masked API key for display
  maskApiKey(apiKey: string): string {
    return `${apiKey.substring(0, 10)}...${apiKey.substring(apiKey.length - 4)}`;
  }
}

// Singleton instance
export const exchangeManager = new ExchangeManager();
