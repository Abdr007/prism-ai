import { Router, Request, Response } from 'express';
import { fetchAllStocks, fetchStockQuote, calculateStockRisk, STOCK_SYMBOLS, StockQuote, StockRisk } from '../../stocks/client.js';
import { logger as rootLogger } from '../../lib/logger.js';

const log = rootLogger.child({ component: 'stocks-routes' });

const router = Router();

// Cache for stock data
let stockCache: {
  quotes: StockQuote[];
  risks: StockRisk[];
  timestamp: number;
} = {
  quotes: [],
  risks: [],
  timestamp: 0,
};

const CACHE_TTL = 60000; // 1 minute cache

// Refresh stock data
async function refreshStockData(): Promise<void> {
  try {
    log.info('Refreshing stock data');
    const quotes = await fetchAllStocks();
    const risks = quotes.map(q => calculateStockRisk(q));

    stockCache = {
      quotes,
      risks,
      timestamp: Date.now(),
    };
    log.info({ count: quotes.length }, 'Stock data refreshed');
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : error }, 'Failed to refresh stock data');
  }
}

// Initialize stock data on load
refreshStockData();

// Refresh every 5 minutes
setInterval(refreshStockData, 5 * 60 * 1000);

// GET /api/v1/stocks - Get all stock quotes
router.get('/', async (req: Request, res: Response) => {
  try {
    // Check if cache is stale
    if (Date.now() - stockCache.timestamp > CACHE_TTL && stockCache.quotes.length === 0) {
      await refreshStockData();
    }

    res.json({
      success: true,
      data: {
        stocks: stockCache.quotes,
        timestamp: stockCache.timestamp,
        symbols: STOCK_SYMBOLS.map(s => s.symbol),
      },
    });
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : error }, 'Stocks endpoint error');
    res.status(500).json({ success: false, error: 'Failed to fetch stocks' });
  }
});

// GET /api/v1/stocks/risk - Get stock risk analysis
router.get('/risk', async (req: Request, res: Response) => {
  try {
    if (stockCache.risks.length === 0) {
      await refreshStockData();
    }

    res.json({
      success: true,
      risks: stockCache.risks,
      timestamp: stockCache.timestamp,
    });
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : error }, 'Stocks risk endpoint error');
    res.status(500).json({ success: false, error: 'Failed to fetch stock risks' });
  }
});

// GET /api/v1/stocks/:symbol - Get single stock quote
router.get('/:symbol', async (req: Request, res: Response) => {
  try {
    const symbol = req.params.symbol as string;
    const upperSymbol = symbol.toUpperCase();

    // Check cache first
    const cachedQuote = stockCache.quotes.find(q => q.symbol === upperSymbol);
    if (cachedQuote && Date.now() - stockCache.timestamp < CACHE_TTL) {
      const risk = calculateStockRisk(cachedQuote);
      return res.json({ success: true, quote: cachedQuote, risk });
    }

    // Fetch fresh data
    const quote = await fetchStockQuote(upperSymbol);
    if (!quote) {
      return res.status(404).json({ success: false, error: 'Stock not found' });
    }

    const risk = calculateStockRisk(quote);
    res.json({ success: true, quote, risk });
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : error }, 'Stocks symbol endpoint error');
    res.status(500).json({ success: false, error: 'Failed to fetch stock' });
  }
});

// POST /api/v1/stocks/refresh - Force refresh stock data
router.post('/refresh', async (req: Request, res: Response) => {
  try {
    await refreshStockData();
    res.json({
      success: true,
      message: 'Stock data refreshed',
      count: stockCache.quotes.length,
    });
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : error }, 'Stocks refresh endpoint error');
    res.status(500).json({ success: false, error: 'Failed to refresh' });
  }
});

export default router;
