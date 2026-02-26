# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Prism** — Cross-exchange AI risk intelligence API for perpetual futures markets.

Aggregates data from 5 exchanges (Binance, Bybit, OKX, dYdX, Hyperliquid) to detect liquidation cascade patterns, funding rate risks, and market stress signals. Features real-time WebSocket streaming, cascade prediction engine, and a modern React dashboard.

## Commands

```bash
# Backend
npm run fetch     # One-shot: fetch and display live data
npm run monitor   # Terminal dashboard with cascade prediction
npm run api       # Start API + WebSocket server on :3000

# Dashboard
npm run dashboard # Start React dashboard on :5173

# Setup
npm run install:all  # Install all dependencies (backend + dashboard)

# Docker
docker-compose up -d        # Start API + Dashboard in production
docker-compose logs -f api  # View API logs
```

## Architecture

```
prism-ai/
├── src/
│   ├── exchanges/       # Exchange API clients (5 exchanges)
│   ├── aggregator/      # Cross-exchange data merging
│   ├── predictor/       # Cascade prediction engine (risk 0-100)
│   ├── monitor/         # Continuous polling service
│   ├── websocket/       # Real-time WebSocket server
│   ├── webhooks/        # Webhook delivery system
│   ├── onboarding/      # Exchange account management
│   ├── alerts/          # Telegram, Discord notifications
│   ├── middleware/      # Auth, rate limiting
│   ├── db/              # SQLite persistence
│   └── api/
│       ├── server.ts    # Express REST API
│       └── routes/      # Admin, account, webhook routes
├── sdk/                 # @prism-ai/sdk npm package
├── dashboard/           # React + Vite + Tailwind frontend
├── docs/                # API documentation
├── Dockerfile           # API container
└── docker-compose.yml   # Full stack deployment
```

## Key Features

**Data Layer**: 5 exchanges, 5 symbols (BTC, ETH, SOL, DOGE, XRP)

**Cascade Prediction**: Risk score 0-100 based on:
- Funding Rate (30%) — elevated rates signal overcrowded positions
- Open Interest Level (25%) — vs rolling average
- Funding Divergence (20%) — spread between exchanges
- Price Deviation (15%) — oracle discrepancies
- OI Concentration (10%) — single-exchange dominance

**WebSocket**: Real-time streaming at `ws://localhost:3000/ws`
- Events: `connected`, `data`, `risk`, `alert`, `ping/pong`

**Alerts**: Configure via environment variables:
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
- `DISCORD_WEBHOOK_URL`
- `ALERT_WEBHOOK_URL`

**Auth**: API key authentication via `X-API-Key` header, admin via `X-Admin-Secret`

## B2B Features

**Exchange Onboarding**: Multi-tenant system for exchange clients
- Plans: starter (60 req/min, 2 symbols), growth (300/min, 5 symbols), enterprise (1000/min, 10 symbols)
- API key generation, rotation, suspension

**Webhook System**: Push alerts to exchange endpoints
- Events: `data`, `risk`, `alert`
- HMAC-SHA256 signature verification
- Retry with exponential backoff

**SDK**: Official npm package `@prism-ai/sdk`
- REST and WebSocket client
- Webhook signature verification middleware

## API Endpoints

**Public:**
- `GET /api/v1/data` — aggregated metrics
- `GET /api/v1/risk` — cascade risk analysis
- `GET /api/v1/symbols` — list symbols
- `GET /api/v1/alerts` — active risk alerts

**Client (API Key):**
- `GET /api/v1/client/data` — data filtered by plan
- `GET /api/v1/client/risk` — risk filtered by plan
- `GET /api/v1/account` — account info
- `POST /api/v1/webhooks` — register webhook

**Admin (Admin Secret):**
- `POST /api/v1/admin/exchanges` — create exchange
- `GET /api/v1/admin/exchanges` — list exchanges
- `POST /api/v1/admin/exchanges/:id/suspend` — suspend

See [docs/API.md](docs/API.md) for full documentation.

## Dashboard

Modern React dashboard with:
- Real-time WebSocket updates
- Risk gauge visualization
- Exchange distribution chart
- Alert panel
- Asset selector

Run with: `npm run api` (backend) + `npm run dashboard` (frontend)
