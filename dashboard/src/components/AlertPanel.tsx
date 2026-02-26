import { AlertTriangle, TrendingDown, TrendingUp, Bell } from 'lucide-react'

interface Risk {
  symbol: string
  riskScore: number
  riskLevel: 'low' | 'moderate' | 'elevated' | 'high' | 'critical'
  prediction: {
    direction: 'long_squeeze' | 'short_squeeze'
    probability: number
    estimatedImpact: number
  } | null
}

interface AlertPanelProps {
  risks: Risk[]
}

export default function AlertPanel({ risks }: AlertPanelProps) {
  const alerts = risks.filter(r =>
    r.riskLevel === 'critical' || r.riskLevel === 'high' || r.riskLevel === 'elevated'
  )

  const formatValue = (n: number) => {
    if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`
    if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`
    return `$${n.toLocaleString()}`
  }

  if (alerts.length === 0) {
    return (
      <div className="glass rounded-2xl p-6">
        <div className="flex items-center gap-2 mb-4">
          <Bell className="w-5 h-5 text-gray-400" />
          <h2 className="text-lg font-semibold text-white">Alerts</h2>
        </div>
        <div className="text-center py-8 text-gray-500">
          <div className="w-12 h-12 rounded-full bg-accent-green/20 flex items-center justify-center mx-auto mb-3">
            <svg className="w-6 h-6 text-accent-green" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <p className="font-medium text-white">All Clear</p>
          <p className="text-sm">No active risk alerts</p>
        </div>
      </div>
    )
  }

  return (
    <div className="glass rounded-2xl p-6 border border-accent-orange/30">
      <div className="flex items-center gap-2 mb-4">
        <AlertTriangle className="w-5 h-5 text-accent-orange" />
        <h2 className="text-lg font-semibold text-white">Active Alerts</h2>
        <span className="ml-auto px-2 py-0.5 rounded-full bg-accent-orange/20 text-accent-orange text-xs font-medium">
          {alerts.length}
        </span>
      </div>

      <div className="space-y-3">
        {alerts.map(alert => (
          <div
            key={alert.symbol}
            className={`p-4 rounded-xl ${
              alert.riskLevel === 'critical'
                ? 'bg-accent-red/10 border border-accent-red/30'
                : alert.riskLevel === 'high'
                ? 'bg-accent-orange/10 border border-accent-orange/30'
                : 'bg-accent-yellow/10 border border-accent-yellow/30'
            }`}
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="font-bold text-white">{alert.symbol}</span>
                {alert.prediction && (
                  alert.prediction.direction === 'long_squeeze' ? (
                    <TrendingDown className="w-4 h-4 text-accent-red" />
                  ) : (
                    <TrendingUp className="w-4 h-4 text-accent-green" />
                  )
                )}
              </div>
              <span className={`text-lg font-bold font-mono ${
                alert.riskLevel === 'critical' ? 'text-accent-red' :
                alert.riskLevel === 'high' ? 'text-accent-orange' :
                'text-accent-yellow'
              }`}>
                {alert.riskScore}
              </span>
            </div>

            {alert.prediction && (
              <div className="flex items-center gap-4 text-xs text-gray-400">
                <span>
                  {alert.prediction.direction === 'long_squeeze' ? 'Long Squeeze' : 'Short Squeeze'}
                </span>
                <span>{(alert.prediction.probability * 100).toFixed(0)}% prob</span>
                <span>{formatValue(alert.prediction.estimatedImpact)} impact</span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
