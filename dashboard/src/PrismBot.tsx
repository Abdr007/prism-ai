import { useState, useRef, useEffect } from 'react'
import { MessageCircle, X, Send, Bot, User, Sparkles } from 'lucide-react'

interface Message {
  role: 'user' | 'bot'
  content: string
  timestamp: Date
}

// Prism AI Knowledge Base
const PRISM_KNOWLEDGE = {
  // General info
  about: `Prism is a cross-exchange liquidation cascade prediction platform. It monitors 13+ cryptocurrency exchanges in real-time to detect market stress signals and predict potential liquidation cascades before they happen.`,

  // What is a liquidation cascade
  cascade: `A liquidation cascade happens when many leveraged traders get liquidated at once. When a trader's margin falls below the maintenance level, their position is forcibly closed. This selling/buying pressure moves the price, which triggers more liquidations, creating a chain reaction or "cascade" that can cause dramatic price movements.`,

  // Risk factors
  factors: {
    funding: `**Funding Rate** measures the fee traders pay to keep positions open. When it's highly positive, longs are paying shorts (too many buyers). When it's negative, shorts are paying longs. Extreme funding rates often precede liquidation cascades as the crowded side gets squeezed.`,
    oi: `**Open Interest** is the total value of all open positions. High OI means more money is at risk. When OI is significantly above average, there's more potential for large liquidation cascades.`,
    divergence: `**Funding Divergence** measures how different funding rates are across exchanges. Large gaps indicate arbitrage opportunities and market inefficiency, which can trigger sudden price corrections.`,
    deviation: `**Price Deviation** shows how much prices differ between exchanges. Big spreads indicate market stress and can signal incoming volatility as arbitrageurs rush to close the gap.`,
    concentration: `**OI Concentration** measures how much of the total position is on a single exchange. High concentration means one exchange could trigger a localized cascade that spreads to others.`
  },

  // Risk levels
  riskLevels: {
    low: `**Low Risk (0-20)**: Market conditions are healthy. Positions are well-distributed and funding rates are normal. Low chance of sudden liquidation cascades.`,
    moderate: `**Moderate Risk (20-40)**: Some minor imbalances exist but nothing concerning. Worth keeping an eye on.`,
    elevated: `**Elevated Risk (40-60)**: The market is getting crowded on one side. Increased chance of volatility.`,
    high: `**High Risk (60-80)**: Dangerous conditions. Many leveraged positions could get liquidated if price moves against them.`,
    critical: `**Critical Risk (80-100)**: Extreme market stress. Liquidation cascade is likely imminent. Exercise extreme caution.`
  },

  // Squeeze types
  squeeze: {
    long: `**Long Squeeze**: When there are too many buyers (positive funding), a price drop can trigger mass liquidations of long positions. This selling pressure pushes the price down further, triggering more liquidations.`,
    short: `**Short Squeeze**: When there are too many sellers (negative funding), a price increase can trigger mass liquidations of short positions. This buying pressure pushes the price up further, triggering more liquidations.`
  },

  // Exchanges
  exchanges: `Prism monitors these exchanges:
• **CEX**: Binance, Bybit, OKX, Bitget, Gate.io, MEXC, KuCoin, Kraken
• **DEX**: dYdX, Hyperliquid, GMX, Jupiter, Flash.trade

Data is aggregated in real-time via WebSocket connections for instant updates.`,

  // How to use
  howToUse: `**How to use Prism:**
1. **Monitor the Asset Grid** - Cards show risk level and mini price chart for each crypto
2. **Click an Asset** - View detailed analysis with live chart and risk breakdown
3. **Check Risk Factors** - Understand what's contributing to the risk score
4. **Watch for Predictions** - When risk is elevated, predictions show likely squeeze direction and trigger prices
5. **Compare Exchanges** - See price differences across exchanges for arbitrage opportunities`,

  // API info
  api: `**Prism API Endpoints:**
• \`GET /api/v1/data\` - All exchange data
• \`GET /api/v1/risk\` - Cascade risk analysis
• \`GET /api/v1/symbols/:s\` - Data for specific symbol
• \`GET /api/v1/prices\` - Price comparison across exchanges
• \`GET /api/v1/alerts\` - Active risk alerts

WebSocket: \`ws://localhost:3000/ws\` for real-time updates`,

  // Trigger price
  trigger: `**Trigger Price** is the price level that could initiate a liquidation cascade. For a long squeeze, it's below the current price. For a short squeeze, it's above. When price approaches this level, liquidations become more likely.`,

  // Time window
  timeWindow: `**Time Window** estimates when the predicted event is most likely to occur based on funding rate urgency and market conditions. Shorter windows indicate higher urgency.`
}

// Smart response generator
function generateResponse(input: string): string {
  const query = input.toLowerCase()

  // Greetings
  if (query.match(/^(hi|hello|hey|sup|yo)/)) {
    return `Hello! I'm the Prism AI assistant. I can help you understand:\n\n• What liquidation cascades are\n• How to read risk scores and factors\n• What each metric means\n• How to use the dashboard\n• API documentation\n\nWhat would you like to know?`
  }

  // About Prism
  if (query.includes('what is prism') || query.includes('about prism') || query.includes('what does prism do')) {
    return PRISM_KNOWLEDGE.about
  }

  // Liquidation cascade
  if (query.includes('cascade') || query.includes('liquidation')) {
    return PRISM_KNOWLEDGE.cascade
  }

  // Funding rate
  if (query.includes('funding rate') || query.includes('funding')) {
    return PRISM_KNOWLEDGE.factors.funding
  }

  // Open interest
  if (query.includes('open interest') || query.includes(' oi ') || query.match(/\boi\b/)) {
    return PRISM_KNOWLEDGE.factors.oi
  }

  // Divergence
  if (query.includes('divergence')) {
    return PRISM_KNOWLEDGE.factors.divergence
  }

  // Price deviation
  if (query.includes('deviation') || query.includes('price spread')) {
    return PRISM_KNOWLEDGE.factors.deviation
  }

  // Concentration
  if (query.includes('concentration')) {
    return PRISM_KNOWLEDGE.factors.concentration
  }

  // Risk levels
  if (query.includes('risk level') || query.includes('risk score') || query.includes('what does') && query.includes('mean')) {
    if (query.includes('low')) return PRISM_KNOWLEDGE.riskLevels.low
    if (query.includes('moderate')) return PRISM_KNOWLEDGE.riskLevels.moderate
    if (query.includes('elevated')) return PRISM_KNOWLEDGE.riskLevels.elevated
    if (query.includes('high')) return PRISM_KNOWLEDGE.riskLevels.high
    if (query.includes('critical')) return PRISM_KNOWLEDGE.riskLevels.critical

    return `**Risk Levels:**\n\n${Object.values(PRISM_KNOWLEDGE.riskLevels).join('\n\n')}`
  }

  // Squeeze
  if (query.includes('squeeze')) {
    if (query.includes('long')) return PRISM_KNOWLEDGE.squeeze.long
    if (query.includes('short')) return PRISM_KNOWLEDGE.squeeze.short
    return `${PRISM_KNOWLEDGE.squeeze.long}\n\n${PRISM_KNOWLEDGE.squeeze.short}`
  }

  // Exchanges
  if (query.includes('exchange') || query.includes('which') && (query.includes('monitor') || query.includes('track'))) {
    return PRISM_KNOWLEDGE.exchanges
  }

  // How to use
  if (query.includes('how to') || query.includes('how do i') || query.includes('guide') || query.includes('help')) {
    return PRISM_KNOWLEDGE.howToUse
  }

  // API
  if (query.includes('api') || query.includes('endpoint') || query.includes('websocket')) {
    return PRISM_KNOWLEDGE.api
  }

  // Trigger price
  if (query.includes('trigger') && query.includes('price')) {
    return PRISM_KNOWLEDGE.trigger
  }

  // Time window
  if (query.includes('time window') || query.includes('timeframe')) {
    return PRISM_KNOWLEDGE.timeWindow
  }

  // Factors
  if (query.includes('factor') || query.includes('metric')) {
    return `**Risk Factors:**\n\n${Object.values(PRISM_KNOWLEDGE.factors).join('\n\n')}`
  }

  // Default response
  return `I can help you with:\n\n• **"What is Prism?"** - Learn about the platform\n• **"What is a liquidation cascade?"** - Understand the core concept\n• **"Explain funding rate"** - Learn about specific factors\n• **"What are the risk levels?"** - Understand risk scoring\n• **"How to use the dashboard?"** - Get a quick guide\n• **"Show me the API endpoints"** - Technical documentation\n\nTry asking about any of these topics!`
}

export function PrismBot() {
  const [isOpen, setIsOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'bot',
      content: "Hi! I'm the Prism AI assistant. I know everything about liquidation cascades, risk factors, and how to use this platform. Ask me anything!",
      timestamp: new Date()
    }
  ])
  const [input, setInput] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const sendMessage = () => {
    if (!input.trim()) return

    const userMessage: Message = {
      role: 'user',
      content: input,
      timestamp: new Date()
    }

    setMessages(prev => [...prev, userMessage])
    setInput('')

    // Simulate typing delay
    setTimeout(() => {
      const botResponse: Message = {
        role: 'bot',
        content: generateResponse(input),
        timestamp: new Date()
      }
      setMessages(prev => [...prev, botResponse])
    }, 500)
  }

  return (
    <>
      {/* Chat Button */}
      <button
        onClick={() => setIsOpen(true)}
        className={`fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full bg-gradient-to-r from-blue-500 to-purple-600 flex items-center justify-center shadow-lg shadow-blue-500/30 hover:scale-110 transition-all ${isOpen ? 'hidden' : ''}`}
      >
        <MessageCircle className="w-6 h-6 text-white" />
        <span className="absolute -top-1 -right-1 w-4 h-4 bg-green-500 rounded-full border-2 border-[#0a0b0f] animate-pulse" />
      </button>

      {/* Chat Window */}
      {isOpen && (
        <div className="fixed bottom-6 right-6 z-50 w-96 h-[500px] bg-[#0d0e14] rounded-2xl border border-white/10 shadow-2xl shadow-black/50 flex flex-col overflow-hidden">
          {/* Header */}
          <div className="p-4 border-b border-white/5 bg-gradient-to-r from-blue-500/10 to-purple-500/10 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
                <Sparkles className="w-5 h-5 text-white" />
              </div>
              <div>
                <h3 className="font-bold text-white">Prism Assistant</h3>
                <p className="text-xs text-green-400 flex items-center gap-1">
                  <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                  Online
                </p>
              </div>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="p-2 hover:bg-white/10 rounded-lg transition-colors"
            >
              <X className="w-5 h-5 text-slate-400" />
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}
              >
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
                  msg.role === 'user'
                    ? 'bg-blue-500/20'
                    : 'bg-purple-500/20'
                }`}>
                  {msg.role === 'user'
                    ? <User className="w-4 h-4 text-blue-400" />
                    : <Bot className="w-4 h-4 text-purple-400" />
                  }
                </div>
                <div className={`max-w-[80%] p-3 rounded-xl ${
                  msg.role === 'user'
                    ? 'bg-blue-500/20 text-white'
                    : 'bg-white/5 text-slate-300'
                }`}>
                  <div className="text-sm whitespace-pre-wrap leading-relaxed">
                    {msg.content.split('**').map((part, idx) =>
                      idx % 2 === 1 ? <strong key={idx} className="text-white">{part}</strong> : part
                    )}
                  </div>
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="p-4 border-t border-white/5">
            <div className="flex gap-2">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
                placeholder="Ask about Prism..."
                className="flex-1 px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-blue-500/50 text-sm"
              />
              <button
                onClick={sendMessage}
                disabled={!input.trim()}
                className="px-4 py-3 bg-gradient-to-r from-blue-500 to-purple-600 rounded-xl hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Send className="w-4 h-4 text-white" />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export default PrismBot
