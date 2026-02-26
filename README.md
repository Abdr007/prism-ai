# PRISM AI

**Cross-Exchange AI Risk Intelligence Platform for Perpetual Futures Markets**

PRISM (Predictive Risk Intelligence System for Markets) is an advanced AI-powered platform that predicts liquidation cascades across cryptocurrency exchanges in real-time. It aggregates data from 13+ exchanges to detect market stress signals and provides actionable trading insights.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-green.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue.svg)

---

## Features

### Core Capabilities

- **Real-Time Risk Analysis**: Monitors 25+ cryptocurrencies across 13 exchanges
- **AI Liquidation Prediction**: Predicts long/short squeezes with confidence scores
- **Cross-Exchange Data Aggregation**: Combines data from CEX and DEX platforms
- **Live Stock Tracking**: Major stocks (TSLA, AAPL, NVDA, etc.) with risk analysis
- **News Feed**: Crypto, blockchain, and tech news integration

### Exchanges Supported

**Centralized (CEX)**:
- Binance, Bybit, OKX, Bitget, Gate.io, MEXC, KuCoin, Kraken

**Decentralized (DEX)**:
- dYdX, Hyperliquid, GMX, Jupiter (Solana), Flash (Solana)

### Risk Factors Analyzed

| Factor | Weight | Description |
|--------|--------|-------------|
| Funding Rate | 30% | Cost to hold leveraged positions |
| Open Interest | 25% | Total active positions vs historical average |
| Funding Divergence | 20% | Funding rate spread between exchanges |
| Price Deviation | 15% | Price differences across exchanges |
| OI Concentration | 10% | Position concentration on single exchange |

---

## Architecture

```
prism-ai/
├── src/
│   ├── exchanges/           # Exchange API clients (13 exchanges)
│   │   ├── binance.ts       # Binance Futures
│   │   ├── bybit.ts         # Bybit Derivatives
│   │   ├── okx.ts           # OKX Perpetuals
│   │   ├── dydx.ts          # dYdX (decentralized)
│   │   ├── hyperliquid.ts   # Hyperliquid (decentralized)
│   │   ├── jupiter.ts       # Jupiter Perps (Solana)
│   │   └── ...
│   │
│   ├── aggregator/          # Cross-exchange data merging
│   │   └── index.ts         # Combines data from all exchanges
│   │
│   ├── predictor/           # AI Cascade Prediction Engine
│   │   └── cascade.ts       # Risk scoring & prediction algorithms
│   │
│   ├── stocks/              # Stock market data client
│   │   └── client.ts        # Yahoo Finance integration
│   │
│   ├── oracle/              # Price oracle integration
│   │   └── index.ts         # Pyth Network oracle
│   │
│   ├── websocket/           # Real-time WebSocket server
│   │   └── index.ts         # Live data streaming
│   │
│   ├── api/
│   │   ├── server.ts        # Express REST API server
│   │   └── routes/
│   │       ├── admin.ts     # Admin endpoints
│   │       ├── stocks.ts    # Stock data endpoints
│   │       ├── news.ts      # News feed endpoints
│   │       └── auth.ts      # Authentication
│   │
│   ├── alerts/              # Notification system
│   │   └── index.ts         # Telegram, Discord alerts
│   │
│   └── db/                  # SQLite persistence
│       └── index.ts         # Historical data storage
│
├── dashboard/               # React + Vite Frontend
│   ├── src/
│   │   ├── App.tsx          # Main dashboard component
│   │   ├── LandingPage.tsx  # Landing page
│   │   ├── NewsPage.tsx     # News feed page
│   │   ├── PrismBot.tsx     # AI chatbot component
│   │   ├── AuthModal.tsx    # Authentication modal
│   │   └── IntroAnimation.tsx
│   │
│   └── index.html
│
├── sdk/                     # @prism-ai/sdk npm package
├── docs/                    # API documentation
├── Dockerfile               # API container
└── docker-compose.yml       # Full stack deployment
```

---

## AI Prediction Algorithm

### How It Works

1. **Data Collection**: Fetches real-time data from 13 exchanges every 30 seconds
2. **Risk Scoring**: Calculates weighted risk score (0-100) based on 5 factors
3. **Prediction Generation**: When risk >= 40, generates squeeze prediction:
   - **Direction**: Long squeeze (price drop) or Short squeeze (price pump)
   - **Probability**: Confidence level (10%-85%)
   - **Trigger Price**: Price level that could trigger cascade
   - **Time Window**: Expected timeframe (1-24 hours)
   - **Estimated Impact**: USD value of positions at risk

### Risk Levels

| Score | Level | Meaning |
|-------|-------|---------|
| 80-100 | Critical | High chance of liquidation cascade |
| 60-79 | High | Elevated market stress |
| 40-59 | Elevated | Above normal risk |
| 20-39 | Moderate | Normal conditions |
| 0-19 | Low | Calm market |

---

## Quick Start

### Prerequisites

- Node.js >= 18.0.0
- npm or yarn

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/prism-ai.git
cd prism-ai

# Install all dependencies
npm run install:all

# Start the API server (port 3000)
npm run api

# In another terminal, start the dashboard (port 5173)
npm run dashboard
```

### Environment Variables (Optional)

```bash
# Alerts
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
DISCORD_WEBHOOK_URL=your_webhook

# News API
CRYPTOPANIC_API_KEY=your_api_key

# Security
ADMIN_SECRET=your_secret_key
```

---

## API Endpoints

### Public Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/v1/health` | Health check |
| `GET /api/v1/data` | All exchange data |
| `GET /api/v1/risk` | Risk analysis for all symbols |
| `GET /api/v1/symbols` | List supported symbols |
| `GET /api/v1/stocks` | Stock quotes |
| `GET /api/v1/stocks/risk` | Stock risk analysis |
| `GET /api/v1/news` | Latest news articles |

### WebSocket

Connect to `ws://localhost:3000/ws` for real-time updates.

Events: `connected`, `data`, `risk`, `alert`, `ping/pong`

---

## Dashboard Features

- **Real-Time Charts**: TradingView-powered price charts
- **Risk Visualization**: Color-coded risk cards by severity
- **AI Predictions**: Clear squeeze warnings with trading suggestions
- **Multi-Asset Support**: Crypto and stock tracking
- **News Feed**: Latest crypto and tech headlines
- **Responsive Design**: Works on desktop and mobile

---

## Tech Stack

### Backend
- **Runtime**: Node.js with TypeScript
- **API**: Express.js REST API
- **WebSocket**: Native ws library
- **Database**: SQLite for persistence
- **HTTP Client**: Axios

### Frontend
- **Framework**: React 18 with TypeScript
- **Build Tool**: Vite
- **Styling**: Tailwind CSS
- **Charts**: TradingView Lightweight Charts
- **Icons**: Lucide React

---

## Deployment

### Vercel (Frontend)

```bash
cd dashboard
npm run build
vercel deploy
```

### Docker (Full Stack)

```bash
docker-compose up -d
```

---

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## License

MIT License - see [LICENSE](LICENSE) file for details.

---

## Disclaimer

This software is for educational and informational purposes only. It is NOT financial advice. Trading cryptocurrencies involves substantial risk of loss. Always do your own research and consult with a qualified financial advisor before making any investment decisions.

---

Built with AI by Prism Team
