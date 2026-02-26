import { useState, useEffect } from 'react'

interface IntroAnimationProps {
  onComplete: () => void
  duration?: number // in ms
}

export function IntroAnimation({ onComplete, duration = 5000 }: IntroAnimationProps) {
  const [phase, setPhase] = useState(0)
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    // Progress animation
    const startTime = Date.now()
    const progressInterval = setInterval(() => {
      const elapsed = Date.now() - startTime
      setProgress(Math.min(100, (elapsed / duration) * 100))
    }, 50)

    // Phase transitions
    const timers = [
      setTimeout(() => setPhase(1), 500),
      setTimeout(() => setPhase(2), 1500),
      setTimeout(() => setPhase(3), 2500),
      setTimeout(() => setPhase(4), 3500),
      setTimeout(() => setPhase(5), 4500),
      setTimeout(() => {
        clearInterval(progressInterval)
        onComplete()
      }, duration),
    ]

    return () => {
      clearInterval(progressInterval)
      timers.forEach(t => clearTimeout(t))
    }
  }, [duration, onComplete])

  return (
    <div className="fixed inset-0 z-[100] bg-[#030305] flex items-center justify-center overflow-hidden">
      {/* Animated background */}
      <div className="absolute inset-0">
        {/* Radial pulse */}
        <div
          className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 transition-all duration-1000 ${
            phase >= 1 ? 'opacity-100 scale-100' : 'opacity-0 scale-0'
          }`}
          style={{
            width: '200vw',
            height: '200vh',
            background: 'radial-gradient(circle, rgba(59, 130, 246, 0.1) 0%, transparent 50%)',
          }}
        />

        {/* Grid lines */}
        <div
          className={`absolute inset-0 transition-opacity duration-1000 ${phase >= 2 ? 'opacity-100' : 'opacity-0'}`}
          style={{
            backgroundImage: `
              linear-gradient(rgba(59, 130, 246, 0.1) 1px, transparent 1px),
              linear-gradient(90deg, rgba(59, 130, 246, 0.1) 1px, transparent 1px)
            `,
            backgroundSize: '50px 50px',
            animation: 'gridPulse 2s ease-in-out infinite',
          }}
        />

        {/* Orbiting particles */}
        {phase >= 2 && Array.from({ length: 20 }).map((_, i) => (
          <div
            key={i}
            className="absolute w-1 h-1 rounded-full bg-blue-400"
            style={{
              left: '50%',
              top: '50%',
              animation: `orbit ${3 + i * 0.2}s linear infinite`,
              animationDelay: `${i * 0.1}s`,
              transformOrigin: `${100 + i * 15}px center`,
            }}
          />
        ))}

        {/* Glowing orbs */}
        <div
          className={`absolute w-64 h-64 rounded-full blur-3xl transition-all duration-1000 ${
            phase >= 1 ? 'opacity-60' : 'opacity-0'
          }`}
          style={{
            background: 'radial-gradient(circle, rgba(59, 130, 246, 0.4) 0%, transparent 70%)',
            top: '30%',
            left: '20%',
            animation: 'float 4s ease-in-out infinite',
          }}
        />
        <div
          className={`absolute w-48 h-48 rounded-full blur-3xl transition-all duration-1000 ${
            phase >= 1 ? 'opacity-40' : 'opacity-0'
          }`}
          style={{
            background: 'radial-gradient(circle, rgba(147, 51, 234, 0.4) 0%, transparent 70%)',
            bottom: '20%',
            right: '25%',
            animation: 'float 5s ease-in-out infinite reverse',
          }}
        />
      </div>

      {/* Main content */}
      <div className="relative z-10 text-center">
        {/* Logo */}
        <div
          className={`mb-8 transition-all duration-1000 ${
            phase >= 1 ? 'opacity-100 scale-100' : 'opacity-0 scale-50'
          }`}
        >
          <div className="relative inline-block">
            {/* Glowing ring */}
            <div
              className={`absolute inset-0 rounded-full transition-all duration-1000 ${
                phase >= 2 ? 'opacity-100' : 'opacity-0'
              }`}
              style={{
                background: 'conic-gradient(from 0deg, #3b82f6, #8b5cf6, #ec4899, #3b82f6)',
                filter: 'blur(20px)',
                animation: 'spin 3s linear infinite',
              }}
            />

            {/* Logo box */}
            <div className="relative w-32 h-32 rounded-3xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center shadow-2xl">
              <svg
                viewBox="0 0 100 100"
                className="w-20 h-20"
                style={{
                  animation: phase >= 2 ? 'pulse 2s ease-in-out infinite' : 'none',
                }}
              >
                {/* Prism shape */}
                <defs>
                  <linearGradient id="prismGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#ffffff" stopOpacity="0.9" />
                    <stop offset="100%" stopColor="#ffffff" stopOpacity="0.4" />
                  </linearGradient>
                </defs>
                <polygon
                  points="50,10 90,80 10,80"
                  fill="none"
                  stroke="url(#prismGrad)"
                  strokeWidth="4"
                  strokeLinejoin="round"
                />
                {/* Light ray */}
                <line
                  x1="20"
                  y1="45"
                  x2="50"
                  y2="50"
                  stroke="white"
                  strokeWidth="2"
                  strokeLinecap="round"
                  className={phase >= 3 ? 'opacity-100' : 'opacity-0'}
                  style={{ transition: 'opacity 0.5s' }}
                />
                {/* Refracted rays */}
                <g className={phase >= 3 ? 'opacity-100' : 'opacity-0'} style={{ transition: 'opacity 0.5s' }}>
                  <line x1="50" y1="50" x2="85" y2="35" stroke="#ff6b6b" strokeWidth="2" strokeLinecap="round" />
                  <line x1="50" y1="50" x2="88" y2="45" stroke="#ffd93d" strokeWidth="2" strokeLinecap="round" />
                  <line x1="50" y1="50" x2="90" y2="55" stroke="#6bcb77" strokeWidth="2" strokeLinecap="round" />
                  <line x1="50" y1="50" x2="88" y2="65" stroke="#4d96ff" strokeWidth="2" strokeLinecap="round" />
                </g>
              </svg>
            </div>
          </div>
        </div>

        {/* Title */}
        <h1
          className={`text-6xl font-black tracking-tight mb-4 transition-all duration-700 ${
            phase >= 2 ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'
          }`}
        >
          <span className="bg-gradient-to-r from-blue-400 via-purple-400 to-pink-400 bg-clip-text text-transparent">
            PRISM
          </span>
        </h1>

        {/* Tagline */}
        <p
          className={`text-xl text-slate-400 mb-8 transition-all duration-700 delay-200 ${
            phase >= 3 ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'
          }`}
        >
          Cross-Exchange Risk Intelligence
        </p>

        {/* Stats */}
        <div
          className={`flex items-center justify-center gap-8 mb-12 transition-all duration-700 ${
            phase >= 4 ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'
          }`}
        >
          {[
            { value: '13+', label: 'Exchanges' },
            { value: '25+', label: 'Assets' },
            { value: '<1s', label: 'Latency' },
          ].map((stat, i) => (
            <div key={i} className="text-center">
              <div className="text-2xl font-bold text-white">{stat.value}</div>
              <div className="text-xs text-slate-500 uppercase tracking-wider">{stat.label}</div>
            </div>
          ))}
        </div>

        {/* Loading text */}
        <div
          className={`transition-all duration-500 ${
            phase >= 4 ? 'opacity-100' : 'opacity-0'
          }`}
        >
          <p className="text-sm text-slate-500 mb-3">
            {progress < 30 && 'Connecting to exchanges...'}
            {progress >= 30 && progress < 60 && 'Loading market data...'}
            {progress >= 60 && progress < 90 && 'Analyzing risk patterns...'}
            {progress >= 90 && 'Ready!'}
          </p>

          {/* Progress bar */}
          <div className="w-64 mx-auto h-1 bg-white/10 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-blue-500 to-purple-500 rounded-full transition-all duration-100"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      </div>

      {/* CSS Animations */}
      <style>{`
        @keyframes orbit {
          from { transform: rotate(0deg) translateX(100px); }
          to { transform: rotate(360deg) translateX(100px); }
        }

        @keyframes float {
          0%, 100% { transform: translate(0, 0); }
          50% { transform: translate(20px, -20px); }
        }

        @keyframes gridPulse {
          0%, 100% { opacity: 0.3; }
          50% { opacity: 0.6; }
        }

        @keyframes pulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.05); }
        }

        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}

export default IntroAnimation
