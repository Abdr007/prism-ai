interface Risk {
  symbol: string
  riskScore: number
  riskLevel: 'low' | 'moderate' | 'elevated' | 'high' | 'critical'
}

interface RiskGaugeProps {
  risk: Risk
}

export default function RiskGauge({ risk }: RiskGaugeProps) {
  const { riskScore, riskLevel } = risk

  // Calculate rotation for gauge needle (-90 to 90 degrees)
  const rotation = -90 + (riskScore / 100) * 180

  const levelColors = {
    critical: '#ef4444',
    high: '#f97316',
    elevated: '#f59e0b',
    moderate: '#3b82f6',
    low: '#10b981',
  }

  const levelDescriptions = {
    critical: 'Extreme risk - Cascade imminent',
    high: 'High risk - Take protective action',
    elevated: 'Elevated risk - Monitor closely',
    moderate: 'Moderate risk - Normal conditions',
    low: 'Low risk - Market stable',
  }

  return (
    <div className="flex flex-col items-center">
      {/* Gauge SVG */}
      <div className="relative w-64 h-32 mb-4">
        <svg viewBox="0 0 200 100" className="w-full h-full">
          {/* Background arc */}
          <path
            d="M 20 90 A 80 80 0 0 1 180 90"
            fill="none"
            stroke="#1a1a25"
            strokeWidth="16"
            strokeLinecap="round"
          />

          {/* Colored segments */}
          <path
            d="M 20 90 A 80 80 0 0 1 56 34"
            fill="none"
            stroke="#10b981"
            strokeWidth="16"
            strokeLinecap="round"
          />
          <path
            d="M 56 34 A 80 80 0 0 1 100 10"
            fill="none"
            stroke="#3b82f6"
            strokeWidth="16"
          />
          <path
            d="M 100 10 A 80 80 0 0 1 144 34"
            fill="none"
            stroke="#f59e0b"
            strokeWidth="16"
          />
          <path
            d="M 144 34 A 80 80 0 0 1 180 90"
            fill="none"
            stroke="#ef4444"
            strokeWidth="16"
            strokeLinecap="round"
          />

          {/* Needle */}
          <g transform={`rotate(${rotation} 100 90)`}>
            <line
              x1="100"
              y1="90"
              x2="100"
              y2="25"
              stroke={levelColors[riskLevel]}
              strokeWidth="3"
              strokeLinecap="round"
            />
            <circle cx="100" cy="90" r="8" fill={levelColors[riskLevel]} />
            <circle cx="100" cy="90" r="4" fill="#0a0a0f" />
          </g>

          {/* Labels */}
          <text x="20" y="100" fontSize="10" fill="#6b7280" textAnchor="middle">0</text>
          <text x="100" y="8" fontSize="10" fill="#6b7280" textAnchor="middle">50</text>
          <text x="180" y="100" fontSize="10" fill="#6b7280" textAnchor="middle">100</text>
        </svg>

        {/* Center score */}
        <div className="absolute inset-0 flex items-end justify-center pb-2">
          <div className="text-center">
            <div
              className="text-5xl font-bold font-mono"
              style={{ color: levelColors[riskLevel] }}
            >
              {riskScore}
            </div>
          </div>
        </div>
      </div>

      {/* Risk level badge */}
      <div
        className="px-4 py-2 rounded-full font-semibold text-sm uppercase tracking-wide"
        style={{
          backgroundColor: `${levelColors[riskLevel]}20`,
          color: levelColors[riskLevel],
          border: `1px solid ${levelColors[riskLevel]}50`,
        }}
      >
        {riskLevel} Risk
      </div>

      {/* Description */}
      <p className="mt-3 text-sm text-gray-400 text-center">
        {levelDescriptions[riskLevel]}
      </p>
    </div>
  )
}
