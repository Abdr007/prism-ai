import { Router, type Request, type Response } from 'express';
import { exchangeManager, type Exchange } from '../../onboarding/index.js';

const router = Router();

// Type for request with exchange attached
interface AuthenticatedRequest extends Request {
  exchange?: Exchange;
}

// ============ Account Management (Client) ============

// Get current account info
router.get('/', (req: AuthenticatedRequest, res: Response) => {
  if (!req.exchange) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  res.json({
    success: true,
    account: {
      id: req.exchange.id,
      name: req.exchange.name,
      email: req.exchange.email,
      website: req.exchange.website,
      plan: req.exchange.plan,
      status: req.exchange.status,
      apiKey: exchangeManager.maskApiKey(req.exchange.apiKey),
      rateLimit: req.exchange.rateLimit,
      symbols: req.exchange.symbols,
      createdAt: req.exchange.createdAt,
      lastActive: req.exchange.lastActive,
    },
  });
});

// Update account info
router.patch('/', (req: AuthenticatedRequest, res: Response) => {
  if (!req.exchange) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const { name, email, website, metadata } = req.body;

  // Validate email if provided
  if (email && !email.includes('@')) {
    res.status(400).json({ success: false, error: 'Invalid email format' });
    return;
  }

  // Validate website URL if provided
  if (website) {
    try {
      new URL(website);
    } catch {
      res.status(400).json({ success: false, error: 'Invalid website URL' });
      return;
    }
  }

  const updated = exchangeManager.update(req.exchange.id, {
    name,
    email,
    website,
    metadata,
  });

  if (!updated) {
    res.status(500).json({ success: false, error: 'Failed to update account' });
    return;
  }

  res.json({
    success: true,
    account: {
      id: updated.id,
      name: updated.name,
      email: updated.email,
      website: updated.website,
      plan: updated.plan,
      status: updated.status,
    },
  });
});

// Rotate own API key
router.post('/rotate-key', (req: AuthenticatedRequest, res: Response) => {
  if (!req.exchange) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const newKeys = exchangeManager.rotateApiKey(req.exchange.id);

  if (!newKeys) {
    res.status(500).json({ success: false, error: 'Failed to rotate API key' });
    return;
  }

  res.json({
    success: true,
    apiKey: newKeys.apiKey,
    apiSecret: newKeys.apiSecret,
    message: 'Save the new API secret - it will not be shown again! Old credentials are now invalid.',
  });
});

// Get usage stats
router.get('/usage', (req: AuthenticatedRequest, res: Response) => {
  if (!req.exchange) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  // In a real implementation, this would track API usage
  res.json({
    success: true,
    usage: {
      plan: req.exchange.plan,
      rateLimit: req.exchange.rateLimit,
      symbols: req.exchange.symbols,
      currentPeriod: {
        start: new Date().toISOString().split('T')[0],
        requests: 0, // Would be tracked in production
        dataPoints: 0,
        webhookDeliveries: 0,
      },
    },
  });
});

export default router;
