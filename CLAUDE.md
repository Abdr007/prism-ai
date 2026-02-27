# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**PRISM AI** — Cross-exchange liquidation cascade detection for perpetual futures markets.

Aggregates real-time data from 11 exchanges (8 CEX + 3 DEX) across 25 symbols. Uses a signal-focused stress engine with percentile-based scoring, volatility regime conditioning, and logistic calibration to predict liquidation cascades. Features REST API, WebSocket streaming, webhook delivery, and a React dashboard.

## Commands

```bash
# Backend
npm run fetch       # One-shot: fetch and display live data
npm run monitor     # Terminal dashboard with cascade prediction
npm run api         # Start API + WebSocket server on :3000

# Dashboard
npm run dashboard   # Start React dashboard on :5173

# Setup
npm run install:all # Install all dependencies (backend + dashboard)

# Docker
docker-compose up -d        # Start PostgreSQL + API + Dashboard
docker-compose logs -f api  # View API logs

# Evaluation
npx tsx scripts/run-evaluation.ts   # Synthetic backtest (no DB needed)
```

## Architecture

```
prism-ai/
├── src/
│   ├── exchanges/         # 11 exchange clients (inherit BaseExchangeClient)
│   │   └── base.ts        # Abstract base: retry, rate-limit, validation
│   ├── aggregator/        # Cross-exchange data merging & z-scores
│   ├── predictor/         # Stress engine
│   │   ├── cascade.ts     # StressEngine: percentile scoring, vol regimes
│   │   ├── cascadeDetector.ts  # Ground-truth cascade detection
│   │   └── calibration.ts # Logistic regression calibration
│   ├── backtest/          # Evaluation framework (P/R/F1, threshold sweep)
│   ├── db/                # PostgreSQL (async pg, connection pooling)
│   │   ├── schema.sql     # DDL for 5 core tables
│   │   └── cascadeRepository.ts
│   ├── api/
│   │   ├── server.ts      # Express REST API
│   │   └── routes/        # Admin, auth, account, webhook, stock, news
│   ├── websocket/         # Real-time WebSocket server
│   ├── oracle/            # Pyth Network price oracle
│   ├── stocks/            # Stock market data
│   ├── middleware/        # Security, auth, rate limiting, data validation
│   ├── observability/     # Exchange metrics, latency, health
│   ├── lib/               # Structured JSON logger
│   ├── webhooks/          # HMAC-signed webhook delivery
│   └── onboarding/        # Multi-tenant exchange account management
├── scripts/
│   ├── migrate-sqlite-to-pg.ts  # SQLite → PostgreSQL migration
│   └── run-evaluation.ts        # Synthetic backtest harness
├── dashboard/             # React + Vite + Tailwind frontend
├── sdk/                   # @prism-ai/sdk npm package
├── docs/                  # API documentation
├── Dockerfile             # API container
└── docker-compose.yml     # PostgreSQL + API + Dashboard
```

## Key Design Decisions

**Database**: PostgreSQL 16 with async `pg` client, connection pooling, and optional TimescaleDB hypertables.

**Stress Engine**: Single-signal architecture using price deviation as primary stress indicator. Percentile-rank → dynamic thresholds → vol regime scaling → logistic calibration → risk score 0-100 with P(cascade).

**Exchange Clients**: All 11 inherit `BaseExchangeClient` for retry (3x exponential backoff), rate-limit handling (HTTP 429), strict numeric validation, and structured logging.

**Logging**: All output through structured JSON logger (`src/lib/logger.ts`). No `console.log`.

**Data Validation**: Pre-aggregation quality gate (`DataValidator`) rejects stale data, NaN/Infinity, and excessive price deviations.

## API Endpoints

**Public:** `/api/v1/health`, `/api/v1/data`, `/api/v1/risk`, `/api/v1/symbols`, `/api/v1/alerts`, `/api/v1/stocks`, `/api/v1/news`

**Client (X-API-Key):** `/api/v1/client/data`, `/api/v1/client/risk`, `/api/v1/account`, `/api/v1/webhooks`

**Admin (X-Admin-Secret):** `/api/v1/admin/exchanges` (CRUD + suspend)

**WebSocket:** `ws://localhost:3000/ws` — events: `connected`, `data`, `risk`, `alert`

## B2B Plans

- **Starter**: 60 req/min, 2 symbols
- **Growth**: 300 req/min, 5 symbols, WebSocket
- **Enterprise**: 1000 req/min, 10 symbols, WebSocket, priority support
