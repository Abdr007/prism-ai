import { Router, type Request, type Response } from 'express';
import { exchangeManager, type CreateExchangeInput } from '../../onboarding/index.js';
import { webhookManager, type WebhookConfig } from '../../webhooks/index.js';

import crypto from 'crypto';

const router = Router();

// Helper to safely get string param (handles string | string[])
const getParam = (param: string | string[] | undefined): string => {
  if (Array.isArray(param)) return param[0];
  return param || '';
};

// SECURITY: Generate secure random secret if not provided
const ADMIN_SECRET = process.env.ADMIN_SECRET || crypto.randomBytes(32).toString('hex');

// Timing-safe comparison to prevent timing attacks
function secureCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// Admin auth middleware with timing-safe comparison
function adminAuth(req: Request, res: Response, next: Function) {
  const secret = req.headers['x-admin-secret'];
  if (!secureCompare(String(secret || ''), ADMIN_SECRET)) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }
  next();
}

// ============ Exchange Management ============

// Create new exchange
router.post('/exchanges', adminAuth, (req: Request, res: Response) => {
  try {
    const input: CreateExchangeInput = req.body;

    if (!input.name || !input.email) {
      res.status(400).json({ success: false, error: 'Name and email required' });
      return;
    }

    const exchange = exchangeManager.create(input);

    res.status(201).json({
      success: true,
      exchange: {
        id: exchange.id,
        name: exchange.name,
        email: exchange.email,
        apiKey: exchange.apiKey,
        apiSecret: exchange.apiSecret, // Only shown once!
        plan: exchange.plan,
        rateLimit: exchange.rateLimit,
        symbols: exchange.symbols,
        status: exchange.status,
        createdAt: exchange.createdAt,
      },
      message: 'Save the API secret - it will not be shown again!',
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// List all exchanges
router.get('/exchanges', adminAuth, (req: Request, res: Response) => {
  const exchanges = exchangeManager.list().map(ex => ({
    id: ex.id,
    name: ex.name,
    email: ex.email,
    website: ex.website,
    plan: ex.plan,
    status: ex.status,
    apiKey: exchangeManager.maskApiKey(ex.apiKey),
    rateLimit: ex.rateLimit,
    symbols: ex.symbols,
    createdAt: ex.createdAt,
    lastActive: ex.lastActive,
  }));

  res.json({ success: true, exchanges, stats: exchangeManager.getStats() });
});

// Get exchange by ID
router.get('/exchanges/:id', adminAuth, (req: Request, res: Response) => {
  const exchange = exchangeManager.getById(getParam(req.params.id));

  if (!exchange) {
    res.status(404).json({ success: false, error: 'Exchange not found' });
    return;
  }

  res.json({
    success: true,
    exchange: {
      id: exchange.id,
      name: exchange.name,
      email: exchange.email,
      website: exchange.website,
      plan: exchange.plan,
      status: exchange.status,
      apiKey: exchangeManager.maskApiKey(exchange.apiKey),
      rateLimit: exchange.rateLimit,
      symbols: exchange.symbols,
      createdAt: exchange.createdAt,
      lastActive: exchange.lastActive,
      metadata: exchange.metadata,
    },
  });
});

// Update exchange
router.patch('/exchanges/:id', adminAuth, (req: Request, res: Response) => {
  const updated = exchangeManager.update(getParam(req.params.id), req.body);

  if (!updated) {
    res.status(404).json({ success: false, error: 'Exchange not found' });
    return;
  }

  res.json({ success: true, exchange: updated });
});

// Rotate API key
router.post('/exchanges/:id/rotate-key', adminAuth, (req: Request, res: Response) => {
  const newKeys = exchangeManager.rotateApiKey(getParam(req.params.id));

  if (!newKeys) {
    res.status(404).json({ success: false, error: 'Exchange not found' });
    return;
  }

  res.json({
    success: true,
    ...newKeys,
    message: 'Save the new API secret - it will not be shown again!',
  });
});

// Suspend exchange
router.post('/exchanges/:id/suspend', adminAuth, (req: Request, res: Response) => {
  const { reason } = req.body;
  const success = exchangeManager.suspend(getParam(req.params.id), reason);

  if (!success) {
    res.status(404).json({ success: false, error: 'Exchange not found' });
    return;
  }

  res.json({ success: true, message: 'Exchange suspended' });
});

// Reactivate exchange
router.post('/exchanges/:id/reactivate', adminAuth, (req: Request, res: Response) => {
  const success = exchangeManager.reactivate(getParam(req.params.id));

  if (!success) {
    res.status(404).json({ success: false, error: 'Exchange not found' });
    return;
  }

  res.json({ success: true, message: 'Exchange reactivated' });
});

// Delete exchange
router.delete('/exchanges/:id', adminAuth, (req: Request, res: Response) => {
  const success = exchangeManager.delete(getParam(req.params.id));

  if (!success) {
    res.status(404).json({ success: false, error: 'Exchange not found' });
    return;
  }

  res.json({ success: true, message: 'Exchange deleted' });
});

// ============ Webhook Management (Admin) ============

// Get all webhooks
router.get('/webhooks', adminAuth, (req: Request, res: Response) => {
  const exchangeId = req.query.exchangeId as string | undefined;

  let webhooks: WebhookConfig[];
  if (exchangeId) {
    webhooks = webhookManager.getByExchange(exchangeId);
  } else {
    // Get all webhooks (admin only)
    webhooks = Array.from((webhookManager as any).webhooks.values());
  }

  res.json({
    success: true,
    webhooks: webhooks.map(w => ({
      ...w,
      secret: undefined, // Don't expose secrets
    })),
    stats: webhookManager.getStats(),
  });
});

export default router;
