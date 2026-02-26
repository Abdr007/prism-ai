import { useState, useEffect, useCallback } from 'react'
import { ArrowLeft, RefreshCw, ExternalLink, Clock, Globe, Newspaper } from 'lucide-react'

interface NewsArticle {
  id: string
  title: string
  description: string
  url: string
  source: string
  publishedAt: string
  category: 'crypto' | 'blockchain' | 'tech' | 'markets'
  image?: string
}

interface NewsPageProps {
  onBack: () => void
}

// Simulated news data (in production, use a real news API like NewsAPI, CryptoPanic, etc.)
const MOCK_NEWS: NewsArticle[] = [
  {
    id: '1',
    title: 'Bitcoin Surges Past $100K as Institutional Adoption Accelerates',
    description: 'Major financial institutions continue to pile into Bitcoin as the cryptocurrency breaks new all-time highs.',
    url: '#',
    source: 'CoinDesk',
    publishedAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
    category: 'crypto',
  },
  {
    id: '2',
    title: 'Ethereum Layer 2 Solutions See Record Transaction Volume',
    description: 'Arbitrum and Optimism process more transactions than Ethereum mainnet for the first time.',
    url: '#',
    source: 'The Block',
    publishedAt: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
    category: 'blockchain',
  },
  {
    id: '3',
    title: 'NVIDIA Announces Next-Gen AI Chips for Crypto Mining',
    description: 'The new RTX 50 series includes dedicated tensor cores optimized for blockchain computations.',
    url: '#',
    source: 'TechCrunch',
    publishedAt: new Date(Date.now() - 1000 * 60 * 90).toISOString(),
    category: 'tech',
  },
  {
    id: '4',
    title: 'Fed Signals Crypto-Friendly Regulatory Framework',
    description: 'Federal Reserve hints at clearer guidelines for digital asset custody and trading.',
    url: '#',
    source: 'Bloomberg',
    publishedAt: new Date(Date.now() - 1000 * 60 * 120).toISOString(),
    category: 'markets',
  },
  {
    id: '5',
    title: 'Solana DeFi TVL Reaches New Heights Amid Ecosystem Growth',
    description: 'Total value locked in Solana-based protocols surpasses $50 billion.',
    url: '#',
    source: 'Decrypt',
    publishedAt: new Date(Date.now() - 1000 * 60 * 180).toISOString(),
    category: 'crypto',
  },
  {
    id: '6',
    title: 'Apple Integrates Blockchain Technology in iOS 20',
    description: 'New wallet features allow seamless crypto payments across Apple devices.',
    url: '#',
    source: 'The Verge',
    publishedAt: new Date(Date.now() - 1000 * 60 * 240).toISOString(),
    category: 'tech',
  },
  {
    id: '7',
    title: 'Major Banks Launch Interoperable Blockchain Network',
    description: 'JPMorgan, Goldman Sachs, and Morgan Stanley unveil shared settlement layer.',
    url: '#',
    source: 'Reuters',
    publishedAt: new Date(Date.now() - 1000 * 60 * 300).toISOString(),
    category: 'blockchain',
  },
  {
    id: '8',
    title: 'Tesla Resumes Bitcoin Payments for Electric Vehicles',
    description: 'Elon Musk announces renewed support for crypto payments citing green mining progress.',
    url: '#',
    source: 'CNBC',
    publishedAt: new Date(Date.now() - 1000 * 60 * 360).toISOString(),
    category: 'markets',
  },
]

const CATEGORY_CONFIG = {
  crypto: { label: 'Crypto', color: '#f7931a', icon: '₿' },
  blockchain: { label: 'Blockchain', color: '#627eea', icon: '⛓️' },
  tech: { label: 'Tech', color: '#00d4aa', icon: '💻' },
  markets: { label: 'Markets', color: '#22c55e', icon: '📈' },
}

function timeAgo(dateString: string): string {
  const now = new Date()
  const date = new Date(dateString)
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000)

  if (seconds < 60) return 'Just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

export function NewsPage({ onBack }: NewsPageProps) {
  const [news, setNews] = useState<NewsArticle[]>(MOCK_NEWS)
  const [loading, setLoading] = useState(false)
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)

  const fetchNews = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch('/api/v1/news')
      const data = await response.json()
      if (data.success && data.data?.articles) {
        setNews(data.data.articles)
      } else {
        // Fallback to mock data if API fails
        setNews(MOCK_NEWS)
      }
    } catch (error) {
      console.error('Failed to fetch news:', error)
      setNews(MOCK_NEWS)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchNews()
    const interval = setInterval(fetchNews, 5 * 60 * 1000) // Refresh every 5 min
    return () => clearInterval(interval)
  }, [fetchNews])

  const filteredNews = selectedCategory
    ? news.filter(n => n.category === selectedCategory)
    : news

  return (
    <div className="min-h-screen bg-[#0a0b0f] text-white">
      {/* Background */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(59,130,246,0.1),transparent_50%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(rgba(59,130,246,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(59,130,246,0.02)_1px,transparent_1px)] bg-[size:60px_60px]" />
      </div>

      {/* Header */}
      <header className="relative z-10 border-b border-white/5 bg-black/20 backdrop-blur-xl sticky top-0">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={onBack}
              className="p-2 rounded-lg bg-white/5 border border-white/10
                transition-all duration-200 hover:bg-white/15 hover:scale-110
                active:scale-90 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-500 to-red-600 flex items-center justify-center shadow-lg">
                <Newspaper className="w-5 h-5" />
              </div>
              <div>
                <h1 className="text-lg font-bold">News Feed</h1>
                <p className="text-[10px] text-slate-500 uppercase tracking-widest">Crypto & Tech Headlines</p>
              </div>
            </div>
          </div>

          <button
            onClick={fetchNews}
            disabled={loading}
            className="p-2 rounded-lg bg-white/5 border border-white/10
              transition-all duration-200 hover:bg-white/15 hover:scale-110
              active:scale-90 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="relative z-10 max-w-6xl mx-auto px-4 py-6">
        {/* Category Filters */}
        <div className="flex items-center gap-2 mb-6 overflow-x-auto pb-2">
          <button
            onClick={() => setSelectedCategory(null)}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition-all duration-200
              hover:scale-105 active:scale-95
              ${!selectedCategory
                ? 'bg-blue-500 text-white shadow-lg shadow-blue-500/30'
                : 'bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white'
              }`}
          >
            All
          </button>
          {Object.entries(CATEGORY_CONFIG).map(([key, config]) => (
            <button
              key={key}
              onClick={() => setSelectedCategory(key)}
              className={`px-4 py-2 rounded-xl text-sm font-medium transition-all duration-200
                hover:scale-105 active:scale-95 flex items-center gap-2
                ${selectedCategory === key
                  ? 'text-white shadow-lg'
                  : 'bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white'
                }`}
              style={{
                backgroundColor: selectedCategory === key ? config.color : undefined,
                boxShadow: selectedCategory === key ? `0 10px 25px ${config.color}40` : undefined,
              }}
            >
              <span>{config.icon}</span>
              {config.label}
            </button>
          ))}
        </div>

        {/* Featured Article */}
        {filteredNews.length > 0 && (
          <div className="mb-6">
            <a
              href={filteredNews[0].url}
              target="_blank"
              rel="noopener noreferrer"
              className="block group relative overflow-hidden rounded-2xl bg-gradient-to-br from-blue-500/20 to-purple-500/20 border border-white/10
                transition-all duration-300 hover:scale-[1.01] hover:shadow-2xl hover:shadow-blue-500/20"
            >
              <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent" />
              <div className="relative p-8">
                <div className="flex items-center gap-2 mb-4">
                  <span
                    className="px-2 py-1 rounded-lg text-xs font-bold"
                    style={{
                      backgroundColor: `${CATEGORY_CONFIG[filteredNews[0].category].color}30`,
                      color: CATEGORY_CONFIG[filteredNews[0].category].color,
                    }}
                  >
                    {CATEGORY_CONFIG[filteredNews[0].category].icon} {CATEGORY_CONFIG[filteredNews[0].category].label}
                  </span>
                  <span className="text-xs text-slate-400 flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {timeAgo(filteredNews[0].publishedAt)}
                  </span>
                </div>
                <h2 className="text-2xl font-bold mb-3 group-hover:text-blue-400 transition-colors">
                  {filteredNews[0].title}
                </h2>
                <p className="text-slate-400 mb-4 line-clamp-2">{filteredNews[0].description}</p>
                <div className="flex items-center gap-2 text-sm text-slate-500">
                  <Globe className="w-4 h-4" />
                  {filteredNews[0].source}
                  <ExternalLink className="w-4 h-4 ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
              </div>
            </a>
          </div>
        )}

        {/* News Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredNews.slice(1).map(article => (
            <a
              key={article.id}
              href={article.url}
              target="_blank"
              rel="noopener noreferrer"
              className="group p-4 rounded-xl bg-white/[0.02] border border-white/5
                transition-all duration-300 hover:bg-white/[0.05] hover:border-white/15
                hover:scale-[1.02] hover:-translate-y-1 hover:shadow-lg"
            >
              <div className="flex items-center gap-2 mb-3">
                <span
                  className="px-2 py-0.5 rounded text-[10px] font-bold"
                  style={{
                    backgroundColor: `${CATEGORY_CONFIG[article.category].color}25`,
                    color: CATEGORY_CONFIG[article.category].color,
                  }}
                >
                  {CATEGORY_CONFIG[article.category].icon}
                </span>
                <span className="text-xs text-slate-500">{article.source}</span>
                <span className="text-xs text-slate-600 ml-auto">{timeAgo(article.publishedAt)}</span>
              </div>
              <h3 className="font-semibold text-sm mb-2 line-clamp-2 group-hover:text-blue-400 transition-colors">
                {article.title}
              </h3>
              <p className="text-xs text-slate-500 line-clamp-2">{article.description}</p>
            </a>
          ))}
        </div>

        {/* Empty State */}
        {filteredNews.length === 0 && (
          <div className="text-center py-12">
            <Newspaper className="w-12 h-12 mx-auto mb-4 text-slate-600" />
            <h3 className="text-lg font-bold text-slate-400">No news found</h3>
            <p className="text-sm text-slate-500">Check back later for updates</p>
          </div>
        )}
      </main>
    </div>
  )
}

export default NewsPage
