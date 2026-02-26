import express, { type Request, type Response, type NextFunction } from 'express';
import { createServer } from 'http';
import {
  BinanceClient,
  BybitClient,
  OKXClient,
  BitgetClient,
  GateIOClient,
  MEXCClient,
  KuCoinClient,
  KrakenClient,
  DYDXClient,
  HyperliquidClient,
  GMXClient,
  JupiterClient,
  FlashClient
} from '../exchanges/index.js';
import { DataAggregator, type AggregatedData } from '../aggregator/index.js';
import { CascadePredictor, type CascadeRisk } from '../predictor/index.js';
import { PrismDB } from '../db/index.js';
import { PrismWebSocket } from '../websocket/index.js';
import { webhookManager } from '../webhooks/index.js';
import { exchangeAuth, filterByPlan } from '../middleware/exchangeAuth.js';
import { applySecurity, bodySanitizer, getSecurityStats, getRecentAuditLog, unblockIp } from '../middleware/security.js';
import { applyAdvancedSecurity, hashPassword, verifyPassword } from '../middleware/advancedSecurity.js';
import { pythOracle } from '../oracle/index.js';
import adminRoutes from './routes/admin.js';
import webhookRoutes from './routes/webhooks.js';
import accountRoutes from './routes/account.js';
import authRoutes from './routes/auth.js';
import stockRoutes from './routes/stocks.js';
import newsRoutes from './routes/news.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Supported symbols - 25 major cryptocurrencies
const SYMBOLS = [
  // Tier 1 - Major
  'BTC', 'ETH', 'SOL', 'XRP', 'BNB',
  // Tier 2 - Large Cap
  'ADA', 'AVAX', 'DOGE', 'DOT', 'MATIC',
  // Tier 3 - Mid Cap
  'LINK', 'LTC', 'ATOM', 'UNI', 'APT',
  // Tier 4 - Layer 2 & DeFi
  'ARB', 'OP', 'INJ', 'SUI', 'SEI',
  // Tier 5 - Trending
  'PEPE', 'WIF', 'BONK', 'FET', 'RENDER'
];

// Initialize clients and services - 13 exchanges total
const clients = [
  // Centralized Exchanges (CEX) - 8
  new BinanceClient(),
  new BybitClient(),
  new OKXClient(),
  new BitgetClient(),
  new GateIOClient(),
  new MEXCClient(),
  new KuCoinClient(),
  new KrakenClient(),
  // Decentralized Exchanges (DEX) - 5
  new DYDXClient(),
  new HyperliquidClient(),
  new GMXClient(),
  new JupiterClient(),
  new FlashClient(),
];

const aggregator = new DataAggregator(clients);
const predictor = new CascadePredictor();
const db = new PrismDB();

// Cache for data
let cachedData: AggregatedData | null = null;
let cachedRisks: CascadeRisk[] = [];
let lastFetch = 0;
const CACHE_TTL_MS = 30_000;
const POLL_INTERVAL_MS = 30_000;

// WebSocket instance (initialized later)
let wsServer: PrismWebSocket | null = null;

async function refreshData(broadcast = false): Promise<void> {
  const now = Date.now();
  if (cachedData && now - lastFetch < CACHE_TTL_MS && !broadcast) {
    return;
  }

  try {
    cachedData = await aggregator.run(SYMBOLS);
    cachedRisks = predictor.analyze(cachedData);
    lastFetch = now;

    // Persist to database
    db.saveSnapshot(cachedData);
    db.saveRiskScores(cachedRisks);

    // Broadcast via WebSocket
    if (broadcast && wsServer) {
      wsServer.broadcastData(cachedData);
      wsServer.broadcastRisk(cachedRisks);

      // Dispatch webhooks
      webhookManager.dispatchData(cachedData).catch(console.error);
      webhookManager.dispatchRisk(cachedRisks).catch(console.error);

      // Check for alerts
      const alertRisks = cachedRisks.filter(r =>
        r.riskLevel === 'critical' || r.riskLevel === 'high'
      );
      if (alertRisks.length > 0) {
        webhookManager.dispatchAlert(alertRisks).catch(console.error);
      }
    }
  } catch (error) {
    console.error('Error refreshing data:', error);
    throw error;
  }
}

// Security middleware (MUST be first)
app.use(applySecurity);

// Body parsing with size limit
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Sanitize request bodies
app.use(bodySanitizer);

// Advanced security (SQL injection, XSS, path traversal, etc.)
app.use(applyAdvancedSecurity);

// CORS middleware - SECURITY: Restrict origins in production
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:5173', 'http://localhost:3000'];

app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;

  // Check if origin is allowed
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
  } else if (!origin) {
    // Same-origin requests (no Origin header) - only allow for safe methods
    // SECURITY: Don't set wildcard for requests that could modify data
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      res.header('Access-Control-Allow-Origin', ALLOWED_ORIGINS[0] || 'http://localhost:5173');
    }
    // For other methods without origin, don't set CORS headers (will be blocked)
  }

  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  // SECURITY: Don't expose X-Admin-Secret in CORS headers
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-API-Key, X-Timestamp, X-Nonce, X-Signature');
  res.header('Access-Control-Max-Age', '86400'); // Cache preflight for 24 hours

  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }
  next();
});

// Request logging
app.use((req: Request, res: Response, next: NextFunction) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// Routes

// Health check
app.get('/api/v1/health', (req: Request, res: Response) => {
  const stats = db.getStats();
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    exchanges: clients.map(c => c.name),
    symbols: SYMBOLS,
    websocket: {
      clients: wsServer?.getClientCount() || 0,
    },
    database: {
      snapshotCount: stats.snapshotCount,
      alertCount: stats.alertCount,
    },
  });
});

// Get current aggregated data
app.get('/api/v1/data', async (req: Request, res: Response) => {
  try {
    await refreshData();
    res.json({
      success: true,
      data: cachedData,
      cached: Date.now() - lastFetch > 1000,
      cacheAge: Date.now() - lastFetch,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Get cascade risk analysis
app.get('/api/v1/risk', async (req: Request, res: Response) => {
  try {
    await refreshData();
    res.json({
      success: true,
      risks: cachedRisks,
      summary: {
        highestRisk: cachedRisks.length > 0
          ? cachedRisks.reduce((max, r) => r.riskScore > max.riskScore ? r : max, cachedRisks[0])
          : null,
        criticalCount: cachedRisks.filter(r => r.riskLevel === 'critical').length,
        highCount: cachedRisks.filter(r => r.riskLevel === 'high').length,
        elevatedCount: cachedRisks.filter(r => r.riskLevel === 'elevated').length,
      },
      timestamp: cachedData?.timestamp,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Get data for specific symbol
app.get('/api/v1/symbols/:symbol', async (req: Request, res: Response) => {
  const symbol = (Array.isArray(req.params.symbol) ? req.params.symbol[0] : req.params.symbol)?.toUpperCase();

  if (!symbol || !SYMBOLS.includes(symbol)) {
    res.status(400).json({
      success: false,
      error: `Invalid symbol. Supported: ${SYMBOLS.join(', ')}`,
    });
    return;
  }

  try {
    await refreshData();

    const metrics = cachedData?.metrics[symbol];
    const risk = cachedRisks.find(r => r.symbol === symbol);

    if (!metrics) {
      res.status(404).json({
        success: false,
        error: `No data for symbol ${symbol}`,
      });
      return;
    }

    res.json({
      success: true,
      symbol,
      metrics,
      risk,
      timestamp: cachedData?.timestamp,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Get exchange list
app.get('/api/v1/exchanges', (req: Request, res: Response) => {
  res.json({
    success: true,
    exchanges: clients.map(c => ({
      name: c.name,
      status: 'active',
    })),
  });
});

// Get supported symbols
app.get('/api/v1/symbols', (req: Request, res: Response) => {
  res.json({
    success: true,
    symbols: SYMBOLS,
  });
});

// Cascade alert endpoint
app.get('/api/v1/alerts', async (req: Request, res: Response) => {
  try {
    await refreshData();

    const alerts = cachedRisks
      .filter(r => r.riskLevel === 'critical' || r.riskLevel === 'high' || r.riskLevel === 'elevated')
      .map(r => ({
        symbol: r.symbol,
        riskLevel: r.riskLevel,
        riskScore: r.riskScore,
        prediction: r.prediction,
        factors: r.factors.filter(f => f.score >= 50),
        timestamp: r.timestamp,
      }));

    res.json({
      success: true,
      alertCount: alerts.length,
      alerts,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ============ Price Comparison Endpoints ============

// Get all prices with oracle comparison
app.get('/api/v1/prices', async (req: Request, res: Response) => {
  try {
    await refreshData();

    const prices: Record<string, {
      symbol: string;
      oraclePrice: number;
      oracleSource: string;
      exchanges: Array<{
        name: string;
        price: number;
        deviation: string;
        deviationUSD: number;
      }>;
    }> = {};

    for (const symbol of SYMBOLS) {
      const metrics = cachedData?.metrics[symbol];
      if (!metrics) continue;

      prices[symbol] = {
        symbol,
        oraclePrice: metrics.oraclePrice,
        oracleSource: metrics.oracleSource,
        exchanges: metrics.priceComparison.map(pc => ({
          name: pc.exchange,
          price: pc.price,
          deviation: `${pc.deviation >= 0 ? '+' : ''}${pc.deviation.toFixed(4)}%`,
          deviationUSD: pc.deviationUSD,
        })),
      };
    }

    res.json({
      success: true,
      timestamp: cachedData?.timestamp,
      prices,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Get price for specific symbol with all exchange comparisons
app.get('/api/v1/prices/:symbol', async (req: Request, res: Response) => {
  const symbol = (Array.isArray(req.params.symbol) ? req.params.symbol[0] : req.params.symbol)?.toUpperCase();

  if (!symbol || !SYMBOLS.includes(symbol)) {
    res.status(400).json({
      success: false,
      error: `Invalid symbol. Supported: ${SYMBOLS.join(', ')}`,
    });
    return;
  }

  try {
    await refreshData();

    const metrics = cachedData?.metrics[symbol];
    if (!metrics) {
      res.status(404).json({
        success: false,
        error: `No price data for ${symbol}`,
      });
      return;
    }

    // Get fresh oracle price
    const pythPrice = await pythOracle.getPrice(symbol);

    res.json({
      success: true,
      symbol,
      oracle: {
        price: pythPrice?.price || metrics.oraclePrice,
        confidence: pythPrice?.confidence || 0,
        source: pythPrice ? 'Pyth Network' : metrics.oracleSource,
        publishTime: pythPrice?.publishTime,
      },
      exchanges: metrics.priceComparison.map(pc => ({
        name: pc.exchange,
        price: pc.price,
        deviation: pc.deviation,
        deviationPercent: `${pc.deviation >= 0 ? '+' : ''}${pc.deviation.toFixed(4)}%`,
        deviationUSD: pc.deviationUSD,
      })),
      summary: {
        avgPrice: metrics.avgMarkPrice,
        maxDeviation: metrics.maxDeviation,
        priceSpread: metrics.priceDeviation,
        exchangeCount: metrics.priceComparison.length,
      },
      timestamp: cachedData?.timestamp,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ============ Historical Data Endpoints ============

// SECURITY: Safe integer parsing with bounds validation
function safeParseInt(value: unknown, defaultVal: number, min = 1, max = 10000): number {
  if (typeof value !== 'string') return defaultVal;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) return defaultVal;
  return Math.min(Math.max(parsed, min), max);
}

app.get('/api/v1/history/:symbol', (req: Request, res: Response) => {
  const symbol = (Array.isArray(req.params.symbol) ? req.params.symbol[0] : req.params.symbol)?.toUpperCase();
  const hours = safeParseInt(req.query.hours, 24, 1, 720); // Max 30 days

  if (!symbol || !SYMBOLS.includes(symbol)) {
    res.status(400).json({
      success: false,
      error: `Invalid symbol. Supported: ${SYMBOLS.join(', ')}`,
    });
    return;
  }

  try {
    const history = db.getAggregatedHistory(symbol, hours);
    res.json({
      success: true,
      symbol,
      hours,
      dataPoints: history.length,
      history,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.get('/api/v1/history/:symbol/risk', (req: Request, res: Response) => {
  const symbol = (Array.isArray(req.params.symbol) ? req.params.symbol[0] : req.params.symbol)?.toUpperCase();
  const hours = safeParseInt(req.query.hours, 24, 1, 720);

  if (!symbol || !SYMBOLS.includes(symbol)) {
    res.status(400).json({
      success: false,
      error: `Invalid symbol. Supported: ${SYMBOLS.join(', ')}`,
    });
    return;
  }

  try {
    const history = db.getRiskHistory(symbol, hours);
    res.json({
      success: true,
      symbol,
      hours,
      dataPoints: history.length,
      history,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.get('/api/v1/history/high-risk', (req: Request, res: Response) => {
  const minScore = safeParseInt(req.query.minScore, 60, 0, 100);

  try {
    const periods = db.getHighRiskPeriods(minScore);
    res.json({
      success: true,
      minScore,
      count: periods.length,
      periods,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.get('/api/v1/history/alerts', (req: Request, res: Response) => {
  const hours = safeParseInt(req.query.hours, 24, 1, 720);
  const severity = req.query.severity as string | undefined;

  try {
    const alerts = db.getAlerts(hours, severity);
    res.json({
      success: true,
      hours,
      severity: severity || 'all',
      count: alerts.length,
      alerts,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.get('/api/v1/stats', (req: Request, res: Response) => {
  try {
    const stats = db.getStats();
    res.json({
      success: true,
      stats: {
        ...stats,
        oldestSnapshot: stats.oldestSnapshot ? new Date(stats.oldestSnapshot).toISOString() : null,
        newestSnapshot: stats.newestSnapshot ? new Date(stats.newestSnapshot).toISOString() : null,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ============ Security Admin Endpoints ============
import crypto from 'crypto';

// SECURITY: Generate secure random secret if not provided
const ADMIN_SECRET = process.env.ADMIN_SECRET || (() => {
  const generatedSecret = crypto.randomBytes(32).toString('hex');
  console.warn('[SECURITY WARNING] No ADMIN_SECRET env var set. Using generated secret:');
  console.warn(`ADMIN_SECRET=${generatedSecret}`);
  console.warn('Set this in your environment for production!');
  return generatedSecret;
})();

// Timing-safe comparison to prevent timing attacks
function secureCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still do comparison to prevent length timing attack
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

app.get('/api/v1/admin/security/stats', (req: Request, res: Response) => {
  const secret = req.headers['x-admin-secret'];
  if (!secureCompare(String(secret || ''), ADMIN_SECRET)) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  res.json({
    success: true,
    security: getSecurityStats(),
  });
});

app.get('/api/v1/admin/security/audit', (req: Request, res: Response) => {
  const secret = req.headers['x-admin-secret'];
  if (!secureCompare(String(secret || ''), ADMIN_SECRET)) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const limit = safeParseInt(req.query.limit, 100, 1, 1000);
  res.json({
    success: true,
    audit: getRecentAuditLog(limit),
  });
});

app.post('/api/v1/admin/security/unblock/:ip', (req: Request, res: Response) => {
  const secret = req.headers['x-admin-secret'];
  if (!secureCompare(String(secret || ''), ADMIN_SECRET)) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const ip = Array.isArray(req.params.ip) ? req.params.ip[0] : req.params.ip;
  const success = unblockIp(ip);
  res.json({
    success,
    message: success ? `IP ${ip} unblocked` : 'IP not found',
  });
});

// ============ Admin Routes ============
app.use('/api/v1/admin', adminRoutes);

// ============ Auth Routes ============
app.use('/api/v1/auth', authRoutes);

// ============ Stock Routes ============
app.use('/api/v1/stocks', stockRoutes);
app.use('/api/v1/news', newsRoutes);

// ============ Exchange Client Routes (Authenticated) ============
app.use('/api/v1/account', exchangeAuth(), accountRoutes);
app.use('/api/v1/webhooks', exchangeAuth(), webhookRoutes);

// ============ Authenticated Data Routes ============
// These routes filter data based on the exchange's plan
app.get('/api/v1/client/data', exchangeAuth(), filterByPlan, async (req: Request, res: Response) => {
  try {
    await refreshData();
    res.json({
      success: true,
      data: cachedData,
      cached: Date.now() - lastFetch > 1000,
      cacheAge: Date.now() - lastFetch,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.get('/api/v1/client/risk', exchangeAuth(), filterByPlan, async (req: Request, res: Response) => {
  try {
    await refreshData();
    const filteredRisks = req.exchange
      ? cachedRisks.filter(r => req.exchange!.symbols.includes(r.symbol))
      : cachedRisks;

    res.json({
      success: true,
      risks: filteredRisks,
      summary: {
        highestRisk: filteredRisks.length > 0
          ? filteredRisks.reduce((max, r) => r.riskScore > max.riskScore ? r : max, filteredRisks[0])
          : null,
        criticalCount: filteredRisks.filter(r => r.riskLevel === 'critical').length,
        highCount: filteredRisks.filter(r => r.riskLevel === 'high').length,
        elevatedCount: filteredRisks.filter(r => r.riskLevel === 'elevated').length,
      },
      timestamp: cachedData?.timestamp,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.get('/api/v1/client/symbols/:symbol', exchangeAuth({ checkSymbol: true }), async (req: Request, res: Response) => {
  const symbol = (Array.isArray(req.params.symbol) ? req.params.symbol[0] : req.params.symbol)?.toUpperCase();

  try {
    await refreshData();

    const metrics = cachedData?.metrics[symbol];
    const risk = cachedRisks.find(r => r.symbol === symbol);

    if (!metrics) {
      res.status(404).json({
        success: false,
        error: `No data for symbol ${symbol}`,
      });
      return;
    }

    res.json({
      success: true,
      symbol,
      metrics,
      risk,
      timestamp: cachedData?.timestamp,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Start server with WebSocket support
export function startServer(): void {
  const server = createServer(app);

  // Initialize WebSocket
  wsServer = new PrismWebSocket(server);

  // Start background polling
  setInterval(async () => {
    try {
      await refreshData(true); // broadcast = true
      console.log(`[Poll] Data refreshed. WS clients: ${wsServer?.getClientCount()}`);
    } catch (error) {
      console.error('[Poll] Error:', error);
    }
  }, POLL_INTERVAL_MS);

  server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║                    PRISM API Server                          ║
╚══════════════════════════════════════════════════════════════╝

  HTTP Server: http://localhost:${PORT}
  WebSocket:   ws://localhost:${PORT}/ws

  Public Endpoints:
    GET /api/v1/health          - Health check
    GET /api/v1/data            - All exchange data
    GET /api/v1/risk            - Cascade risk analysis
    GET /api/v1/symbols         - List supported symbols
    GET /api/v1/symbols/:s      - Data for specific symbol
    GET /api/v1/exchanges       - List of exchanges
    GET /api/v1/alerts          - Active risk alerts

  Historical Endpoints:
    GET /api/v1/history/:s      - Historical data
    GET /api/v1/history/:s/risk - Risk score history
    GET /api/v1/history/high-risk - High risk periods
    GET /api/v1/history/alerts  - Historical alerts
    GET /api/v1/stats           - Database statistics

  Client Endpoints (API Key Required):
    GET  /api/v1/client/data        - Data filtered by plan
    GET  /api/v1/client/risk        - Risk filtered by plan
    GET  /api/v1/client/symbols/:s  - Symbol data (plan check)
    GET  /api/v1/account            - Account info
    POST /api/v1/account/rotate-key - Rotate API key
    GET  /api/v1/webhooks           - List webhooks
    POST /api/v1/webhooks           - Register webhook
    POST /api/v1/webhooks/:id/test  - Test webhook

  Admin Endpoints (X-Admin-Secret Required):
    POST   /api/v1/admin/exchanges         - Create exchange
    GET    /api/v1/admin/exchanges         - List exchanges
    PATCH  /api/v1/admin/exchanges/:id     - Update exchange
    POST   /api/v1/admin/exchanges/:id/suspend    - Suspend
    POST   /api/v1/admin/exchanges/:id/reactivate - Reactivate
    DELETE /api/v1/admin/exchanges/:id     - Delete exchange

  WebSocket Events:
    → connected, data, risk, alert, ping/pong

  Exchanges: ${clients.map(c => c.name).join(', ')}
  Symbols: ${SYMBOLS.join(', ')}
  Poll Interval: ${POLL_INTERVAL_MS / 1000}s
`);
  });

  // Initial data fetch
  refreshData(true).catch(console.error);
}

// Handle shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  wsServer?.close();
  db.close();
  process.exit(0);
});

// Run if executed directly
startServer();
