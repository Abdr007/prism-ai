interface ExchangeBarProps {
  data: Record<string, number>
  total: number
}

const exchangeColors: Record<string, string> = {
  binance: '#F0B90B',
  bybit: '#FF6600',
  okx: '#FFFFFF',
  dydx: '#6966FF',
  hyperliquid: '#00D395',
}

export default function ExchangeBar({ data, total }: ExchangeBarProps) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1])

  const formatValue = (n: number) => {
    if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
    if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
    return `$${n.toLocaleString()}`
  }

  return (
    <div className="space-y-4">
      {/* Stacked bar */}
      <div className="h-8 rounded-full overflow-hidden flex bg-prism-600">
        {entries.map(([exchange, value]) => {
          const percentage = (value / total) * 100
          if (percentage < 0.5) return null

          return (
            <div
              key={exchange}
              className="h-full transition-all duration-500 relative group"
              style={{
                width: `${percentage}%`,
                backgroundColor: exchangeColors[exchange] || '#6b7280',
              }}
            >
              <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                <span className="text-xs font-bold text-black drop-shadow">
                  {percentage.toFixed(1)}%
                </span>
              </div>
            </div>
          )
        })}
      </div>

      {/* Legend */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {entries.map(([exchange, value]) => {
          const percentage = (value / total) * 100

          return (
            <div key={exchange} className="flex items-center gap-2">
              <div
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: exchangeColors[exchange] || '#6b7280' }}
              />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-white capitalize truncate">
                  {exchange}
                </div>
                <div className="text-xs text-gray-500">
                  {formatValue(value)} ({percentage.toFixed(1)}%)
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
