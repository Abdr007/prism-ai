# Prism API Documentation

Cross-exchange liquidation cascade prediction API for perpetual futures.

## Base URL

```
Production: https://api.prism-ai.io
Local:      http://localhost:3000
```

## Authentication

### Public Endpoints
No authentication required for public endpoints (`/api/v1/health`, `/api/v1/data`, etc.)

### Client Endpoints
Requires API key via header:
```
X-API-Key: prism_your_api_key_here
```

### Admin Endpoints
Requires admin secret via header:
```
X-Admin-Secret: your_admin_secret
```

## Rate Limits

Rate limits are per-exchange based on plan:
- **Starter**: 60 requests/minute
- **Growth**: 300 requests/minute
- **Enterprise**: 1000 requests/minute

Rate limit headers included in responses:
```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 59
X-RateLimit-Reset: 58
```

---

## Public Endpoints

### Health Check
```http
GET /api/v1/health
```

**Response:**
```json
{
  "status": "ok",
  "timestamp": 1709136000000,
  "exchanges": ["Binance", "Bybit", "OKX", "dYdX", "Hyperliquid"],
  "symbols": ["BTC", "ETH", "SOL", "DOGE", "XRP"],
  "websocket": { "clients": 5 },
  "database": { "snapshotCount": 1000, "alertCount": 25 }
}
```

### Get Market Data
```http
GET /api/v1/data
```

**Response:**
```json
{
  "success": true,
  "data": {
    "timestamp": 1709136000000,
    "symbols": ["BTC", "ETH", "SOL", "DOGE", "XRP"],
    "metrics": {
      "BTC": {
        "openInterest": { "total": 15000000000, "byExchange": {...} },
        "fundingRate": { "average": 0.0001, "byExchange": {...} },
        "markPrice": { "average": 65000, "byExchange": {...} }
      }
    }
  },
  "cached": false,
  "cacheAge": 1500
}
```

### Get Risk Analysis
```http
GET /api/v1/risk
```

**Response:**
```json
{
  "success": true,
  "risks": [
    {
      "symbol": "BTC",
      "riskScore": 72,
      "riskLevel": "elevated",
      "factors": [
        { "name": "Funding Rate", "score": 85, "weight": 0.30 },
        { "name": "OI Level", "score": 65, "weight": 0.25 }
      ],
      "prediction": {
        "direction": "short_squeeze",
        "probability": 0.68,
        "estimatedImpact": 250000000,
        "triggerPrice": 66500,
        "timeframe": "4-12 hours"
      },
      "timestamp": 1709136000000
    }
  ],
  "summary": {
    "highestRisk": {...},
    "criticalCount": 0,
    "highCount": 1,
    "elevatedCount": 2
  }
}
```

### Get Supported Symbols
```http
GET /api/v1/symbols
```

**Response:**
```json
{
  "success": true,
  "symbols": ["BTC", "ETH", "SOL", "DOGE", "XRP"]
}
```

### Get Symbol Data
```http
GET /api/v1/symbols/:symbol
```

**Parameters:**
| Name | Type | Description |
|------|------|-------------|
| symbol | string | Symbol (BTC, ETH, etc.) |

**Response:**
```json
{
  "success": true,
  "symbol": "BTC",
  "metrics": {
    "openInterest": {...},
    "fundingRate": {...},
    "markPrice": {...}
  },
  "risk": {
    "riskScore": 72,
    "riskLevel": "elevated",
    "prediction": {...}
  }
}
```

### Get Active Alerts
```http
GET /api/v1/alerts
```

**Response:**
```json
{
  "success": true,
  "alertCount": 2,
  "alerts": [
    {
      "symbol": "ETH",
      "riskLevel": "high",
      "riskScore": 78,
      "prediction": {...},
      "factors": [...]
    }
  ]
}
```

### Get Exchange List
```http
GET /api/v1/exchanges
```

**Response:**
```json
{
  "success": true,
  "exchanges": [
    { "name": "Binance", "status": "active" },
    { "name": "Bybit", "status": "active" }
  ]
}
```

---

## Historical Endpoints

### Get Symbol History
```http
GET /api/v1/history/:symbol?hours=24
```

**Parameters:**
| Name | Type | Default | Description |
|------|------|---------|-------------|
| symbol | string | required | Symbol |
| hours | number | 24 | Hours of history |

### Get Risk Score History
```http
GET /api/v1/history/:symbol/risk?hours=24
```

### Get High Risk Periods
```http
GET /api/v1/history/high-risk?minScore=60
```

### Get Historical Alerts
```http
GET /api/v1/history/alerts?hours=24&severity=high
```

### Get Database Stats
```http
GET /api/v1/stats
```

---

## Client Endpoints (API Key Required)

### Get Filtered Data
```http
GET /api/v1/client/data
```
Returns data filtered by your plan's allowed symbols.

### Get Filtered Risk
```http
GET /api/v1/client/risk
```
Returns risk analysis filtered by your plan's allowed symbols.

### Get Symbol (with Plan Check)
```http
GET /api/v1/client/symbols/:symbol
```
Returns 403 if symbol not in your plan.

---

## Account Management

### Get Account Info
```http
GET /api/v1/account
```

**Response:**
```json
{
  "success": true,
  "account": {
    "id": "ex_abc123",
    "name": "My Exchange",
    "email": "api@myexchange.com",
    "plan": "growth",
    "status": "active",
    "apiKey": "prism_abc1...xyz9",
    "rateLimit": 300,
    "symbols": ["BTC", "ETH", "SOL", "DOGE", "XRP"],
    "createdAt": 1709136000000
  }
}
```

### Update Account
```http
PATCH /api/v1/account
```

**Body:**
```json
{
  "name": "Updated Name",
  "email": "new@email.com",
  "website": "https://myexchange.com"
}
```

### Rotate API Key
```http
POST /api/v1/account/rotate-key
```

**Response:**
```json
{
  "success": true,
  "apiKey": "prism_new_key_here",
  "apiSecret": "new_secret_here",
  "message": "Save the new API secret - it will not be shown again!"
}
```

### Get Usage Stats
```http
GET /api/v1/account/usage
```

---

## Webhook Management

### List Webhooks
```http
GET /api/v1/webhooks
```

**Response:**
```json
{
  "success": true,
  "webhooks": [
    {
      "id": "wh_abc123",
      "url": "https://myexchange.com/prism-alerts",
      "events": ["alert", "risk"],
      "symbols": ["BTC", "ETH"],
      "minRiskLevel": "high",
      "enabled": true,
      "lastTriggered": 1709136000000,
      "failCount": 0
    }
  ]
}
```

### Register Webhook
```http
POST /api/v1/webhooks
```

**Body:**
```json
{
  "url": "https://myexchange.com/prism-alerts",
  "events": ["alert", "risk", "data"],
  "symbols": ["BTC", "ETH"],
  "minRiskLevel": "elevated",
  "headers": { "X-Custom-Header": "value" },
  "secret": "optional_custom_secret"
}
```

**Response:**
```json
{
  "success": true,
  "webhook": {
    "id": "wh_abc123",
    "url": "...",
    "secret": "generated_or_provided_secret"
  },
  "message": "Save the webhook secret - it will not be shown again!"
}
```

### Update Webhook
```http
PATCH /api/v1/webhooks/:id
```

**Body:**
```json
{
  "url": "https://new-url.com/webhook",
  "events": ["alert"],
  "enabled": true
}
```

### Delete Webhook
```http
DELETE /api/v1/webhooks/:id
```

### Test Webhook
```http
POST /api/v1/webhooks/:id/test
```

**Response:**
```json
{
  "success": true,
  "statusCode": 200,
  "responseTime": 150
}
```

---

## Webhook Payload Format

All webhooks include these headers:
```
Content-Type: application/json
X-Prism-Timestamp: 1709136000000
X-Prism-Event: alert|risk|data
X-Prism-Signature: hmac_sha256_signature
```

### Signature Verification

```typescript
import crypto from 'crypto';

function verifySignature(timestamp: string, body: string, signature: string, secret: string): boolean {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
```

### Alert Payload
```json
{
  "type": "alert",
  "timestamp": 1709136000000,
  "payload": {
    "level": "high",
    "count": 2,
    "risks": [
      {
        "symbol": "BTC",
        "riskScore": 78,
        "riskLevel": "high",
        "prediction": {
          "direction": "short_squeeze",
          "probability": 0.72
        }
      }
    ]
  }
}
```

### Risk Payload
```json
{
  "type": "risk",
  "timestamp": 1709136000000,
  "payload": [
    {
      "symbol": "BTC",
      "riskScore": 65,
      "riskLevel": "elevated",
      "factors": [...],
      "prediction": {...}
    }
  ]
}
```

### Data Payload
```json
{
  "type": "data",
  "timestamp": 1709136000000,
  "payload": {
    "symbols": ["BTC", "ETH"],
    "metrics": {...}
  }
}
```

---

## Admin Endpoints

### Create Exchange
```http
POST /api/v1/admin/exchanges
```

**Body:**
```json
{
  "name": "New Exchange",
  "email": "api@exchange.com",
  "website": "https://exchange.com",
  "plan": "growth"
}
```

**Response:**
```json
{
  "success": true,
  "exchange": {
    "id": "ex_abc123",
    "apiKey": "prism_...",
    "apiSecret": "..."
  },
  "message": "Save the API secret - it will not be shown again!"
}
```

### List Exchanges
```http
GET /api/v1/admin/exchanges
```

### Get Exchange
```http
GET /api/v1/admin/exchanges/:id
```

### Update Exchange
```http
PATCH /api/v1/admin/exchanges/:id
```

### Rotate Exchange API Key
```http
POST /api/v1/admin/exchanges/:id/rotate-key
```

### Suspend Exchange
```http
POST /api/v1/admin/exchanges/:id/suspend
```

**Body:**
```json
{
  "reason": "Payment overdue"
}
```

### Reactivate Exchange
```http
POST /api/v1/admin/exchanges/:id/reactivate
```

### Delete Exchange
```http
DELETE /api/v1/admin/exchanges/:id
```

### List All Webhooks (Admin)
```http
GET /api/v1/admin/webhooks?exchangeId=ex_abc123
```

---

## WebSocket API

### Connection
```
ws://localhost:3000/ws
```

### Events

**connected** - Sent on connection
```json
{
  "type": "connected",
  "timestamp": 1709136000000,
  "message": "Connected to Prism"
}
```

**data** - Market data updates (every 30s)
```json
{
  "type": "data",
  "timestamp": 1709136000000,
  "payload": {...}
}
```

**risk** - Risk analysis updates (every 30s)
```json
{
  "type": "risk",
  "timestamp": 1709136000000,
  "payload": [...]
}
```

**alert** - High-risk alerts
```json
{
  "type": "alert",
  "timestamp": 1709136000000,
  "payload": {
    "level": "critical",
    "risks": [...]
  }
}
```

**ping/pong** - Keep-alive
```json
{ "type": "ping" }
{ "type": "pong" }
```

---

## Error Responses

All errors follow this format:
```json
{
  "success": false,
  "error": "Error message here"
}
```

### Common Status Codes

| Code | Description |
|------|-------------|
| 400 | Bad Request - Invalid parameters |
| 401 | Unauthorized - Missing or invalid API key |
| 403 | Forbidden - Symbol not in plan |
| 404 | Not Found - Resource doesn't exist |
| 429 | Too Many Requests - Rate limit exceeded |
| 500 | Internal Server Error |

---

## SDK

Install the official SDK:
```bash
npm install @prism-ai/sdk
```

```typescript
import { PrismClient } from '@prism-ai/sdk';

const prism = new PrismClient({
  apiKey: 'your_api_key',
  baseUrl: 'https://api.prism-ai.io',
  onRisk: (risks) => {
    console.log('Risk update:', risks);
  },
  onAlert: (alert) => {
    console.log('Alert!', alert);
  },
});

// REST API
const { risks } = await prism.getRisk();

// WebSocket
prism.connect();
```

See [SDK README](../sdk/README.md) for full documentation.
