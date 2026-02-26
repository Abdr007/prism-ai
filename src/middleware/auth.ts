import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

// API key storage (in production, use a database)
const apiKeys = new Map<string, ApiKeyData>();

export interface ApiKeyData {
  key: string;
  name: string;
  createdAt: number;
  lastUsed: number;
  requestCount: number;
  rateLimit: number; // requests per minute
  permissions: string[];
}

// Rate limiting tracking
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

// Load API keys from environment
export function loadApiKeysFromEnv(): void {
  const keysEnv = process.env.API_KEYS;
  if (keysEnv) {
    const keys = keysEnv.split(',').map(k => k.trim()).filter(k => k);
    keys.forEach((key, index) => {
      apiKeys.set(key, {
        key,
        name: `API Key ${index + 1}`,
        createdAt: Date.now(),
        lastUsed: 0,
        requestCount: 0,
        rateLimit: 60, // 60 requests per minute
        permissions: ['read'],
      });
    });
    console.log(`[Auth] Loaded ${keys.length} API keys from environment`);
  }
}

// Generate a new API key
export function generateApiKey(name: string): ApiKeyData {
  const key = `prism_${crypto.randomBytes(24).toString('hex')}`;
  const data: ApiKeyData = {
    key,
    name,
    createdAt: Date.now(),
    lastUsed: 0,
    requestCount: 0,
    rateLimit: 60,
    permissions: ['read'],
  };
  apiKeys.set(key, data);
  return data;
}

// Validate API key
export function validateApiKey(key: string): ApiKeyData | null {
  return apiKeys.get(key) || null;
}

// Check rate limit
function checkRateLimit(key: string, limit: number): boolean {
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute window

  let rateData = rateLimitMap.get(key);

  if (!rateData || now > rateData.resetAt) {
    rateData = { count: 0, resetAt: now + windowMs };
    rateLimitMap.set(key, rateData);
  }

  if (rateData.count >= limit) {
    return false;
  }

  rateData.count++;
  return true;
}

// Auth middleware
export function authMiddleware(optional = false) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Skip auth for health check
    if (req.path === '/api/v1/health') {
      next();
      return;
    }

    // If no API keys configured, allow all requests
    if (apiKeys.size === 0) {
      next();
      return;
    }

    // Get API key from header or query
    const apiKey = req.headers['x-api-key'] as string ||
                   req.query.api_key as string;

    if (!apiKey) {
      if (optional) {
        next();
        return;
      }
      res.status(401).json({
        success: false,
        error: 'API key required. Include X-API-Key header or api_key query parameter.',
      });
      return;
    }

    const keyData = validateApiKey(apiKey);

    if (!keyData) {
      res.status(401).json({
        success: false,
        error: 'Invalid API key',
      });
      return;
    }

    // Check rate limit
    if (!checkRateLimit(apiKey, keyData.rateLimit)) {
      res.status(429).json({
        success: false,
        error: 'Rate limit exceeded. Please try again later.',
        retryAfter: 60,
      });
      return;
    }

    // Update usage stats
    keyData.lastUsed = Date.now();
    keyData.requestCount++;

    // Attach key data to request
    (req as Request & { apiKey?: ApiKeyData }).apiKey = keyData;

    next();
  };
}

// Get all API keys (for admin)
export function getAllApiKeys(): ApiKeyData[] {
  return Array.from(apiKeys.values()).map(k => ({
    ...k,
    key: `${k.key.substring(0, 10)}...${k.key.substring(k.key.length - 4)}`, // Mask key
  }));
}

// Revoke API key
export function revokeApiKey(key: string): boolean {
  return apiKeys.delete(key);
}
