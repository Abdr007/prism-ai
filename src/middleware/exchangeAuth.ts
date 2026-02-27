import type { Request, Response, NextFunction } from 'express';
import { exchangeManager, type Exchange } from '../onboarding/index.js';
import { logger as rootLogger } from '../lib/logger.js';

const log = rootLogger.child({ component: 'exchange-auth' });

// Rate limiting tracking per exchange
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

// Extend Request type
declare global {
  namespace Express {
    interface Request {
      exchange?: Exchange;
    }
  }
}

// Check rate limit for exchange
function checkRateLimit(exchangeId: string, limit: number): { allowed: boolean; remaining: number; resetIn: number } {
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute window

  let rateData = rateLimitMap.get(exchangeId);

  if (!rateData || now > rateData.resetAt) {
    rateData = { count: 0, resetAt: now + windowMs };
    rateLimitMap.set(exchangeId, rateData);
  }

  const remaining = Math.max(0, limit - rateData.count);
  const resetIn = Math.ceil((rateData.resetAt - now) / 1000);

  if (rateData.count >= limit) {
    return { allowed: false, remaining: 0, resetIn };
  }

  rateData.count++;
  return { allowed: true, remaining: remaining - 1, resetIn };
}

// Exchange authentication middleware
export function exchangeAuth(options: { optional?: boolean; checkSymbol?: boolean } = {}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // SECURITY: Only accept API key from header (not query params to prevent logging)
    const apiKey = req.headers['x-api-key'] as string;

    // Warn if API key is in query params (don't use it)
    if (req.query.api_key) {
      log.warn({ ip: req.ip }, 'API key passed in query params — ignored for security');
    }

    if (!apiKey) {
      if (options.optional) {
        next();
        return;
      }
      res.status(401).json({
        success: false,
        error: 'API key required. Include X-API-Key header.',
      });
      return;
    }

    // Validate API key with exchange manager
    const validation = exchangeManager.validateApiKey(apiKey);

    if (!validation.valid || !validation.exchange) {
      res.status(401).json({
        success: false,
        error: validation.error || 'Invalid API key',
      });
      return;
    }

    const exchange = validation.exchange;

    // Check rate limit
    const rateCheck = checkRateLimit(exchange.id, exchange.rateLimit);

    // Add rate limit headers
    res.setHeader('X-RateLimit-Limit', exchange.rateLimit.toString());
    res.setHeader('X-RateLimit-Remaining', rateCheck.remaining.toString());
    res.setHeader('X-RateLimit-Reset', rateCheck.resetIn.toString());

    if (!rateCheck.allowed) {
      res.status(429).json({
        success: false,
        error: 'Rate limit exceeded',
        retryAfter: rateCheck.resetIn,
      });
      return;
    }

    // Check symbol access if specified
    if (options.checkSymbol && req.params.symbol) {
      const symbolParam = Array.isArray(req.params.symbol) ? req.params.symbol[0] : req.params.symbol;
      const requestedSymbol = symbolParam.toUpperCase();
      if (!exchange.symbols.includes(requestedSymbol)) {
        res.status(403).json({
          success: false,
          error: `Symbol ${requestedSymbol} not included in your plan. Available: ${exchange.symbols.join(', ')}`,
          upgrade: 'Contact support to upgrade your plan for more symbols.',
        });
        return;
      }
    }

    // Attach exchange to request
    req.exchange = exchange;

    next();
  };
}

// Middleware to filter response data by exchange's allowed symbols
export function filterByPlan(req: Request, res: Response, next: NextFunction): void {
  const originalJson = res.json.bind(res);

  res.json = (body: Record<string, unknown>) => {
    if (!req.exchange) {
      return originalJson(body);
    }

    const allowedSymbols = req.exchange.symbols;

    // Filter risks array if present
    if (Array.isArray(body.risks)) {
      body.risks = (body.risks as Array<{ symbol: string }>).filter(r =>
        allowedSymbols.includes(r.symbol)
      );
    }

    // Filter data metrics if present
    if (body.data && typeof body.data === 'object' && 'metrics' in (body.data as Record<string, unknown>)) {
      const data = body.data as { metrics: Record<string, unknown>; symbols?: string[] };
      const filteredMetrics: Record<string, unknown> = {};
      for (const symbol of allowedSymbols) {
        if (data.metrics[symbol]) {
          filteredMetrics[symbol] = data.metrics[symbol];
        }
      }
      data.metrics = filteredMetrics;
      data.symbols = allowedSymbols;
    }

    // Filter alerts if present
    if (Array.isArray(body.alerts)) {
      body.alerts = (body.alerts as Array<{ symbol: string }>).filter(a =>
        allowedSymbols.includes(a.symbol)
      );
    }

    return originalJson(body);
  };

  next();
}
