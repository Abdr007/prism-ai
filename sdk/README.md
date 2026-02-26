# @prism-ai/sdk

Official SDK for Prism Risk Intelligence API - Cross-exchange liquidation cascade prediction for perpetual futures.

## Installation

```bash
npm install @prism-ai/sdk
```

## Quick Start

```typescript
import { PrismClient } from '@prism-ai/sdk';

const prism = new PrismClient({
  apiKey: 'your_api_key',
  baseUrl: 'https://api.prism-ai.io', // or your self-hosted URL
});

// Get current risk analysis
const { risks } = await prism.getRisk();

for (const risk of risks) {
  console.log(`${risk.symbol}: ${risk.riskScore}/100 (${risk.riskLevel})`);

  if (risk.prediction) {
    console.log(`  Prediction: ${risk.prediction.direction}`);
    console.log(`  Probability: ${risk.prediction.probability * 100}%`);
    console.log(`  Est. Impact: $${risk.prediction.estimatedImpact.toLocaleString()}`);
  }
}
```

## Real-Time Updates via WebSocket

```typescript
const prism = new PrismClient({
  apiKey: 'your_api_key',

  onData: (data) => {
    console.log('Market data update:', data.timestamp);
  },

  onRisk: (risks) => {
    for (const risk of risks) {
      if (risk.riskLevel === 'critical' || risk.riskLevel === 'high') {
        console.log(`⚠️ HIGH RISK: ${risk.symbol} - ${risk.riskScore}/100`);
      }
    }
  },

  onAlert: (alert) => {
    console.log(`🚨 ALERT: ${alert.risks.length} assets at risk`);
    // Trigger your exchange's alert system
  },

  onConnect: () => console.log('Connected to Prism'),
  onDisconnect: () => console.log('Disconnected'),
});

// Start receiving real-time updates
prism.connect();
```

## Webhook Integration

Register your endpoint to receive alerts server-side:

```typescript
// Register a webhook
const { webhookId } = await prism.registerWebhook({
  url: 'https://your-exchange.com/api/prism-alerts',
  events: ['alert', 'risk'],
  minRiskLevel: 'high',
  secret: 'your_webhook_secret', // For signature verification
});

// Test the webhook
const result = await prism.testWebhook(webhookId);
console.log(`Webhook responded in ${result.responseTime}ms`);
```

### Verifying Webhook Signatures (Express)

```typescript
import express from 'express';
import { verifyWebhookSignature } from '@prism-ai/sdk';

const app = express();

app.post(
  '/api/prism-alerts',
  express.json(),
  verifyWebhookSignature('your_webhook_secret'),
  (req, res) => {
    const { type, payload } = req.body;

    if (type === 'alert') {
      // Handle high-risk alert
      notifyTraders(payload.risks);
    }

    res.json({ received: true });
  }
);
```

## API Reference

### REST Endpoints

```typescript
// Get all market data
const { data } = await prism.getData();

// Get risk analysis
const { risks } = await prism.getRisk();

// Get single symbol
const { metrics, risk } = await prism.getSymbol('BTC');

// Get supported symbols
const { symbols } = await prism.getSymbols();

// Get active alerts
const { alerts } = await prism.getAlerts();

// Get historical data
const { history } = await prism.getHistory('BTC', 24); // last 24 hours

// Get risk score history
const { history } = await prism.getRiskHistory('BTC', 24);
```

### Helper Functions

```typescript
import { formatUSD, formatFundingRate, getRiskColor } from '@prism-ai/sdk';

formatUSD(1234567890);      // "$1.23B"
formatFundingRate(0.0001);  // "+0.0100%"
getRiskColor('critical');   // "#ef4444"
```

## Types

Full TypeScript support included. Key types:

- `PrismConfig` - Client configuration
- `MarketData` - Aggregated market data
- `CascadeRisk` - Risk analysis result
- `CascadePrediction` - Squeeze prediction
- `WebhookConfig` - Webhook registration options

## Support

- Documentation: https://docs.prism-ai.io
- Email: support@prism-ai.io
- Discord: https://discord.gg/prism-ai
