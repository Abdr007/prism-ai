import { TrendingDown, TrendingUp } from 'lucide-react'

interface Risk {
  symbol: string
  riskScore: number
  riskLevel: 'low' | 'moderate' | 'elevated' | 'high' | 'critical'
  prediction: {
    direction: 'long_squeeze' | 'short_squeeze'
  } | null
}

interface RiskCardProps {
  risk: Risk
  selected: boolean
  onClick: () => void
}

export default function RiskCard({ risk, selected, onClick }: RiskCardProps) {
  const levelColors = {
    critical: 'bg-accent-red/20 border-accent-red/50 text-accent-red',
    high: 'bg-accent-orange/20 border-accent-orange/50 text-accent-orange',
    elevated: 'bg-accent-yellow/20 border-accent-yellow/50 text-accent-yellow',
    moderate: 'bg-accent-blue/20 border-accent-blue/50 text-accent-blue',
    low: 'bg-accent-green/20 border-accent-green/50 text-accent-green',
  }

  const scoreColors = {
    critical: 'text-accent-red',
    high: 'text-accent-orange',
    elevated: 'text-accent-yellow',
    moderate: 'text-accent-blue',
    low: 'text-accent-green',
  }

  return (
    <button
      onClick={onClick}
      className={`w-full p-4 rounded-xl border transition-all text-left ${
        selected
          ? 'bg-accent-blue/10 border-accent-blue/50'
          : 'bg-prism-700 border-transparent hover:border-white/10'
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg font-bold text-white">{risk.symbol}</span>
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${levelColors[risk.riskLevel]}`}>
            {risk.riskLevel.toUpperCase()}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {risk.prediction && (
            risk.prediction.direction === 'long_squeeze' ? (
              <TrendingDown className="w-4 h-4 text-accent-red" />
            ) : (
              <TrendingUp className="w-4 h-4 text-accent-green" />
            )
          )}
          <span className={`text-xl font-bold font-mono ${scoreColors[risk.riskLevel]}`}>
            {risk.riskScore}
          </span>
        </div>
      </div>
    </button>
  )
}
