export interface OpenInterest {
  exchange: string;
  symbol: string;
  openInterest: number;      // In contracts or base currency
  openInterestValue: number; // In USD
  timestamp: number;
}

export interface FundingRate {
  exchange: string;
  symbol: string;
  fundingRate: number;       // As decimal (0.0001 = 0.01%)
  fundingTime: number;       // Next funding timestamp
  timestamp: number;
}

export interface Liquidation {
  exchange: string;
  symbol: string;
  side: 'long' | 'short';
  quantity: number;
  price: number;
  value: number;             // In USD
  timestamp: number;
}

export interface MarkPrice {
  exchange: string;
  symbol: string;
  markPrice: number;
  indexPrice: number;
  timestamp: number;
}

export interface ExchangeData {
  exchange: string;
  openInterest: OpenInterest[];
  fundingRates: FundingRate[];
  markPrices: MarkPrice[];
  timestamp: number;
}

export interface ExchangeClient {
  name: string;
  getOpenInterest(symbol: string): Promise<OpenInterest>;
  getFundingRate(symbol: string): Promise<FundingRate>;
  getMarkPrice(symbol: string): Promise<MarkPrice>;
  getAllData(symbols: string[]): Promise<ExchangeData>;
}

// Standardized symbol mapping
export const SYMBOLS = {
  BTC: 'BTC',
  ETH: 'ETH',
} as const;

export type SymbolKey = keyof typeof SYMBOLS;
