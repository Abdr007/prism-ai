import { useState, useEffect, useRef } from 'react'
import {
  Activity, Zap, Shield, TrendingUp, ChevronRight, Sparkles,
  Globe, Lock, BarChart3, Cpu, Network, AlertTriangle,
  ArrowRight, Check, Server, Layers, Eye, Target
} from 'lucide-react'

interface LandingPageProps {
  onEnter: () => void
}

// Animated counter component
function AnimatedCounter({ end, duration = 2000, suffix = '' }: { end: number; duration?: number; suffix?: string }) {
  const [count, setCount] = useState(0)

  useEffect(() => {
    let startTime: number
    const animate = (timestamp: number) => {
      if (!startTime) startTime = timestamp
      const progress = Math.min((timestamp - startTime) / duration, 1)
      setCount(Math.floor(progress * end))
      if (progress < 1) requestAnimationFrame(animate)
    }
    requestAnimationFrame(animate)
  }, [end, duration])

  return <>{count.toLocaleString()}{suffix}</>
}

// Floating orb animation
function FloatingOrb({ color, size, x, y, delay }: { color: string; size: number; x: number; y: number; delay: number }) {
  return (
    <div
      className="absolute rounded-full blur-3xl animate-pulse"
      style={{
        width: size,
        height: size,
        background: color,
        left: `${x}%`,
        top: `${y}%`,
        animationDelay: `${delay}s`,
        animationDuration: '4s'
      }}
    />
  )
}

// Exchange logo placeholder
function ExchangeLogo({ name }: { name: string }) {
  return (
    <div className="w-12 h-12 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-xs font-bold text-slate-400 hover:bg-white/10 hover:border-white/20 transition-all">
      {name.slice(0, 2).toUpperCase()}
    </div>
  )
}

export function LandingPage({ onEnter }: LandingPageProps) {
  const [isVisible, setIsVisible] = useState(false)
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 })
  const heroRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setIsVisible(true)
  }, [])

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!heroRef.current) return
    const rect = heroRef.current.getBoundingClientRect()
    setMousePos({
      x: ((e.clientX - rect.left) / rect.width) * 100,
      y: ((e.clientY - rect.top) / rect.height) * 100
    })
  }

  return (
    <div className="min-h-screen bg-[#050507] text-white overflow-hidden">
      {/* Animated Background */}
      <div className="fixed inset-0 pointer-events-none">
        {/* Grid */}
        <div className="absolute inset-0 bg-[linear-gradient(rgba(59,130,246,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(59,130,246,0.03)_1px,transparent_1px)] bg-[size:60px_60px]" />

        {/* Floating Orbs */}
        <FloatingOrb color="rgba(59, 130, 246, 0.15)" size={600} x={-10} y={-10} delay={0} />
        <FloatingOrb color="rgba(147, 51, 234, 0.15)" size={500} x={70} y={60} delay={1} />
        <FloatingOrb color="rgba(6, 182, 212, 0.1)" size={400} x={50} y={-20} delay={2} />

        {/* Radial gradient following mouse */}
        <div
          className="absolute w-[600px] h-[600px] rounded-full transition-all duration-300 ease-out"
          style={{
            background: 'radial-gradient(circle, rgba(59, 130, 246, 0.1) 0%, transparent 70%)',
            left: `calc(${mousePos.x}% - 300px)`,
            top: `calc(${mousePos.y}% - 300px)`,
          }}
        />
      </div>

      {/* Header */}
      <header className="relative z-10 border-b border-white/5 bg-black/20 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center shadow-lg shadow-blue-500/30">
              <Activity className="w-6 h-6" />
            </div>
            <span className="text-xl font-bold tracking-tight">PRISM</span>
          </div>
          <div className="flex items-center gap-6">
            <a href="#features" className="text-sm text-slate-400 hover:text-white transition-colors">Features</a>
            <a href="#exchanges" className="text-sm text-slate-400 hover:text-white transition-colors">Exchanges</a>
            <a href="#api" className="text-sm text-slate-400 hover:text-white transition-colors">API</a>
            <button
              onClick={onEnter}
              className="px-4 py-2 bg-white/10 hover:bg-white/20 rounded-lg text-sm font-medium transition-colors border border-white/10"
            >
              Launch App
            </button>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section
        ref={heroRef}
        onMouseMove={handleMouseMove}
        className="relative z-10 min-h-[90vh] flex flex-col items-center justify-center px-6 py-20"
      >
        <div className={`text-center max-w-5xl mx-auto transition-all duration-1000 ${isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-10'}`}>
          {/* Badge */}
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-blue-500/10 border border-blue-500/20 mb-8">
            <Sparkles className="w-4 h-4 text-blue-400" />
            <span className="text-sm text-blue-300">Enterprise-Grade Risk Intelligence</span>
          </div>

          {/* Main Headline */}
          <h1 className="text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-black tracking-tight leading-[0.9] mb-8">
            <span className="block text-white">Predict Market</span>
            <span className="block bg-gradient-to-r from-blue-400 via-cyan-400 to-purple-500 bg-clip-text text-transparent py-2">
              Cascades
            </span>
            <span className="block text-white">Before They Strike</span>
          </h1>

          {/* Subtitle */}
          <p className="text-xl text-slate-400 max-w-2xl mx-auto mb-12 leading-relaxed">
            Real-time liquidation prediction across <span className="text-white font-semibold">13+ exchanges</span>.
            Protect your users. Prevent billion-dollar cascades.
            <span className="text-blue-400 font-semibold"> Built for top exchanges.</span>
          </p>

          {/* CTA Buttons */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16">
            <button
              onClick={onEnter}
              className="group relative px-8 py-4 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 text-white font-bold text-lg shadow-2xl shadow-blue-500/25 hover:shadow-blue-500/40 hover:scale-105 transition-all flex items-center gap-3"
            >
              <span>Enter Terminal</span>
              <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
              <div className="absolute inset-0 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 blur-xl opacity-50 group-hover:opacity-75 transition-opacity -z-10" />
            </button>
            <a
              href="#api"
              className="px-8 py-4 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 font-medium transition-all flex items-center gap-2"
            >
              <Server className="w-5 h-5" />
              View API Docs
            </a>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 max-w-3xl mx-auto">
            <div className="text-center">
              <div className="text-4xl font-black text-white mb-1">
                <AnimatedCounter end={13} suffix="+" />
              </div>
              <div className="text-sm text-slate-500">Exchanges</div>
            </div>
            <div className="text-center">
              <div className="text-4xl font-black text-white mb-1">
                <AnimatedCounter end={25} suffix="+" />
              </div>
              <div className="text-sm text-slate-500">Assets</div>
            </div>
            <div className="text-center">
              <div className="text-4xl font-black text-white mb-1">
                &lt;<AnimatedCounter end={1} />s
              </div>
              <div className="text-sm text-slate-500">Latency</div>
            </div>
            <div className="text-center">
              <div className="text-4xl font-black text-white mb-1">
                <AnimatedCounter end={99} suffix="%" />
              </div>
              <div className="text-sm text-slate-500">Uptime</div>
            </div>
          </div>
        </div>

        {/* Scroll indicator */}
        <div className="absolute bottom-10 left-1/2 -translate-x-1/2 animate-bounce">
          <div className="w-6 h-10 rounded-full border-2 border-white/20 flex items-start justify-center p-2">
            <div className="w-1 h-2 bg-white/50 rounded-full animate-pulse" />
          </div>
        </div>
      </section>

      {/* Exchange Partners Section */}
      <section id="exchanges" className="relative z-10 py-20 border-t border-white/5">
        <div className="max-w-7xl mx-auto px-6">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold mb-4">Trusted by Leading Exchanges</h2>
            <p className="text-slate-400">Real-time data aggregation from the world's top trading platforms</p>
          </div>

          <div className="flex flex-wrap justify-center gap-4 mb-8">
            {['Binance', 'Bybit', 'OKX', 'Bitget', 'Gate.io', 'MEXC', 'KuCoin', 'Kraken', 'dYdX', 'Hyperliquid', 'GMX', 'Jupiter', 'Flash'].map(name => (
              <div key={name} className="px-6 py-3 bg-white/5 rounded-xl border border-white/10 hover:bg-white/10 hover:border-white/20 transition-all">
                <span className="font-medium">{name}</span>
              </div>
            ))}
          </div>

          <p className="text-center text-sm text-slate-500">
            And more exchanges joining every month
          </p>
        </div>
      </section>

      {/* Features Section */}
      <section id="features" className="relative z-10 py-20 border-t border-white/5">
        <div className="max-w-7xl mx-auto px-6">
          <div className="text-center mb-16">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-purple-500/10 border border-purple-500/20 mb-6">
              <Cpu className="w-4 h-4 text-purple-400" />
              <span className="text-sm text-purple-300">Advanced Technology</span>
            </div>
            <h2 className="text-4xl font-bold mb-4">Enterprise-Grade Features</h2>
            <p className="text-slate-400 max-w-2xl mx-auto">
              Everything you need to protect your platform and users from liquidation cascades
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {/* Feature Cards */}
            <FeatureCard
              icon={<Eye className="w-6 h-6" />}
              title="Real-Time Monitoring"
              description="Sub-second updates via WebSocket. Monitor funding rates, open interest, and price deviations across all exchanges instantly."
              color="blue"
            />
            <FeatureCard
              icon={<Target className="w-6 h-6" />}
              title="Cascade Prediction"
              description="AI-powered risk scoring from 0-100. Predict liquidation cascades before they happen with trigger prices and probability scores."
              color="purple"
            />
            <FeatureCard
              icon={<Shield className="w-6 h-6" />}
              title="5 Risk Factors"
              description="Comprehensive analysis including funding rate, OI level, funding divergence, price deviation, and concentration risk."
              color="cyan"
            />
            <FeatureCard
              icon={<Network className="w-6 h-6" />}
              title="Cross-Exchange Data"
              description="Aggregate data from 13+ exchanges. Compare prices, detect arbitrage opportunities, and identify market stress."
              color="green"
            />
            <FeatureCard
              icon={<Zap className="w-6 h-6" />}
              title="Webhook Alerts"
              description="Instant notifications when risk levels change. HMAC-signed payloads for secure integration with your systems."
              color="yellow"
            />
            <FeatureCard
              icon={<Lock className="w-6 h-6" />}
              title="Enterprise Security"
              description="API key authentication, rate limiting, request signing, and comprehensive audit logging for compliance."
              color="red"
            />
          </div>
        </div>
      </section>

      {/* API Section */}
      <section id="api" className="relative z-10 py-20 border-t border-white/5">
        <div className="max-w-7xl mx-auto px-6">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            <div>
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-cyan-500/10 border border-cyan-500/20 mb-6">
                <Server className="w-4 h-4 text-cyan-400" />
                <span className="text-sm text-cyan-300">REST + WebSocket API</span>
              </div>
              <h2 className="text-4xl font-bold mb-6">Simple Integration</h2>
              <p className="text-slate-400 mb-8">
                Get started in minutes with our comprehensive API. Real-time data streaming,
                historical analysis, and webhook notifications - everything you need.
              </p>

              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <Check className="w-5 h-5 text-green-500" />
                  <span>RESTful endpoints with JSON responses</span>
                </div>
                <div className="flex items-center gap-3">
                  <Check className="w-5 h-5 text-green-500" />
                  <span>WebSocket for real-time streaming</span>
                </div>
                <div className="flex items-center gap-3">
                  <Check className="w-5 h-5 text-green-500" />
                  <span>HMAC-signed webhook payloads</span>
                </div>
                <div className="flex items-center gap-3">
                  <Check className="w-5 h-5 text-green-500" />
                  <span>Rate limiting with clear headers</span>
                </div>
              </div>
            </div>

            <div className="bg-[#0d0e14] rounded-2xl border border-white/10 overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-3 border-b border-white/5 bg-white/5">
                <div className="w-3 h-3 rounded-full bg-red-500" />
                <div className="w-3 h-3 rounded-full bg-yellow-500" />
                <div className="w-3 h-3 rounded-full bg-green-500" />
                <span className="ml-2 text-xs text-slate-500 font-mono">api-example.sh</span>
              </div>
              <pre className="p-4 text-sm font-mono overflow-x-auto">
                <code className="text-slate-300">
{`# Get current risk analysis
curl -X GET "https://api.prism.ai/v1/risk" \\
  -H "X-API-Key: your_api_key"

# Response
{
  "success": true,
  "risks": [{
    "symbol": "BTC",
    "riskScore": 65,
    "riskLevel": "elevated",
    "prediction": {
      "direction": "long_squeeze",
      "probability": 0.72,
      "triggerPrice": 82450,
      "timeWindow": "4-12 hours"
    }
  }]
}`}
                </code>
              </pre>
            </div>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="relative z-10 py-20 border-t border-white/5">
        <div className="max-w-4xl mx-auto px-6 text-center">
          <div className="p-12 rounded-3xl bg-gradient-to-b from-blue-500/10 to-purple-500/10 border border-white/10">
            <AlertTriangle className="w-12 h-12 text-yellow-500 mx-auto mb-6" />
            <h2 className="text-3xl font-bold mb-4">Don't Let Cascades Crash Your Platform</h2>
            <p className="text-slate-400 mb-8 max-w-xl mx-auto">
              Join the exchanges already using Prism to protect their users and maintain market stability.
              See the risk intelligence terminal in action.
            </p>
            <button
              onClick={onEnter}
              className="group px-8 py-4 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 text-white font-bold text-lg shadow-2xl shadow-blue-500/25 hover:shadow-blue-500/40 hover:scale-105 transition-all inline-flex items-center gap-3"
            >
              <span>Enter Terminal Now</span>
              <ChevronRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
            </button>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="relative z-10 border-t border-white/5 py-12">
        <div className="max-w-7xl mx-auto px-6">
          <div className="flex flex-col md:flex-row items-center justify-between gap-6">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
                <Activity className="w-4 h-4" />
              </div>
              <span className="font-bold">PRISM</span>
              <span className="text-slate-500">|</span>
              <span className="text-sm text-slate-500">Cross-Exchange Risk Intelligence</span>
            </div>
            <div className="flex items-center gap-6 text-sm text-slate-500">
              <span>API Status: <span className="text-green-400">Operational</span></span>
              <span>v1.0.0</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  )
}

function FeatureCard({ icon, title, description, color }: { icon: React.ReactNode; title: string; description: string; color: string }) {
  const colorMap: Record<string, string> = {
    blue: 'from-blue-500/20 to-transparent border-blue-500/20 hover:border-blue-500/40',
    purple: 'from-purple-500/20 to-transparent border-purple-500/20 hover:border-purple-500/40',
    cyan: 'from-cyan-500/20 to-transparent border-cyan-500/20 hover:border-cyan-500/40',
    green: 'from-green-500/20 to-transparent border-green-500/20 hover:border-green-500/40',
    yellow: 'from-yellow-500/20 to-transparent border-yellow-500/20 hover:border-yellow-500/40',
    red: 'from-red-500/20 to-transparent border-red-500/20 hover:border-red-500/40'
  }

  const iconColorMap: Record<string, string> = {
    blue: 'text-blue-400',
    purple: 'text-purple-400',
    cyan: 'text-cyan-400',
    green: 'text-green-400',
    yellow: 'text-yellow-400',
    red: 'text-red-400'
  }

  return (
    <div className={`p-6 rounded-2xl bg-gradient-to-b ${colorMap[color]} border backdrop-blur-sm transition-all hover:scale-[1.02]`}>
      <div className={`w-12 h-12 rounded-xl bg-white/5 flex items-center justify-center mb-4 ${iconColorMap[color]}`}>
        {icon}
      </div>
      <h3 className="text-lg font-bold mb-2">{title}</h3>
      <p className="text-sm text-slate-400 leading-relaxed">{description}</p>
    </div>
  )
}

export default LandingPage
