import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  Activity, Wifi, WifiOff, RefreshCw, TrendingUp, TrendingDown,
  AlertTriangle, Eye, Target, GitBranch, Radio, ArrowLeft,
  LogIn, User as UserIcon, Crown, Gauge, Zap, ShieldAlert, BarChart2, Newspaper, Clock
} from 'lucide-react'
import { createChart, ColorType, IChartApi, ISeriesApi, AreaData, Time, AreaSeries } from 'lightweight-charts'
import { LandingPage } from './LandingPage'
import { PrismBot } from './PrismBot'
import { AuthModal, User } from './AuthModal'
import { IntroAnimation } from './IntroAnimation'
import { NewsPage } from './NewsPage'

interface PriceComparison {
  exchange: string
  price: number
  deviation: number
  deviationUSD: number
}

interface Metrics {
  totalOpenInterestValue: number
  avgFundingRate: number
  avgMarkPrice: number
  priceDeviation: number
  openInterestByExchange: Record<string, number>
  fundingRateByExchange: Record<string, number>
  oraclePrice: number
  oracleConfidence: number
  oracleSource: string
  priceComparison: PriceComparison[]
  maxDeviation: number
  markPriceByExchange: Record<string, number>
}

interface Factor {
  name: string
  score: number
  weight: number
  description?: string
  value?: number
  threshold?: number
}

interface Prediction {
  direction: 'long_squeeze' | 'short_squeeze'
  probability: number
  estimatedImpact: number
  triggerPrice: number
  triggerDistance: number
  timeWindow: string
}

interface Risk {
  symbol: string
  riskScore: number
  riskLevel: 'low' | 'moderate' | 'elevated' | 'high' | 'critical'
  prediction: Prediction | null
  factors: Factor[]
}

interface MarketData {
  timestamp: number
  symbols: string[]
  exchanges: string[]
  metrics: Record<string, Metrics>
}

interface PriceHistory {
  timestamp: number
  price: number
}

// Stock interfaces
interface StockQuote {
  symbol: string
  name: string
  price: number
  change: number
  changePercent: number
  high: number
  low: number
  sector: string
  timestamp: number
}

interface StockRisk {
  symbol: string
  name: string
  riskScore: number
  riskLevel: 'low' | 'moderate' | 'elevated' | 'high' | 'critical'
  volatility: number
  momentum: number
  sector: string
  prediction: {
    direction: 'bullish' | 'bearish'
    probability: number
    targetPrice: number
  } | null
}

type AssetType = 'crypto' | 'stocks'

// Beginner-friendly factor config with clear descriptions
const FACTOR_CONFIG: Record<string, { icon: string; label: string; unit: string; description: string; tip: string }> = {
  'Funding Rate': {
    icon: '💰',
    label: 'Funding Rate',
    unit: '%',
    description: 'Cost to hold positions',
    tip: 'High = Too many longs/shorts. Price may reverse.'
  },
  'Open Interest Level': {
    icon: '📊',
    label: 'Open Interest',
    unit: '',
    description: 'Total active positions',
    tip: 'High = More liquidations possible if price moves.'
  },
  'Funding Divergence': {
    icon: '⚖️',
    label: 'Exchange Spread',
    unit: '',
    description: 'Funding rate differences',
    tip: 'High = Arbitrage opportunity, expect volatility.'
  },
  'Price Deviation': {
    icon: '📉',
    label: 'Price Gap',
    unit: '%',
    description: 'Price differs across exchanges',
    tip: 'High = Market stress, prices may snap back.'
  },
  'OI Concentration': {
    icon: '🎯',
    label: 'Concentration',
    unit: '',
    description: 'Positions on one exchange',
    tip: 'High = Single exchange dominates, risky.'
  },
}

// Get risk level explanation for beginners
const getRiskExplanation = (_level: string, score: number) => {
  if (score >= 80) return { emoji: '🚨', text: 'DANGER ZONE - High chance of sudden price crash or spike. Consider reducing positions.' }
  if (score >= 60) return { emoji: '⚠️', text: 'CAUTION - Market is stressed. Liquidations are more likely. Trade carefully.' }
  if (score >= 40) return { emoji: '👀', text: 'WATCH - Some risk factors elevated. Monitor closely before big trades.' }
  if (score >= 20) return { emoji: '✅', text: 'NORMAL - Market conditions are stable. Normal trading risk.' }
  return { emoji: '😴', text: 'CALM - Very low risk. Market is quiet and stable.' }
}

// Risk level styling
const getRiskStyle = (level: string) => {
  switch (level) {
    case 'critical': return { color: '#ff3366', bg: 'rgba(255, 51, 102, 0.1)', border: 'rgba(255, 51, 102, 0.3)', glow: '0 0 20px rgba(255, 51, 102, 0.3)' }
    case 'high': return { color: '#ff9500', bg: 'rgba(255, 149, 0, 0.1)', border: 'rgba(255, 149, 0, 0.3)', glow: '0 0 20px rgba(255, 149, 0, 0.3)' }
    case 'elevated': return { color: '#ffd60a', bg: 'rgba(255, 214, 10, 0.1)', border: 'rgba(255, 214, 10, 0.3)', glow: '0 0 20px rgba(255, 214, 10, 0.3)' }
    case 'moderate': return { color: '#30d158', bg: 'rgba(48, 209, 88, 0.1)', border: 'rgba(48, 209, 88, 0.3)', glow: '0 0 20px rgba(48, 209, 88, 0.3)' }
    default: return { color: '#64d2ff', bg: 'rgba(100, 210, 255, 0.1)', border: 'rgba(100, 210, 255, 0.3)', glow: '0 0 20px rgba(100, 210, 255, 0.3)' }
  }
}

// Get color based on score
const getScoreColor = (score: number) => {
  if (score >= 75) return '#ff3366'
  if (score >= 50) return '#ff9500'
  if (score >= 25) return '#ffd60a'
  return '#30d158'
}

const formatMoney = (n: number) => {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`
  return `$${n.toFixed(0)}`
}

// DEX/CEX Exchange classification
const DEX_EXCHANGES = ['dydx', 'hyperliquid', 'gmx', 'jupiter', 'flash'];
const _CEX_EXCHANGES = ['binance', 'bybit', 'okx', 'bitget', 'gateio', 'mexc', 'kucoin', 'kraken'];

const isDeX = (exchange: string) => DEX_EXCHANGES.includes(exchange.toLowerCase());

// Time intervals for chart
type TimeInterval = '5m' | '15m' | '30m' | '1h' | '4h';
const TIME_INTERVALS: { label: string; value: TimeInterval; minutes: number }[] = [
  { label: '5m', value: '5m', minutes: 5 },
  { label: '15m', value: '15m', minutes: 15 },
  { label: '30m', value: '30m', minutes: 30 },
  { label: '1h', value: '1h', minutes: 60 },
  { label: '4h', value: '4h', minutes: 240 },
];

// TradingView Chart Component
function TradingViewChart({
  data,
  height = 300,
  interval = '30m',
  onIntervalChange
}: {
  data: PriceHistory[];
  height?: number;
  interval?: TimeInterval;
  onIntervalChange?: (interval: TimeInterval) => void;
}) {
  const chartContainerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null)

  // Initialize chart
  useEffect(() => {
    if (!chartContainerRef.current) return

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#64748b',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(255, 255, 255, 0.03)' },
        horzLines: { color: 'rgba(255, 255, 255, 0.03)' },
      },
      width: chartContainerRef.current.clientWidth,
      height: height,
      timeScale: {
        borderColor: 'rgba(255, 255, 255, 0.1)',
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: 'rgba(255, 255, 255, 0.1)',
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      crosshair: {
        mode: 1,
        vertLine: { color: 'rgba(59, 130, 246, 0.5)', width: 1, style: 2 },
        horzLine: { color: 'rgba(59, 130, 246, 0.5)', width: 1, style: 2 },
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    })

    const areaSeries = chart.addSeries(AreaSeries, {
      lineColor: '#3b82f6',
      topColor: 'rgba(59, 130, 246, 0.4)',
      bottomColor: 'rgba(59, 130, 246, 0.0)',
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    })

    chartRef.current = chart
    seriesRef.current = areaSeries

    // Handle resize
    const handleResize = () => {
      if (chartContainerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: chartContainerRef.current.clientWidth })
      }
    }
    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      chart.remove()
    }
  }, [height])

  // Update data
  useEffect(() => {
    if (!seriesRef.current || data.length < 2) return

    const chartData: AreaData[] = data.map(d => ({
      time: (d.timestamp / 1000) as Time,
      value: d.price,
    }))

    // Determine color based on trend
    const isUp = data[data.length - 1].price >= data[0].price
    seriesRef.current.applyOptions({
      lineColor: isUp ? '#22c55e' : '#ef4444',
      topColor: isUp ? 'rgba(34, 197, 94, 0.4)' : 'rgba(239, 68, 68, 0.4)',
      bottomColor: isUp ? 'rgba(34, 197, 94, 0.0)' : 'rgba(239, 68, 68, 0.0)',
    })

    seriesRef.current.setData(chartData)
    chartRef.current?.timeScale().fitContent()
  }, [data])

  const prices = data.map(d => d.price)
  const isUp = data.length >= 2 && prices[prices.length - 1] >= prices[0]
  const change = data.length >= 2 ? ((prices[prices.length - 1] - prices[0]) / prices[0] * 100) : 0
  const currentPrice = prices[prices.length - 1] || 0

  return (
    <div className="relative">
      {/* Header with price info */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-4">
          <div>
            <span className="text-2xl font-bold font-mono">
              ${currentPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </span>
            <span className={`ml-3 text-sm font-medium ${isUp ? 'text-green-500' : 'text-red-500'}`}>
              {isUp ? '↑' : '↓'} {isUp ? '+' : ''}{change.toFixed(2)}%
            </span>
          </div>
        </div>

        {/* Time interval selector */}
        {onIntervalChange && (
          <div className="flex gap-1">
            {TIME_INTERVALS.map(t => (
              <button
                key={t.value}
                onClick={() => onIntervalChange(t.value)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg
                  transition-all duration-200 ease-out
                  hover:scale-105 active:scale-95
                  focus:outline-none focus:ring-2 focus:ring-blue-500/50
                  ${interval === t.value
                    ? 'bg-blue-500 text-white shadow-lg shadow-blue-500/30'
                    : 'bg-white/5 text-slate-400 hover:bg-white/15 hover:text-white'
                  }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Chart */}
      <div ref={chartContainerRef} className="rounded-xl overflow-hidden" />

      {/* Loading state */}
      {data.length < 2 && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-900/80 rounded-xl">
          <div className="text-center text-slate-400">
            <BarChart2 className="w-8 h-8 mx-auto mb-2 animate-pulse" />
            <p className="text-sm">Loading chart data...</p>
          </div>
        </div>
      )}
    </div>
  )
}

// Mini Sparkline for asset cards
function MiniSparkline({ data }: { data: number[] }) {
  if (data.length < 2) return null

  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  const isUp = data[data.length - 1] >= data[0]

  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * 60
    const y = 20 - ((v - min) / range) * 20
    return `${x},${y}`
  }).join(' ')

  return (
    <svg width="60" height="20" className="overflow-visible">
      <defs>
        <linearGradient id={`spark-${isUp ? 'up' : 'down'}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={isUp ? '#30d158' : '#ff3366'} stopOpacity="0.3" />
          <stop offset="100%" stopColor={isUp ? '#30d158' : '#ff3366'} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,20 ${points} 60,20`} fill={`url(#spark-${isUp ? 'up' : 'down'})`} />
      <polyline points={points} fill="none" stroke={isUp ? '#30d158' : '#ff3366'} strokeWidth="1.5" />
    </svg>
  )
}

function App() {
  const [showIntro, setShowIntro] = useState(true)
  const [showLanding, setShowLanding] = useState(true)
  const [showNews, setShowNews] = useState(false)
  const [showAuthModal, setShowAuthModal] = useState(false)
  const [user, setUser] = useState<User | null>(null)
  const [data, setData] = useState<MarketData | null>(null)
  const [risks, setRisks] = useState<Risk[]>([])
  const [connected, setConnected] = useState(false)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null)
  const [chartInterval, setChartInterval] = useState<TimeInterval>('30m')
  const [priceHistory, setPriceHistory] = useState<Record<string, PriceHistory[]>>({})
  const priceHistoryRef = useRef<Record<string, PriceHistory[]>>({})

  // Stock state
  const [assetType, setAssetType] = useState<AssetType>('crypto')
  const [stocks, setStocks] = useState<StockQuote[]>([])
  const [stockRisks, setStockRisks] = useState<StockRisk[]>([])

  // Get interval duration in ms
  const getIntervalMs = (interval: TimeInterval) => {
    const config = TIME_INTERVALS.find(t => t.value === interval)
    return (config?.minutes || 30) * 60 * 1000
  }

  const updatePriceHistory = useCallback((newData: MarketData) => {
    const now = Date.now()
    // Keep 4 hours of data for flexibility
    const fourHoursAgo = now - 4 * 60 * 60 * 1000

    for (const symbol of newData.symbols) {
      const metrics = newData.metrics[symbol]
      if (!metrics) continue

      const price = metrics.oraclePrice || metrics.avgMarkPrice
      if (!price) continue

      const history = priceHistoryRef.current[symbol] || []
      const filteredHistory = history.filter(h => h.timestamp > fourHoursAgo)
      filteredHistory.push({ timestamp: now, price })

      priceHistoryRef.current[symbol] = filteredHistory
    }

    setPriceHistory({ ...priceHistoryRef.current })
  }, [])

  const fetchData = useCallback(async () => {
    try {
      const [dataRes, riskRes] = await Promise.all([
        fetch('/api/v1/data'),
        fetch('/api/v1/risk')
      ])

      const dataJson = await dataRes.json()
      const riskJson = await riskRes.json()

      if (dataJson.success && dataJson.data) {
        setData(dataJson.data)
        setLastUpdate(new Date())
        updatePriceHistory(dataJson.data)
      }

      if (riskJson.success && riskJson.risks) {
        setRisks(riskJson.risks)
      }
    } catch (error) {
      console.error('Fetch error:', error)
    }
  }, [updatePriceHistory])

  // Fetch stock data
  const fetchStockData = useCallback(async () => {
    try {
      const [stocksRes, riskRes] = await Promise.all([
        fetch('/api/v1/stocks'),
        fetch('/api/v1/stocks/risk')
      ])

      const stocksJson = await stocksRes.json()
      const riskJson = await riskRes.json()

      if (stocksJson.success && stocksJson.data?.stocks) {
        setStocks(stocksJson.data.stocks)
      }

      if (riskJson.success && riskJson.risks) {
        setStockRisks(riskJson.risks)
      }
    } catch (error) {
      console.error('Stock fetch error:', error)
    }
  }, [])

  useEffect(() => {
    fetchData()
    fetchStockData()

    const wsUrl = `ws://${window.location.hostname}:3000/ws`
    const ws = new WebSocket(wsUrl)

    ws.onopen = () => setConnected(true)
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        if (msg.type === 'data' && msg.payload) {
          setData(msg.payload)
          setLastUpdate(new Date())
          updatePriceHistory(msg.payload)
        }
        if (msg.type === 'risk' && msg.payload) {
          setRisks(msg.payload)
        }
      } catch { /* ignore */ }
    }
    ws.onclose = () => setConnected(false)
    ws.onerror = () => setConnected(false)

    const interval = setInterval(() => {
      fetchData()
      fetchStockData()
    }, 60000) // Reduced to 60s to improve performance
    return () => { ws.close(); clearInterval(interval) }
  }, [fetchData, fetchStockData, updatePriceHistory])

  // Major assets in priority order
  const MAJOR_ASSETS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'ADA', 'AVAX', 'DOGE', 'DOT', 'LINK', 'MATIC', 'LTC']

  const sortedRisks = [...risks].sort((a, b) => {
    const aIndex = MAJOR_ASSETS.indexOf(a.symbol)
    const bIndex = MAJOR_ASSETS.indexOf(b.symbol)

    // Both are major assets - sort by priority order
    if (aIndex !== -1 && bIndex !== -1) {
      return aIndex - bIndex
    }
    // Only a is major - a comes first
    if (aIndex !== -1) return -1
    // Only b is major - b comes first
    if (bIndex !== -1) return 1
    // Neither is major - sort by risk score
    return b.riskScore - a.riskScore
  })
  const highRiskCount = risks.filter(r => r.riskLevel === 'critical' || r.riskLevel === 'high').length
  const selectedRisk = selectedSymbol ? risks.find(r => r.symbol === selectedSymbol) : null
  const selectedMetrics = selectedSymbol && data ? data.metrics[selectedSymbol] : null

  // Filter price history based on selected interval
  const selectedPriceHistory = useMemo(() => {
    if (!selectedSymbol) return []
    const history = priceHistory[selectedSymbol] || []
    const intervalMs = getIntervalMs(chartInterval)
    const cutoff = Date.now() - intervalMs
    return history.filter(h => h.timestamp > cutoff)
  }, [selectedSymbol, priceHistory, chartInterval])

  // Show intro animation on first load
  if (showIntro) {
    return <IntroAnimation onComplete={() => setShowIntro(false)} duration={5000} />
  }

  if (showLanding) {
    return <LandingPage onEnter={() => setShowLanding(false)} />
  }

  if (showNews) {
    return <NewsPage onBack={() => setShowNews(false)} />
  }

  return (
    <div className="min-h-screen bg-[#0a0b0f] text-white">
      {/* Futuristic Background */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(59,130,246,0.1),transparent_50%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(rgba(59,130,246,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(59,130,246,0.02)_1px,transparent_1px)] bg-[size:60px_60px]" />
      </div>

      {/* Header */}
      <header className="relative z-10 border-b border-white/5 bg-black/20 backdrop-blur-xl sticky top-0">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={() => setShowLanding(true)}
              className="p-2 rounded-lg bg-white/5 border border-white/10
                transition-all duration-200 ease-out
                hover:bg-white/15 hover:border-white/20 hover:scale-110 hover:-translate-x-0.5
                active:scale-90 active:translate-x-0
                focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            >
              <ArrowLeft className="w-4 h-4 transition-transform hover:-translate-x-0.5" />
            </button>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center shadow-lg shadow-blue-500/20">
                <Activity className="w-5 h-5" />
              </div>
              <div>
                <h1 className="text-lg font-bold tracking-tight">PRISM</h1>
                <p className="text-[10px] text-slate-500 tracking-widest uppercase">Risk Intelligence</p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {/* News Button */}
            <button
              onClick={() => setShowNews(true)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg
                bg-gradient-to-r from-orange-500/10 to-red-500/10
                border border-orange-500/20
                hover:from-orange-500/20 hover:to-red-500/20
                hover:border-orange-500/40
                transition-all duration-200 ease-out
                hover:scale-105 hover:-translate-y-0.5
                active:scale-95
                focus:outline-none focus:ring-2 focus:ring-orange-500/50"
            >
              <Newspaper className="w-4 h-4 text-orange-400" />
              <span className="text-xs font-medium text-orange-400">News</span>
            </button>

            {/* Asset Type Toggle */}
            <div className="flex rounded-lg bg-white/5 p-1 border border-white/10">
              <button
                onClick={() => { setAssetType('crypto'); setSelectedSymbol(null) }}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all duration-200
                  ${assetType === 'crypto'
                    ? 'bg-blue-500 text-white shadow-lg shadow-blue-500/30'
                    : 'text-slate-400 hover:text-white hover:bg-white/10'
                  }`}
              >
                Crypto
              </button>
              <button
                onClick={() => { setAssetType('stocks'); setSelectedSymbol(null) }}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all duration-200
                  ${assetType === 'stocks'
                    ? 'bg-green-500 text-white shadow-lg shadow-green-500/30'
                    : 'text-slate-400 hover:text-white hover:bg-white/10'
                  }`}
              >
                Stocks
              </button>
            </div>

            <div className="flex items-center gap-2 text-xs">
              <span className="text-slate-500">{assetType === 'crypto' ? 'Exchanges' : 'Stocks'}:</span>
              <span className="font-mono text-blue-400">{assetType === 'crypto' ? (data?.exchanges.length || 0) : stocks.length}</span>
            </div>
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium ${
              connected ? 'bg-green-500/10 text-green-400 border border-green-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'
            }`}>
              {connected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
              {connected ? 'LIVE' : 'OFFLINE'}
            </div>
            <button
              onClick={fetchData}
              className="p-2 rounded-lg bg-white/5 border border-white/10
                transition-all duration-200 ease-out
                hover:bg-white/15 hover:border-white/20 hover:scale-110
                active:scale-90
                focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            >
              <RefreshCw className="w-4 h-4 transition-transform hover:rotate-180 duration-500" />
            </button>

            {/* Auth Button */}
            {user ? (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-gradient-to-r from-blue-500/10 to-purple-500/10 border border-white/10">
                <div className="w-7 h-7 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
                  {user.isPremium ? (
                    <Crown className="w-4 h-4 text-yellow-300" />
                  ) : (
                    <UserIcon className="w-4 h-4 text-white" />
                  )}
                </div>
                <div className="text-sm">
                  <span className="font-medium">{user.displayName || 'User'}</span>
                  {user.isPremium && (
                    <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-400 font-semibold">
                      PRO
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowAuthModal(true)}
                className="flex items-center gap-2 px-4 py-2 rounded-xl
                  bg-gradient-to-r from-blue-500 to-purple-600
                  hover:from-blue-400 hover:to-purple-500
                  active:from-blue-600 active:to-purple-700
                  transition-all duration-200 ease-out
                  hover:scale-105 hover:-translate-y-0.5
                  active:scale-95 active:translate-y-0
                  font-medium text-sm
                  shadow-lg shadow-blue-500/25 hover:shadow-xl hover:shadow-blue-500/40
                  focus:outline-none focus:ring-2 focus:ring-blue-400/50"
              >
                <LogIn className="w-4 h-4 transition-transform group-hover:rotate-12" />
                Connect
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="relative z-10 max-w-7xl mx-auto px-4 py-6">
        {/* Alert Banner */}
        {highRiskCount > 0 && (
          <div className="mb-6 p-4 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-start gap-4" style={{ boxShadow: '0 0 40px rgba(255, 51, 102, 0.1)' }}>
            <div className="w-12 h-12 rounded-xl bg-red-500/20 flex items-center justify-center flex-shrink-0">
              <AlertTriangle className="w-6 h-6 text-red-500" />
            </div>
            <div>
              <h3 className="font-bold text-red-400 text-lg">High Risk Alert</h3>
              <p className="text-slate-400 text-sm mt-1">
                {highRiskCount} asset{highRiskCount > 1 ? 's are' : ' is'} showing dangerous levels of market stress.
                Liquidation cascades are more likely in these conditions.
              </p>
            </div>
          </div>
        )}

        {/* Asset Cards - Top Section */}
        <div className="mb-6">
          {assetType === 'crypto' ? (
            // Crypto Risk Categories
            <>
              {(['critical', 'high', 'elevated', 'moderate', 'low'] as const).map(level => {
                const assetsInLevel = sortedRisks.filter(r => r.riskLevel === level)
                if (assetsInLevel.length === 0) return null

                const levelConfig = {
                  critical: { label: 'Critical Risk', color: '#ff3366', bg: 'from-red-500/20 to-red-500/5' },
                  high: { label: 'High Risk', color: '#ff9500', bg: 'from-orange-500/20 to-orange-500/5' },
                  elevated: { label: 'Elevated', color: '#ffd60a', bg: 'from-yellow-500/20 to-yellow-500/5' },
                  moderate: { label: 'Moderate', color: '#30d158', bg: 'from-green-500/20 to-green-500/5' },
                  low: { label: 'Low Risk', color: '#64d2ff', bg: 'from-blue-500/20 to-blue-500/5' },
                }[level]

                return (
                  <div key={level} className="mb-4">
                    <div className="flex items-center gap-2 mb-3">
                      <div className="w-2 h-2 rounded-full" style={{ backgroundColor: levelConfig.color }} />
                      <span className="text-sm font-medium" style={{ color: levelConfig.color }}>
                        {levelConfig.label}
                      </span>
                      <span className="text-xs text-slate-500">({assetsInLevel.length})</span>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-2">
                  {assetsInLevel.map(risk => {
                    const metrics = data?.metrics[risk.symbol]
                    const price = metrics?.oraclePrice || metrics?.avgMarkPrice || 0
                    const history = priceHistory[risk.symbol]?.map(p => p.price) || []
                    const priceChange = history.length >= 2
                      ? ((history[history.length - 1] - history[0]) / history[0] * 100)
                      : 0
                    const isSelected = selectedSymbol === risk.symbol

                    return (
                      <button
                        key={risk.symbol}
                        onClick={() => setSelectedSymbol(risk.symbol)}
                        className={`group relative p-3 rounded-xl border cursor-pointer
                          transition-all duration-300 ease-out
                          hover:scale-[1.03] hover:-translate-y-1
                          active:scale-[0.98] active:translate-y-0
                          focus:outline-none focus:ring-2 focus:ring-blue-500/50
                          ${isSelected
                            ? 'bg-blue-500/20 border-blue-500/50 shadow-xl shadow-blue-500/30 scale-[1.02]'
                            : 'bg-white/[0.02] border-white/5 hover:border-white/20 hover:bg-white/[0.06] hover:shadow-lg hover:shadow-black/20'
                          }`}
                        style={{
                          transform: isSelected ? 'translateY(-2px)' : undefined,
                        }}
                      >
                        {/* Glow effect on hover */}
                        <div
                          className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
                          style={{
                            background: `radial-gradient(circle at 50% 50%, ${levelConfig.color}15 0%, transparent 70%)`,
                          }}
                        />

                        {/* Risk indicator dot with pulse */}
                        <div
                          className={`absolute top-2 right-2 w-2 h-2 rounded-full transition-all duration-300 ${
                            isSelected ? 'scale-125' : 'group-hover:scale-110'
                          }`}
                          style={{
                            backgroundColor: levelConfig.color,
                            boxShadow: `0 0 8px ${levelConfig.color}, 0 0 16px ${levelConfig.color}40`
                          }}
                        />

                        {/* Symbol */}
                        <div className="text-left mb-2 relative">
                          <span className="font-bold text-base group-hover:text-white transition-colors duration-200">
                            {risk.symbol}
                          </span>
                        </div>

                        {/* Price */}
                        <div className="text-left mb-1 relative">
                          <span className="font-mono text-sm text-slate-300 group-hover:text-slate-200 transition-colors duration-200">
                            ${price >= 1000
                              ? price.toLocaleString(undefined, { maximumFractionDigits: 0 })
                              : price >= 1
                              ? price.toLocaleString(undefined, { maximumFractionDigits: 2 })
                              : price.toFixed(4)
                            }
                          </span>
                        </div>

                        {/* Change & Score */}
                        <div className="flex items-center justify-between relative">
                          <span className={`text-xs font-mono transition-all duration-200 ${
                            priceChange >= 0
                              ? 'text-green-400 group-hover:text-green-300'
                              : 'text-red-400 group-hover:text-red-300'
                          }`}>
                            {priceChange >= 0 ? '+' : ''}{priceChange.toFixed(1)}%
                          </span>
                          <span
                            className="text-xs font-bold px-1.5 py-0.5 rounded transition-all duration-200 group-hover:scale-105"
                            style={{ backgroundColor: `${levelConfig.color}25`, color: levelConfig.color }}
                          >
                            {risk.riskScore}
                          </span>
                        </div>

                        {/* Mini sparkline */}
                        <div className="mt-2 relative opacity-80 group-hover:opacity-100 transition-opacity duration-200">
                          <MiniSparkline data={history} />
                        </div>
                      </button>
                    )
                  })}
                </div>
                  </div>
                )
              })}
            </>
          ) : (
            // Stock Cards by Sector
            <>
              {['Tech', 'Finance', 'Energy', 'Healthcare', 'Auto'].map(sector => {
                const stocksInSector = stockRisks.filter(s => s.sector === sector)
                if (stocksInSector.length === 0) return null

                const sectorConfig: Record<string, { color: string; icon: string }> = {
                  Tech: { color: '#3b82f6', icon: '💻' },
                  Finance: { color: '#10b981', icon: '🏦' },
                  Energy: { color: '#f59e0b', icon: '⚡' },
                  Healthcare: { color: '#ec4899', icon: '🏥' },
                  Auto: { color: '#8b5cf6', icon: '🚗' },
                }
                const config = sectorConfig[sector] || { color: '#64748b', icon: '📊' }

                return (
                  <div key={sector} className="mb-4">
                    <div className="flex items-center gap-2 mb-3">
                      <span className="text-base">{config.icon}</span>
                      <span className="text-sm font-medium" style={{ color: config.color }}>
                        {sector}
                      </span>
                      <span className="text-xs text-slate-500">({stocksInSector.length})</span>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-2">
                      {stocksInSector.map(stockRisk => {
                        const quote = stocks.find(s => s.symbol === stockRisk.symbol)
                        const isSelected = selectedSymbol === stockRisk.symbol
                        const levelConfig = getRiskStyle(stockRisk.riskLevel)

                        return (
                          <button
                            key={stockRisk.symbol}
                            onClick={() => setSelectedSymbol(stockRisk.symbol)}
                            className={`group relative p-3 rounded-xl border cursor-pointer
                              transition-all duration-300 ease-out
                              hover:scale-[1.03] hover:-translate-y-1
                              active:scale-[0.98] active:translate-y-0
                              focus:outline-none focus:ring-2 focus:ring-green-500/50
                              ${isSelected
                                ? 'bg-green-500/20 border-green-500/50 shadow-xl shadow-green-500/30 scale-[1.02]'
                                : 'bg-white/[0.02] border-white/5 hover:border-white/20 hover:bg-white/[0.06] hover:shadow-lg hover:shadow-black/20'
                              }`}
                          >
                            {/* Glow effect */}
                            <div
                              className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
                              style={{ background: `radial-gradient(circle at 50% 50%, ${config.color}15 0%, transparent 70%)` }}
                            />

                            {/* Risk dot */}
                            <div
                              className="absolute top-2 right-2 w-2 h-2 rounded-full"
                              style={{ backgroundColor: levelConfig.color, boxShadow: `0 0 6px ${levelConfig.color}` }}
                            />

                            {/* Symbol & Name */}
                            <div className="text-left mb-1 relative">
                              <span className="font-bold text-base group-hover:text-white transition-colors">
                                {stockRisk.symbol}
                              </span>
                              <span className="block text-[10px] text-slate-500 truncate">
                                {stockRisk.name}
                              </span>
                            </div>

                            {/* Price */}
                            <div className="text-left mb-1 relative">
                              <span className="font-mono text-sm text-slate-300">
                                ${quote?.price.toFixed(2) || '—'}
                              </span>
                            </div>

                            {/* Change & Score */}
                            <div className="flex items-center justify-between relative">
                              <span className={`text-xs font-mono ${
                                (quote?.changePercent || 0) >= 0 ? 'text-green-400' : 'text-red-400'
                              }`}>
                                {(quote?.changePercent || 0) >= 0 ? '+' : ''}
                                {quote?.changePercent.toFixed(1) || '0.0'}%
                              </span>
                              <span
                                className="text-xs font-bold px-1.5 py-0.5 rounded"
                                style={{ backgroundColor: `${levelConfig.color}25`, color: levelConfig.color }}
                              >
                                {stockRisk.riskScore}
                              </span>
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </>
          )}
        </div>

        {/* Detail Panel - Full Width */}
        {selectedRisk ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Left Column - Chart & Prediction */}
            <div className="space-y-6">
              {/* Price Chart */}
              <div className="bg-white/[0.02] backdrop-blur-sm rounded-2xl border border-white/5 overflow-hidden">
                  <div className="p-4 border-b border-white/5">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-xl font-bold">{selectedRisk.symbol}/USDT</h3>
                        <p className="text-sm text-slate-400">
                          ${(selectedMetrics?.oraclePrice || selectedMetrics?.avgMarkPrice || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                          <span className="ml-2 text-xs text-blue-400">({selectedMetrics?.oracleSource || 'Exchange'})</span>
                        </p>
                      </div>
                      <div
                        className="px-4 py-2 rounded-xl text-center"
                        style={{
                          background: getRiskStyle(selectedRisk.riskLevel).bg,
                          border: `1px solid ${getRiskStyle(selectedRisk.riskLevel).border}`,
                          boxShadow: getRiskStyle(selectedRisk.riskLevel).glow
                        }}
                      >
                        <div className="text-2xl font-black" style={{ color: getRiskStyle(selectedRisk.riskLevel).color }}>
                          {selectedRisk.riskScore}
                        </div>
                        <div className="text-xs text-slate-400 uppercase tracking-wider">{selectedRisk.riskLevel}</div>
                      </div>
                    </div>
                  </div>
                  <div className="p-4">
                    <TradingViewChart
                      data={selectedPriceHistory}
                      height={280}
                      interval={chartInterval}
                      onIntervalChange={setChartInterval}
                    />
                  </div>
                </div>
            </div>

            {/* Right Column - Risk Factors & Exchange Prices */}
              <div className="space-y-6">
                {/* Risk Summary - Beginner Friendly */}
                <div className="bg-white/[0.02] backdrop-blur-sm rounded-2xl border border-white/5 overflow-hidden">
                  {/* Risk Score Header with Explanation */}
                  <div className="p-4 border-b border-white/5">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <Gauge className="w-5 h-5 text-blue-400" />
                        <h3 className="font-bold">Risk Score</h3>
                      </div>
                      <div
                        className="px-4 py-2 rounded-xl text-center"
                        style={{
                          backgroundColor: `${getScoreColor(selectedRisk.riskScore)}15`,
                          border: `2px solid ${getScoreColor(selectedRisk.riskScore)}50`
                        }}
                      >
                        <span className="text-2xl font-black" style={{ color: getScoreColor(selectedRisk.riskScore) }}>
                          {selectedRisk.riskScore}
                        </span>
                        <span className="text-xs text-slate-400">/100</span>
                      </div>
                    </div>

                    {/* Beginner-friendly explanation */}
                    <div
                      className="p-3 rounded-xl"
                      style={{ backgroundColor: `${getScoreColor(selectedRisk.riskScore)}10` }}
                    >
                      <div className="flex items-start gap-2">
                        <span className="text-xl">{getRiskExplanation(selectedRisk.riskLevel, selectedRisk.riskScore).emoji}</span>
                        <p className="text-sm text-slate-300">
                          {getRiskExplanation(selectedRisk.riskLevel, selectedRisk.riskScore).text}
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* What's driving this score? */}
                  <div className="p-4">
                    <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">
                      What's Driving This Score?
                    </h4>
                    <div className="space-y-3">
                      {selectedRisk.factors.map(factor => {
                        const config = FACTOR_CONFIG[factor.name] || {
                          icon: '📊',
                          label: factor.name,
                          unit: '',
                          description: 'Market factor',
                          tip: 'Affects market risk'
                        }
                        const color = getScoreColor(factor.score)
                        const isHigh = factor.score >= 50

                        return (
                          <div
                            key={factor.name}
                            className={`p-3 rounded-xl transition-all ${isHigh ? 'bg-black/30' : 'bg-black/15'}`}
                          >
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2">
                                <span className="text-lg">{config.icon}</span>
                                <div>
                                  <span className="font-medium text-sm">{config.label}</span>
                                  <span className="text-xs text-slate-500 ml-2">{config.description}</span>
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="text-lg font-bold tabular-nums" style={{ color }}>
                                  {factor.score}
                                </span>
                                {isHigh && <span className="text-xs px-1.5 py-0.5 rounded bg-red-500/20 text-red-400">HIGH</span>}
                              </div>
                            </div>
                            {/* Progress bar */}
                            <div className="h-2 bg-slate-800 rounded-full overflow-hidden mb-2">
                              <div
                                className="h-full rounded-full transition-all duration-500"
                                style={{ width: `${factor.score}%`, backgroundColor: color }}
                              />
                            </div>
                            {/* Tip for beginners */}
                            {isHigh && (
                              <p className="text-xs text-slate-400 italic">
                                💡 {config.tip}
                              </p>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>

                  {/* Action recommendation */}
                  <div className="px-4 pb-4">
                    <div
                      className={`p-3 rounded-xl border ${
                        selectedRisk.riskScore >= 60
                          ? 'bg-red-500/10 border-red-500/30'
                          : selectedRisk.riskScore >= 40
                          ? 'bg-yellow-500/10 border-yellow-500/30'
                          : 'bg-green-500/10 border-green-500/30'
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <ShieldAlert className={`w-4 h-4 ${
                          selectedRisk.riskScore >= 60 ? 'text-red-400' :
                          selectedRisk.riskScore >= 40 ? 'text-yellow-400' : 'text-green-400'
                        }`} />
                        <span className="text-sm font-semibold">
                          {selectedRisk.riskScore >= 60 ? 'High Risk - Be Careful!' :
                           selectedRisk.riskScore >= 40 ? 'Moderate Risk - Stay Alert' :
                           'Low Risk - Good Conditions'}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400">
                        {selectedRisk.riskScore >= 60
                          ? 'Consider reducing position sizes. Use tight stop losses. Avoid high leverage.'
                          : selectedRisk.riskScore >= 40
                          ? 'Normal trading conditions. Monitor for changes. Use standard risk management.'
                          : 'Market is stable. Good time for planned entries. Normal leverage is acceptable.'}
                      </p>
                    </div>
                  </div>
                </div>

                {/* AI Prediction - Clear & Accurate */}
                {selectedRisk.prediction && (
                  <div
                    className="rounded-2xl border overflow-hidden"
                    style={{
                      background: selectedRisk.prediction.direction === 'long_squeeze'
                        ? 'linear-gradient(135deg, rgba(255, 51, 102, 0.1) 0%, rgba(255, 51, 102, 0.02) 100%)'
                        : 'linear-gradient(135deg, rgba(48, 209, 88, 0.1) 0%, rgba(48, 209, 88, 0.02) 100%)',
                      borderColor: selectedRisk.prediction.direction === 'long_squeeze'
                        ? 'rgba(255, 51, 102, 0.3)'
                        : 'rgba(48, 209, 88, 0.3)'
                    }}
                  >
                    {/* AI Prediction Header */}
                    <div className="p-4 border-b border-white/5">
                      <div className="flex items-center gap-2 mb-3">
                        <Zap className="w-4 h-4 text-purple-400" />
                        <span className="text-xs font-semibold text-purple-400 uppercase tracking-wider">AI Prediction</span>
                      </div>
                      <div className="flex items-center gap-4">
                        {selectedRisk.prediction.direction === 'long_squeeze' ? (
                          <div className="w-14 h-14 rounded-2xl bg-red-500/20 flex items-center justify-center border border-red-500/30">
                            <TrendingDown className="w-7 h-7 text-red-500" />
                          </div>
                        ) : (
                          <div className="w-14 h-14 rounded-2xl bg-green-500/20 flex items-center justify-center border border-green-500/30">
                            <TrendingUp className="w-7 h-7 text-green-500" />
                          </div>
                        )}
                        <div>
                          <h3 className="text-lg font-bold">
                            {selectedRisk.prediction.direction === 'long_squeeze' ? '📉 LONG SQUEEZE' : '📈 SHORT SQUEEZE'}
                          </h3>
                          <p className="text-sm text-slate-300">
                            {selectedRisk.prediction.direction === 'long_squeeze'
                              ? 'Price likely to DROP as longs get liquidated'
                              : 'Price likely to PUMP as shorts get liquidated'
                            }
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* What this means */}
                    <div className="px-4 py-3 bg-black/20">
                      <p className="text-xs text-slate-400">
                        <span className="font-semibold text-white">What this means: </span>
                        {selectedRisk.prediction.direction === 'long_squeeze'
                          ? 'Too many traders are betting on price going UP (long positions). If price drops to the trigger level, these positions will be forcefully closed (liquidated), causing a rapid price crash.'
                          : 'Too many traders are betting on price going DOWN (short positions). If price rises to the trigger level, these positions will be forcefully closed (liquidated), causing a rapid price spike.'
                        }
                      </p>
                    </div>

                    {/* Prediction Metrics */}
                    <div className="p-4 grid grid-cols-2 gap-3">
                      <div className="p-3 rounded-xl bg-black/30 border border-white/5">
                        <div className="text-xs text-slate-500 mb-1 flex items-center gap-1">
                          <Target className="w-3 h-3" />
                          Confidence
                        </div>
                        <div className="flex items-baseline gap-1">
                          <span className="text-2xl font-black" style={{
                            color: selectedRisk.prediction.probability >= 0.7 ? '#ff3366' :
                                   selectedRisk.prediction.probability >= 0.5 ? '#ffd60a' : '#64d2ff'
                          }}>
                            {(selectedRisk.prediction.probability * 100).toFixed(0)}%
                          </span>
                        </div>
                        <p className="text-[10px] text-slate-500 mt-1">
                          {selectedRisk.prediction.probability >= 0.7 ? 'High confidence' :
                           selectedRisk.prediction.probability >= 0.5 ? 'Moderate confidence' : 'Low confidence'}
                        </p>
                      </div>

                      <div className="p-3 rounded-xl bg-black/30 border border-white/5">
                        <div className="text-xs text-slate-500 mb-1 flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3" />
                          Liquidation Risk
                        </div>
                        <div className="text-2xl font-black text-orange-400">
                          {formatMoney(selectedRisk.prediction.estimatedImpact)}
                        </div>
                        <p className="text-[10px] text-slate-500 mt-1">Estimated positions at risk</p>
                      </div>

                      <div className="p-3 rounded-xl bg-black/30 border border-white/5">
                        <div className="text-xs text-slate-500 mb-1 flex items-center gap-1">
                          <Target className="w-3 h-3" />
                          Trigger Price
                        </div>
                        <div className="text-2xl font-black" style={{
                          color: selectedRisk.prediction.direction === 'long_squeeze' ? '#ff3366' : '#30d158'
                        }}>
                          ${selectedRisk.prediction.triggerPrice.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                        </div>
                        <p className="text-[10px] text-slate-500 mt-1">
                          {selectedRisk.prediction.direction === 'long_squeeze' ? 'If price drops here' : 'If price reaches here'}
                        </p>
                      </div>

                      <div className="p-3 rounded-xl bg-black/30 border border-white/5">
                        <div className="text-xs text-slate-500 mb-1 flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          Time Window
                        </div>
                        <div className="text-2xl font-black text-blue-400">
                          {selectedRisk.prediction.timeWindow}
                        </div>
                        <p className="text-[10px] text-slate-500 mt-1">Prediction valid for</p>
                      </div>
                    </div>

                    {/* Trading Suggestion */}
                    <div className="px-4 pb-4">
                      <div className={`p-3 rounded-xl border ${
                        selectedRisk.prediction.direction === 'long_squeeze'
                          ? 'bg-red-500/10 border-red-500/30'
                          : 'bg-green-500/10 border-green-500/30'
                      }`}>
                        <div className="flex items-center gap-2 mb-1">
                          <Zap className={`w-4 h-4 ${
                            selectedRisk.prediction.direction === 'long_squeeze' ? 'text-red-400' : 'text-green-400'
                          }`} />
                          <span className="text-sm font-semibold">Trading Suggestion</span>
                        </div>
                        <p className="text-xs text-slate-300">
                          {selectedRisk.prediction.direction === 'long_squeeze'
                            ? '• Avoid opening new longs near trigger price\n• Consider setting stop-losses above trigger\n• Potential short opportunity if trigger breaks'
                            : '• Avoid opening new shorts near trigger price\n• Consider setting stop-losses below trigger\n• Potential long opportunity on breakout'
                          }
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Exchange Data - DEX & CEX Separated */}
                {selectedMetrics && selectedMetrics.priceComparison.length > 0 && (
                  <div className="bg-white/[0.02] backdrop-blur-sm rounded-2xl border border-white/5 overflow-hidden">
                    <div className="p-4 border-b border-white/5">
                      <h3 className="font-bold flex items-center gap-2">
                        <GitBranch className="w-4 h-4 text-cyan-400" />
                        Exchange Prices
                      </h3>
                      <p className="text-xs text-slate-500 mt-1">Prices across centralized and decentralized exchanges</p>
                    </div>

                    {/* CEX Section */}
                    <div className="p-3 border-b border-white/5">
                      <div className="flex items-center gap-2 mb-2">
                        <div className="w-2 h-2 rounded-full bg-blue-500" />
                        <span className="text-xs font-medium text-blue-400 uppercase tracking-wider">Centralized (CEX)</span>
                      </div>
                      <div className="grid gap-1">
                        {selectedMetrics.priceComparison
                          .filter(pc => !isDeX(pc.exchange) && pc.price > 0)
                          .slice(0, 8)
                          .map(pc => (
                            <div key={pc.exchange} className="px-3 py-2 rounded-lg bg-blue-500/5 flex items-center justify-between hover:bg-blue-500/10 transition-colors">
                              <div className="flex items-center gap-2">
                                <div className="w-6 h-6 rounded bg-blue-500/20 flex items-center justify-center text-[10px] font-bold text-blue-400">
                                  {pc.exchange.slice(0, 2).toUpperCase()}
                                </div>
                                <span className="font-medium capitalize text-sm">{pc.exchange}</span>
                              </div>
                              <div className="flex items-center gap-3">
                                <span className="font-mono text-sm">${pc.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                                <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${
                                  pc.deviation > 0
                                    ? 'text-green-400 bg-green-500/10'
                                    : pc.deviation < 0
                                    ? 'text-red-400 bg-red-500/10'
                                    : 'text-slate-400 bg-slate-500/10'
                                }`}>
                                  {pc.deviation >= 0 ? '+' : ''}{pc.deviation.toFixed(3)}%
                                </span>
                              </div>
                            </div>
                          ))}
                      </div>
                    </div>

                    {/* DEX Section */}
                    <div className="p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <div className="w-2 h-2 rounded-full bg-purple-500" />
                        <span className="text-xs font-medium text-purple-400 uppercase tracking-wider">Decentralized (DEX)</span>
                      </div>
                      <div className="grid gap-1">
                        {selectedMetrics.priceComparison
                          .filter(pc => isDeX(pc.exchange) && pc.price > 0)
                          .map(pc => (
                            <div key={pc.exchange} className="px-3 py-2 rounded-lg bg-purple-500/5 flex items-center justify-between hover:bg-purple-500/10 transition-colors">
                              <div className="flex items-center gap-2">
                                <div className="w-6 h-6 rounded bg-purple-500/20 flex items-center justify-center text-[10px] font-bold text-purple-400">
                                  {pc.exchange.slice(0, 2).toUpperCase()}
                                </div>
                                <span className="font-medium capitalize text-sm">{pc.exchange}</span>
                                {(pc.exchange === 'jupiter' || pc.exchange === 'flash') && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-400">SOLANA</span>
                                )}
                              </div>
                              <div className="flex items-center gap-3">
                                <span className="font-mono text-sm">${pc.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                                <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${
                                  pc.deviation > 0
                                    ? 'text-green-400 bg-green-500/10'
                                    : pc.deviation < 0
                                    ? 'text-red-400 bg-red-500/10'
                                    : 'text-slate-400 bg-slate-500/10'
                                }`}>
                                  {pc.deviation >= 0 ? '+' : ''}{pc.deviation.toFixed(3)}%
                                </span>
                              </div>
                            </div>
                          ))}
                        {selectedMetrics.priceComparison.filter(pc => isDeX(pc.exchange) && pc.price > 0).length === 0 && (
                          <div className="text-xs text-slate-500 text-center py-2">
                            No DEX data available for this symbol
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
            </div>
          </div>
        ) : (
          <div className="bg-white/[0.02] backdrop-blur-sm rounded-2xl border border-white/5 p-12 text-center">
            <div className="w-16 h-16 rounded-2xl bg-blue-500/10 flex items-center justify-center mx-auto mb-4">
              <Eye className="w-8 h-8 text-blue-400" />
            </div>
            <h3 className="text-xl font-bold mb-2">Select an Asset</h3>
            <p className="text-slate-400 max-w-sm mx-auto">
              Click on any asset card above to view detailed risk analysis, live charts, and liquidation predictions.
            </p>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="relative z-10 border-t border-white/5 mt-12">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between text-xs text-slate-500">
          <div className="flex items-center gap-2">
            <Radio className="w-3 h-3 text-green-500 animate-pulse" />
            <span>Monitoring {data?.exchanges.length || 0} exchanges</span>
          </div>
          {lastUpdate && <span>Updated {lastUpdate.toLocaleTimeString()}</span>}
        </div>
      </footer>

      {/* AI Chatbot */}
      <PrismBot />

      {/* Auth Modal */}
      <AuthModal
        isOpen={showAuthModal}
        onClose={() => setShowAuthModal(false)}
        onLogin={(loggedInUser) => {
          setUser(loggedInUser)
          setShowAuthModal(false)
        }}
      />
    </div>
  )
}

export default App
