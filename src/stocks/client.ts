import axios from 'axios';
import { logger as rootLogger } from '../lib/logger.js';

const log = rootLogger.child({ component: 'stocks' });

// Major stocks to track
export const STOCK_SYMBOLS = [
  { symbol: 'TSLA', name: 'Tesla', sector: 'Auto' },
  { symbol: 'AAPL', name: 'Apple', sector: 'Tech' },
  { symbol: 'NVDA', name: 'NVIDIA', sector: 'Tech' },
  { symbol: 'MSFT', name: 'Microsoft', sector: 'Tech' },
  { symbol: 'GOOGL', name: 'Google', sector: 'Tech' },
  { symbol: 'AMZN', name: 'Amazon', sector: 'Tech' },
  { symbol: 'META', name: 'Meta', sector: 'Tech' },
  { symbol: 'AMD', name: 'AMD', sector: 'Tech' },
  { symbol: 'NFLX', name: 'Netflix', sector: 'Tech' },
  { symbol: 'JPM', name: 'JPMorgan', sector: 'Finance' },
  { symbol: 'V', name: 'Visa', sector: 'Finance' },
  { symbol: 'BAC', name: 'Bank of America', sector: 'Finance' },
  { symbol: 'XOM', name: 'Exxon', sector: 'Energy' },
  { symbol: 'CVX', name: 'Chevron', sector: 'Energy' },
  { symbol: 'PFE', name: 'Pfizer', sector: 'Healthcare' },
  { symbol: 'JNJ', name: 'Johnson & Johnson', sector: 'Healthcare' },
];

export interface StockQuote {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  high: number;
  low: number;
  open: number;
  previousClose: number;
  volume: number;
  marketCap?: number;
  sector: string;
  timestamp: number;
}

export interface StockRisk {
  symbol: string;
  name: string;
  riskScore: number;
  riskLevel: 'low' | 'moderate' | 'elevated' | 'high' | 'critical';
  volatility: number;
  momentum: number;
  sector: string;
  prediction: {
    direction: 'bullish' | 'bearish';
    probability: number;
    targetPrice: number;
  } | null;
}

// Yahoo Finance API (unofficial, no key needed)
const YAHOO_API = 'https://query1.finance.yahoo.com/v8/finance/chart';

export async function fetchStockQuote(symbol: string): Promise<StockQuote | null> {
  try {
    const response = await axios.get(`${YAHOO_API}/${symbol}`, {
      params: {
        interval: '1d',
        range: '1d',
      },
      headers: {
        'User-Agent': 'Mozilla/5.0',
      },
      timeout: 10000,
    });

    const result = response.data?.chart?.result?.[0];
    if (!result) return null;

    const meta = result.meta;
    const quote = result.indicators?.quote?.[0];
    const stockInfo = STOCK_SYMBOLS.find(s => s.symbol === symbol);

    // Get price values with proper fallbacks
    const currentPrice = meta.regularMarketPrice || 0;
    // Try multiple sources for previous close
    const prevClose = meta.chartPreviousClose || meta.previousClose || meta.regularMarketPreviousClose || quote?.open?.[0] || currentPrice;

    // Calculate change only if we have valid previous close
    const priceChange = prevClose > 0 ? currentPrice - prevClose : 0;
    const pctChange = prevClose > 0 ? (priceChange / prevClose) * 100 : 0;

    return {
      symbol,
      name: stockInfo?.name || symbol,
      price: currentPrice,
      change: priceChange,
      changePercent: pctChange,
      high: quote?.high?.[0] || meta.regularMarketDayHigh || currentPrice,
      low: quote?.low?.[0] || meta.regularMarketDayLow || currentPrice,
      open: quote?.open?.[0] || meta.regularMarketOpen || currentPrice,
      previousClose: prevClose,
      volume: quote?.volume?.[0] || meta.regularMarketVolume || 0,
      sector: stockInfo?.sector || 'Other',
      timestamp: Date.now(),
    };
  } catch (error) {
    log.error({ symbol, err: error instanceof Error ? error.message : error }, 'Failed to fetch stock quote');
    return null;
  }
}

export async function fetchAllStocks(): Promise<StockQuote[]> {
  const quotes: StockQuote[] = [];

  // Fetch in batches to avoid rate limits
  for (const stock of STOCK_SYMBOLS) {
    const quote = await fetchStockQuote(stock.symbol);
    if (quote) {
      quotes.push(quote);
    }
    // Small delay between requests
    await new Promise(r => setTimeout(r, 100));
  }

  return quotes;
}

// Calculate risk score for a stock based on volatility and momentum
export function calculateStockRisk(quote: StockQuote, historicalVolatility?: number): StockRisk {
  // Simple risk calculation based on daily movement and volatility
  const dailyMove = Math.abs(quote.changePercent);
  const volatility = historicalVolatility || dailyMove * 2;

  // Risk factors
  let riskScore = 0;

  // Volatility factor (0-40 points)
  if (volatility > 5) riskScore += 40;
  else if (volatility > 3) riskScore += 30;
  else if (volatility > 2) riskScore += 20;
  else if (volatility > 1) riskScore += 10;

  // Daily movement factor (0-30 points)
  if (dailyMove > 5) riskScore += 30;
  else if (dailyMove > 3) riskScore += 20;
  else if (dailyMove > 1.5) riskScore += 10;

  // Volume spike factor (0-20 points) - placeholder
  riskScore += Math.min(20, Math.random() * 15);

  // Sector risk adjustment
  const sectorRisk: Record<string, number> = {
    'Tech': 10,
    'Auto': 15,
    'Finance': 5,
    'Energy': 12,
    'Healthcare': 3,
  };
  riskScore += sectorRisk[quote.sector] || 5;

  // Cap at 100
  riskScore = Math.min(100, Math.round(riskScore));

  // Determine risk level
  let riskLevel: StockRisk['riskLevel'];
  if (riskScore >= 80) riskLevel = 'critical';
  else if (riskScore >= 60) riskLevel = 'high';
  else if (riskScore >= 40) riskLevel = 'elevated';
  else if (riskScore >= 20) riskLevel = 'moderate';
  else riskLevel = 'low';

  // Simple momentum calculation
  const momentum = quote.changePercent > 0 ? 1 : -1;

  // Generate prediction if risk is elevated
  let prediction: StockRisk['prediction'] = null;
  if (riskScore >= 40) {
    const direction = quote.changePercent > 0 ? 'bullish' : 'bearish';
    const moveTarget = quote.price * (1 + (direction === 'bullish' ? 0.02 : -0.02));
    prediction = {
      direction,
      probability: 0.5 + (riskScore / 200),
      targetPrice: Math.round(moveTarget * 100) / 100,
    };
  }

  return {
    symbol: quote.symbol,
    name: quote.name,
    riskScore,
    riskLevel,
    volatility,
    momentum,
    sector: quote.sector,
    prediction,
  };
}

export default {
  fetchStockQuote,
  fetchAllStocks,
  calculateStockRisk,
  STOCK_SYMBOLS,
};
