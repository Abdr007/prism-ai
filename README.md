<p align="center">
  <img src="https://img.shields.io/badge/PRISM-AI-blueviolet?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJ3aGl0ZSI+PHBhdGggZD0iTTEyIDJMMiA3bDEwIDUgMTAtNS0xMC01ek0yIDE3bDEwIDUgMTAtNS0xMC01LTEwIDV6TTIgMTJsMTAgNSAxMC01LTEwLTUtMTAgNXoiLz48L3N2Zz4=" alt="PRISM AI" />
</p>

<h1 align="center">PRISM AI</h1>

<p align="center">
  <strong>Predictive Risk Intelligence System for Markets</strong><br/>
  Cross-exchange liquidation cascade detection for perpetual futures
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white" />
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A518-339933?style=flat-square&logo=node.js&logoColor=white" />
  <img src="https://img.shields.io/badge/PostgreSQL-16-4169E1?style=flat-square&logo=postgresql&logoColor=white" />
  <img src="https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black" />
  <img src="https://img.shields.io/badge/Docker-Ready-2496ED?style=flat-square&logo=docker&logoColor=white" />
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" />
</p>

---

## Overview

PRISM aggregates real-time perpetual futures data from **11 exchanges** across **25 symbols**, detects market stress through a signal-focused stress engine, and delivers calibrated cascade probability estimates via REST API, WebSocket, and webhook push.

**Key capabilities:**

- Percentile-based risk scoring with volatility regime conditioning
- Logistic regression calibration mapping raw scores to cascade probabilities
- Sub-second WebSocket streaming to connected dashboards
- Ground-truth backtest engine for continuous model evaluation
- Multi-tenant B2B API with tiered plans and HMAC-signed webhooks

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            PRISM AI — System Architecture                   │
└─────────────────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────────┐
  │                       DATA INGESTION LAYER                          │
  │                                                                     │
  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ │
  │  │ Binance  │ │  Bybit   │ │   OKX    │ │  Bitget  │ │ Gate.io  │ │
  │  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ │
  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ │
  │  │   MEXC   │ │  KuCoin  │ │  Kraken  │ │   dYdX   │ │Hyperliqd│ │
  │  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ │
  │  ┌──────────┐                                                       │
  │  │   GMX    │  BaseExchangeClient: retry, rate-limit, validation   │
  │  └────┬─────┘                                                       │
  └───────┼─────────────┼─────────────┼─────────────┼─────────────┼─────┘
          │             │             │             │             │
          ▼             ▼             ▼             ▼             ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │                      DATA VALIDATION LAYER                          │
  │                                                                     │
  │  DataValidator: price deviation checks, stale-data rejection,       │
  │  numeric sanity (no NaN/Infinity), anomaly logging                  │
  └─────────────────────────────┬───────────────────────────────────────┘
                                │
                                ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │                       AGGREGATION ENGINE                            │
  │                                                                     │
  │  Cross-exchange merge: avg mark price, total OI, funding spread,   │
  │  z-scores (funding, OI), price deviation %, exchange count          │
  └─────────────────────────────┬───────────────────────────────────────┘
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
  ┌──────────────────────────┐  ┌──────────────────────────────────────┐
  │     STRESS ENGINE        │  │          PERSISTENCE (PostgreSQL)    │
  │                          │  │                                      │
  │  Percentile-rank scoring │  │  perp_market_data     (per-exchange) │
  │  Dynamic thresholds      │  │  aggregated_snapshots (cross-exch)   │
  │  Vol regime conditioning │  │  risk_scores          (predictions)  │
  │  Logistic calibration    │  │  alerts               (anomalies)   │
  │  Feature plugin system   │  │  cascade_events       (ground truth) │
  │                          │  │                                      │
  │  Output: risk 0–100,     │  │  TimescaleDB-ready hypertables      │
  │  confidence, prediction  │  │                                      │
  └────────────┬─────────────┘  └──────────────────────────────────────┘
               │
               ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │                        DELIVERY LAYER                               │
  │                                                                     │
  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
  │  │  REST API    │  │  WebSocket   │  │  Webhooks (HMAC-signed)  │  │
  │  │  Express 5   │  │  ws://       │  │  Retry + exp. backoff    │  │
  │  │  /api/v1/*   │  │  /ws         │  │  data, risk, alert       │  │
  │  └──────────────┘  └──────────────┘  └──────────────────────────┘  │
  └─────────────────────────────────────────────────────────────────────┘
               │
               ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │                        CONSUMERS                                    │
  │                                                                     │
  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
  │  │  React       │  │  @prism-ai/  │  │  B2B Exchange Clients    │  │
  │  │  Dashboard   │  │  sdk         │  │  (starter/growth/ent.)   │  │
  │  └──────────────┘  └──────────────┘  └──────────────────────────┘  │
  └─────────────────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
prism-ai/
├── src/
│   ├── exchanges/              # 11 exchange clients (8 CEX + 3 DEX)
│   │   ├── base.ts             # Abstract base: retry, rate-limit, validation
│   │   ├── binance.ts          # Binance Futures
│   │   ├── bybit.ts            # Bybit Derivatives
│   │   ├── okx.ts              # OKX Perpetuals
│   │   ├── bitget.ts           # Bitget Futures
│   │   ├── gateio.ts           # Gate.io Futures
│   │   ├── mexc.ts             # MEXC Futures
│   │   ├── kucoin.ts           # KuCoin Futures
│   │   ├── kraken.ts           # Kraken Futures
│   │   ├── dydx.ts             # dYdX v4 (decentralized)
│   │   ├── hyperliquid.ts      # Hyperliquid (decentralized)
│   │   ├── gmx.ts              # GMX v2 (decentralized)
│   │   └── types.ts            # Shared interfaces
│   │
│   ├── aggregator/             # Cross-exchange data merging & z-scores
│   ├── predictor/              # Stress engine & cascade detection
│   │   ├── cascade.ts          # StressEngine: percentile scoring, vol regimes
│   │   ├── cascadeDetector.ts  # Ground-truth cascade event detection
│   │   └── calibration.ts      # Logistic regression probability calibration
│   │
│   ├── backtest/               # Evaluation framework (precision, recall, F1)
│   ├── db/                     # PostgreSQL persistence layer
│   │   ├── index.ts            # Async pg client with connection pooling
│   │   ├── schema.sql          # DDL for 5 core tables
│   │   └── cascadeRepository.ts # Cascade event CRUD
│   │
│   ├── api/
│   │   ├── server.ts           # Express REST API + middleware
│   │   └── routes/             # Admin, auth, account, webhook, stock, news
│   │
│   ├── websocket/              # Real-time WebSocket server
│   ├── oracle/                 # Pyth Network price oracle
│   ├── stocks/                 # Stock market data integration
│   ├── middleware/             # Security, auth, rate limiting, validation
│   ├── observability/          # Exchange metrics, latency tracking, health
│   ├── lib/                    # Structured JSON logger
│   ├── webhooks/               # HMAC-signed webhook delivery
│   └── onboarding/             # Multi-tenant exchange account management
│
├── scripts/
│   ├── migrate-sqlite-to-pg.ts # One-shot SQLite → PostgreSQL migration
│   └── run-evaluation.ts       # Synthetic backtest & calibration harness
│
├── dashboard/                  # React + Vite + Tailwind frontend
├── sdk/                        # @prism-ai/sdk npm package
├── docs/                       # API documentation
├── Dockerfile                  # API container
└── docker-compose.yml          # Full stack: PostgreSQL + API + Dashboard
```

---

## Stress Engine

The prediction engine uses a **signal-focused architecture** built around validated price deviation as the primary stress indicator.

### Pipeline

```
Raw Exchange Data
    │
    ▼
Aggregation (cross-exchange spread, z-scores)
    │
    ▼
Percentile Rank (empirical CDF of price deviation → 0–100)
    │
    ▼
Dynamic Thresholds (rolling p90/p95/p99 × vol multiplier)
    │
    ▼
Volatility Regime (low / medium / high tercile → threshold scaling)
    │
    ▼
Risk Score (0–100) + Risk Level (low → critical)
    │
    ▼
Logistic Calibration (sigmoid → P(cascade | score) with 95% CI)
    │
    ▼
Prediction (direction, trigger price, estimated impact, time window)
```

### Risk Levels

| Score   | Level      | Action                        |
|---------|------------|-------------------------------|
| 80–100  | Critical   | Cascade likely imminent        |
| 60–79   | High       | Significant market stress      |
| 40–59   | Elevated   | Above-normal conditions        |
| 20–39   | Moderate   | Normal market activity         |
| 0–19    | Low        | Calm markets                   |

### Calibration

Raw risk scores are mapped to cascade probabilities via fitted logistic regression:

```
P(cascade | score) = σ(a + b × score)
```

- Fit via IRLS on historical binned data
- Wald confidence intervals from Fisher information matrix
- Defaults provide backward-compatible cold-start behavior

---

## Exchanges

| Exchange     | Type | Symbols | Features                          |
|-------------|------|---------|-----------------------------------|
| Binance      | CEX  | 25      | Funding, OI, mark/index price     |
| Bybit        | CEX  | 25      | Funding, OI, mark/index price     |
| OKX          | CEX  | 25      | Funding, OI, mark/index price     |
| Bitget       | CEX  | 25      | Funding, OI, mark/index price     |
| Gate.io      | CEX  | 25      | Funding, OI, mark/index price     |
| MEXC         | CEX  | 25      | Funding, OI, mark/index price     |
| KuCoin       | CEX  | 25      | Funding, OI, mark/index price     |
| Kraken       | CEX  | 25      | Funding, OI, mark/index price     |
| dYdX         | DEX  | 25      | Decentralized orderbook           |
| Hyperliquid  | DEX  | 25      | On-chain perpetuals               |
| GMX          | DEX  | 25      | Arbitrum-based perps              |

All clients inherit from `BaseExchangeClient` providing:
- 5s request timeout with 3-attempt exponential backoff
- HTTP 429 rate-limit detection with `Retry-After` compliance
- Strict numeric validation (no `null`, `NaN`, `Infinity`)
- Mark vs index price deviation rejection (> 10% spread)
- Per-exchange health tracking and structured logging

---

## Quick Start

### Prerequisites

- **Node.js** >= 18
- **PostgreSQL** 16 (or use Docker)

### Installation

```bash
git clone https://github.com/Abdr007/prism-ai.git
cd prism-ai

# Install all dependencies (backend + dashboard)
npm run install:all

# Copy and configure environment
cp .env.example .env
```

### Run with Docker (recommended)

```bash
# Starts PostgreSQL, API server, and dashboard
docker-compose up -d

# View logs
docker-compose logs -f api
```

### Run Locally

```bash
# Terminal 1 — Start API server (port 3000)
npm run api

# Terminal 2 — Start React dashboard (port 5173)
npm run dashboard
```

### Other Commands

```bash
npm run fetch       # One-shot: fetch and display live data
npm run monitor     # Terminal dashboard with cascade prediction
npm run build       # Compile TypeScript
```

---

## API Reference

### Public Endpoints

| Method | Endpoint              | Description                     |
|--------|-----------------------|---------------------------------|
| GET    | `/api/v1/health`      | System health and exchange metrics |
| GET    | `/api/v1/data`        | Aggregated market data (all symbols) |
| GET    | `/api/v1/risk`        | Risk analysis with predictions  |
| GET    | `/api/v1/symbols`     | Supported symbol list           |
| GET    | `/api/v1/alerts`      | Active risk alerts              |
| GET    | `/api/v1/stocks`      | Stock quotes                    |
| GET    | `/api/v1/stocks/risk` | Stock risk analysis             |
| GET    | `/api/v1/news`        | Crypto & tech news feed         |

### Client Endpoints (API Key via `X-API-Key`)

| Method | Endpoint               | Description                    |
|--------|------------------------|--------------------------------|
| GET    | `/api/v1/client/data`  | Data filtered by plan tier     |
| GET    | `/api/v1/client/risk`  | Risk filtered by plan tier     |
| GET    | `/api/v1/account`      | Account info                   |
| POST   | `/api/v1/webhooks`     | Register webhook endpoint      |

### Admin Endpoints (via `X-Admin-Secret`)

| Method | Endpoint                            | Description         |
|--------|-------------------------------------|---------------------|
| POST   | `/api/v1/admin/exchanges`           | Create exchange     |
| GET    | `/api/v1/admin/exchanges`           | List exchanges      |
| POST   | `/api/v1/admin/exchanges/:id/suspend` | Suspend exchange  |

### WebSocket

```
ws://localhost:3000/ws
```

Events: `connected` | `data` | `risk` | `alert` | `ping/pong`

---

## B2B Platform

### Multi-Tenant Plans

| Plan       | Rate Limit  | Symbols | WebSocket | Webhooks |
|------------|-------------|---------|-----------|----------|
| Starter    | 60 req/min  | 2       | --        | 1        |
| Growth     | 300 req/min | 5       | Yes       | 5        |
| Enterprise | 1000 req/min| 10      | Yes       | 25       |

### Webhook System

- Event types: `data`, `risk`, `alert`
- HMAC-SHA256 signature verification
- Automatic retry with exponential backoff
- Delivery status tracking

### SDK

```bash
npm install @prism-ai/sdk
```

```typescript
import { PrismClient } from '@prism-ai/sdk';

const prism = new PrismClient({ apiKey: 'your-key' });

// REST
const risk = await prism.getRisk();

// WebSocket
prism.ws.on('risk', (data) => console.log(data));
prism.ws.connect();
```

---

## Evaluation & Backtesting

PRISM includes a self-contained evaluation framework for validating prediction quality:

```bash
# Run synthetic evaluation (no database required)
npx tsx scripts/run-evaluation.ts
```

**Outputs:**
- Precision, recall, F1 across threshold sweep
- Brier score and Brier skill score
- Calibration curve (predicted vs empirical probability)
- Cold-start vs warm-start performance comparison
- Per-symbol and micro-averaged metrics

---

## Database Schema

PostgreSQL with 5 core tables, composite primary keys, and optional TimescaleDB hypertables:

| Table                   | Granularity | Purpose                              |
|------------------------|-------------|--------------------------------------|
| `perp_market_data`     | 1 min       | Per-exchange snapshots               |
| `aggregated_snapshots` | 1 min       | Cross-exchange aggregated metrics    |
| `risk_scores`          | 1 min       | Prediction outputs with confidence   |
| `alerts`               | Event       | Anomalies and critical events        |
| `cascade_events`       | Event       | Ground-truth for backtest evaluation |

---

## Tech Stack

| Layer         | Technology                                                |
|---------------|-----------------------------------------------------------|
| Runtime       | Node.js + TypeScript 5.9                                  |
| API           | Express 5                                                 |
| Database      | PostgreSQL 16 (TimescaleDB optional)                      |
| WebSocket     | ws                                                        |
| HTTP Client   | Axios with retry middleware                               |
| Frontend      | React 18 + Vite + Tailwind CSS                            |
| Logging       | Structured JSON (pino-compatible)                          |
| Containers    | Docker + Docker Compose                                   |
| Observability | Built-in exchange metrics, latency percentiles, health    |

---

## Environment Variables

```bash
# Server
PORT=3000
NODE_ENV=production

# Database (required)
DATABASE_URL=postgresql://prism:prism@localhost:5432/prism

# Admin Authentication
ADMIN_SECRET=your_secure_admin_secret

# Alerts (optional)
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
ALERT_WEBHOOK_URL=https://your-endpoint.com/alerts
```

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Commit your changes (`git commit -m 'Add your feature'`)
4. Push to the branch (`git push origin feature/your-feature`)
5. Open a Pull Request

---

## License

MIT License — see [LICENSE](LICENSE) for details.

---

## Disclaimer

This software is for **educational and informational purposes only**. It is not financial advice. Trading cryptocurrencies and derivatives involves substantial risk of loss. Always conduct your own research and consult a qualified financial advisor before making investment decisions.

---

<p align="center">Built by <a href="https://github.com/Abdr007">Abdr007</a></p>
