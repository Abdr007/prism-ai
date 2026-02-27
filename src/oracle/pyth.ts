import axios from 'axios';
import { logger as rootLogger } from '../lib/logger.js';

const log = rootLogger.child({ component: 'pyth-oracle' });

// Pyth Network Hermes API for real-time prices
const PYTH_API = 'https://hermes.pyth.network';

// Pyth Price Feed IDs (mainnet)
const PRICE_FEED_IDS: Record<string, string> = {
  'BTC': '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  'ETH': '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  'SOL': '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  'XRP': '0xec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8',
  'BNB': '0x2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f',
  'ADA': '0x2a01deaec9e51a579277b34b122399984d0bbf57e2458a7e42fecd2829867a0d',
  'AVAX': '0x93da3352f9f1d105fdfe4971cfa80e9dd777bfc5d0f683ebb6e1294b92137bb7',
  'DOGE': '0xdcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c',
  'DOT': '0xca3eed9b267293f6595901c734c7525ce8ef49adafe8284f97a66285d082f19d',
  'MATIC': '0x5de33440f6c8ee7d21f1fca0a9f8e06e179c3f93e45baa1e1e7e7b6c6e8b0f5d',
  'LINK': '0x8ac0c70fff57e9aefdf5edf44b51d62c2d433653cbb2cf5cc06bb115af04d221',
  'LTC': '0x6e3f3fa8253588df9326580180233eb791e03b443a3ba7a1d892e73874e19a54',
  'ATOM': '0xb00b60f88b03a6a625a8d1c048c3f66653edf217439983d037e7222c4e612819',
  'UNI': '0x78d185a741d07edb3412b09008b7c5cfb9bbbd7d568bf00ba737b456ba171501',
  'APT': '0x03ae4db29ed4ae33d323568895aa00337e658e348b37509f5372ae51f0af00d5',
  'ARB': '0x3fa4252848f9f0a1480be62745a4629d9eb1322aebab8a791e344b3b9c1adcf5',
  'OP': '0x385f64d993f7b77d8182ed5003d97c60aa3361f3cecfe711544d2d59165e9bdf',
  'INJ': '0x7a5bc1d2b56ad029048cd63964b3ad2776eadf812edc1a43a31406cb54bff592',
  'SUI': '0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744',
  'SEI': '0x53614f1cb0c031d4af66c04cb9c756234adad0e1cee85303795091499a4084eb',
  'PEPE': '0xd69731a2e74ac1ce884fc3890f7ee324b6deb66147055249568869ed700882e4',
  'WIF': '0x4ca4beeca86f0d164160323817a4e42b10010a724c2217c6ee41b54cd4cc61fc',
  'BONK': '0x72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419',
  'FET': '0xb98e7ae8af2d298d2651eb21ab5b8b5738212e13efb43bd0dfbce7a74ba4b5d0',
  'RENDER': '0xab7347771135fc733f8f38db462ba085ed3309955f42554a14fa13e855ac0e2f',
};

export interface PythPrice {
  symbol: string;
  price: number;
  confidence: number;
  publishTime: number;
  emaPrice: number;
}

export class PythOracle {
  private cache: Map<string, { price: PythPrice; timestamp: number }> = new Map();
  private cacheTTL = 5000; // 5 seconds

  // Get single price
  async getPrice(symbol: string): Promise<PythPrice | null> {
    const cached = this.cache.get(symbol);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.price;
    }

    const feedId = PRICE_FEED_IDS[symbol];
    if (!feedId) {
      log.warn({ symbol }, 'No Pyth feed ID');
      return null;
    }

    try {
      const response = await axios.get(`${PYTH_API}/v2/updates/price/latest`, {
        params: { ids: [feedId] }
      });

      const priceData = response.data.parsed?.[0]?.price;
      if (!priceData) return null;

      const price: PythPrice = {
        symbol,
        price: parseFloat(priceData.price) * Math.pow(10, priceData.expo),
        confidence: parseFloat(priceData.conf) * Math.pow(10, priceData.expo),
        publishTime: priceData.publish_time * 1000,
        emaPrice: parseFloat(response.data.parsed?.[0]?.ema_price?.price || priceData.price) * Math.pow(10, priceData.expo),
      };

      this.cache.set(symbol, { price, timestamp: Date.now() });
      return price;
    } catch (error) {
      log.error({ symbol, err: error instanceof Error ? error.message : 'Unknown' }, 'Pyth price fetch failed');
      return null;
    }
  }

  // Get all prices in batch
  async getAllPrices(symbols: string[]): Promise<Map<string, PythPrice>> {
    const feedIds = symbols
      .map(s => PRICE_FEED_IDS[s])
      .filter(Boolean);

    if (feedIds.length === 0) {
      return new Map();
    }

    try {
      const response = await axios.get(`${PYTH_API}/v2/updates/price/latest`, {
        params: { ids: feedIds }
      });

      const prices = new Map<string, PythPrice>();

      for (const parsed of response.data.parsed || []) {
        const feedId = '0x' + parsed.id;
        const symbol = Object.entries(PRICE_FEED_IDS).find(([, id]) => id === feedId)?.[0];

        if (symbol && parsed.price) {
          const priceData = parsed.price;
          const price: PythPrice = {
            symbol,
            price: parseFloat(priceData.price) * Math.pow(10, priceData.expo),
            confidence: parseFloat(priceData.conf) * Math.pow(10, priceData.expo),
            publishTime: priceData.publish_time * 1000,
            emaPrice: parseFloat(parsed.ema_price?.price || priceData.price) * Math.pow(10, priceData.expo),
          };

          prices.set(symbol, price);
          this.cache.set(symbol, { price, timestamp: Date.now() });
        }
      }

      return prices;
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : 'Unknown' }, 'Pyth batch fetch failed');
      return new Map();
    }
  }

  // Get supported symbols
  getSupportedSymbols(): string[] {
    return Object.keys(PRICE_FEED_IDS);
  }
}

// Singleton
export const pythOracle = new PythOracle();
