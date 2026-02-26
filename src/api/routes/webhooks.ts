import { Router, type Request, type Response } from 'express';
import { webhookManager } from '../../webhooks/index.js';
import type { Exchange } from '../../onboarding/index.js';

const router = Router();

// Helper to safely get string param (handles string | string[])
const getParam = (param: string | string[] | undefined): string => {
  if (Array.isArray(param)) return param[0];
  return param || '';
};

// Type for request with exchange attached
interface AuthenticatedRequest extends Request {
  exchange?: Exchange;
}

// ============ Webhook Management (Client) ============

// List webhooks for authenticated exchange
router.get('/', (req: AuthenticatedRequest, res: Response) => {
  if (!req.exchange) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const webhooks = webhookManager.getByExchange(req.exchange.id);

  res.json({
    success: true,
    webhooks: webhooks.map(w => ({
      id: w.id,
      url: w.url,
      events: w.events,
      symbols: w.symbols,
      minRiskLevel: w.minRiskLevel,
      enabled: w.enabled,
      createdAt: w.createdAt,
      lastTriggered: w.lastTriggered,
      lastStatus: w.lastStatus,
      failCount: w.failCount,
    })),
  });
});

// Register new webhook
router.post('/', (req: AuthenticatedRequest, res: Response) => {
  if (!req.exchange) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const { url, events, symbols, minRiskLevel, headers, secret } = req.body;

  if (!url || !events || !Array.isArray(events)) {
    res.status(400).json({
      success: false,
      error: 'url and events[] are required',
    });
    return;
  }

  // Validate URL
  try {
    new URL(url);
  } catch {
    res.status(400).json({
      success: false,
      error: 'Invalid URL format',
    });
    return;
  }

  // Validate events
  const validEvents = ['data', 'risk', 'alert'];
  if (!events.every((e: string) => validEvents.includes(e))) {
    res.status(400).json({
      success: false,
      error: `Invalid events. Valid: ${validEvents.join(', ')}`,
    });
    return;
  }

  // Validate symbols if provided
  if (symbols && !Array.isArray(symbols)) {
    res.status(400).json({
      success: false,
      error: 'symbols must be an array',
    });
    return;
  }

  // Limit webhooks per exchange
  const existingWebhooks = webhookManager.getByExchange(req.exchange.id);
  if (existingWebhooks.length >= 10) {
    res.status(400).json({
      success: false,
      error: 'Maximum 10 webhooks per exchange',
    });
    return;
  }

  const webhook = webhookManager.register(req.exchange.id, {
    url,
    events,
    symbols,
    minRiskLevel,
    headers,
    secret,
  });

  res.status(201).json({
    success: true,
    webhook: {
      id: webhook.id,
      url: webhook.url,
      events: webhook.events,
      symbols: webhook.symbols,
      minRiskLevel: webhook.minRiskLevel,
      enabled: webhook.enabled,
      secret: webhook.secret, // Only shown once!
      createdAt: webhook.createdAt,
    },
    message: 'Save the webhook secret - it will not be shown again!',
  });
});

// Get webhook by ID
router.get('/:id', (req: AuthenticatedRequest, res: Response) => {
  if (!req.exchange) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const webhook = webhookManager.get(getParam(req.params.id));

  if (!webhook || webhook.exchangeId !== req.exchange.id) {
    res.status(404).json({ success: false, error: 'Webhook not found' });
    return;
  }

  res.json({
    success: true,
    webhook: {
      id: webhook.id,
      url: webhook.url,
      events: webhook.events,
      symbols: webhook.symbols,
      minRiskLevel: webhook.minRiskLevel,
      enabled: webhook.enabled,
      createdAt: webhook.createdAt,
      lastTriggered: webhook.lastTriggered,
      lastStatus: webhook.lastStatus,
      failCount: webhook.failCount,
    },
  });
});

// Update webhook
router.patch('/:id', (req: AuthenticatedRequest, res: Response) => {
  if (!req.exchange) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const webhook = webhookManager.get(getParam(req.params.id));

  if (!webhook || webhook.exchangeId !== req.exchange.id) {
    res.status(404).json({ success: false, error: 'Webhook not found' });
    return;
  }

  const { url, events, symbols, minRiskLevel, headers, enabled } = req.body;

  // Validate URL if provided
  if (url) {
    try {
      new URL(url);
    } catch {
      res.status(400).json({ success: false, error: 'Invalid URL format' });
      return;
    }
  }

  // Validate events if provided
  if (events) {
    const validEvents = ['data', 'risk', 'alert'];
    if (!Array.isArray(events) || !events.every((e: string) => validEvents.includes(e))) {
      res.status(400).json({
        success: false,
        error: `Invalid events. Valid: ${validEvents.join(', ')}`,
      });
      return;
    }
  }

  const updated = webhookManager.update(getParam(req.params.id), {
    url,
    events,
    symbols,
    minRiskLevel,
    headers,
    enabled,
  });

  res.json({
    success: true,
    webhook: {
      id: updated!.id,
      url: updated!.url,
      events: updated!.events,
      symbols: updated!.symbols,
      minRiskLevel: updated!.minRiskLevel,
      enabled: updated!.enabled,
    },
  });
});

// Delete webhook
router.delete('/:id', (req: AuthenticatedRequest, res: Response) => {
  if (!req.exchange) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const webhook = webhookManager.get(getParam(req.params.id));

  if (!webhook || webhook.exchangeId !== req.exchange.id) {
    res.status(404).json({ success: false, error: 'Webhook not found' });
    return;
  }

  webhookManager.delete(getParam(req.params.id));

  res.json({ success: true, message: 'Webhook deleted' });
});

// Test webhook
router.post('/:id/test', async (req: AuthenticatedRequest, res: Response) => {
  if (!req.exchange) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const webhook = webhookManager.get(getParam(req.params.id));

  if (!webhook || webhook.exchangeId !== req.exchange.id) {
    res.status(404).json({ success: false, error: 'Webhook not found' });
    return;
  }

  const result = await webhookManager.test(getParam(req.params.id));

  res.json({
    success: result.success,
    statusCode: result.statusCode,
    responseTime: result.responseTime,
    error: result.error,
  });
});

export default router;
