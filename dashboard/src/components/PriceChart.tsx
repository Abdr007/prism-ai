// Placeholder for future chart implementation
// Can use recharts or similar library

interface PriceChartProps {
  symbol: string
}

export default function PriceChart({ symbol }: PriceChartProps) {
  return (
    <div className="h-64 flex items-center justify-center text-gray-500">
      <div className="text-center">
        <div className="text-4xl mb-2">📈</div>
        <div>Price chart for {symbol}</div>
        <div className="text-sm">Coming soon</div>
      </div>
    </div>
  )
}
