import axios from 'axios';
import type { CascadeRisk } from '../predictor/index.js';

export interface AlertConfig {
  telegram?: {
    botToken: string;
    chatId: string;
  };
  discord?: {
    webhookUrl: string;
  };
  webhook?: {
    url: string;
    headers?: Record<string, string>;
  };
}

export interface AlertPayload {
  symbol: string;
  riskScore: number;
  riskLevel: string;
  prediction: CascadeRisk['prediction'];
  timestamp: number;
}

export class AlertManager {
  private config: AlertConfig;
  private lastAlerts: Map<string, number> = new Map();
  private cooldownMs = 5 * 60 * 1000; // 5 minute cooldown per symbol

  constructor(config: AlertConfig) {
    this.config = config;
  }

  private shouldAlert(symbol: string): boolean {
    const lastAlert = this.lastAlerts.get(symbol);
    if (!lastAlert) return true;
    return Date.now() - lastAlert > this.cooldownMs;
  }

  private markAlerted(symbol: string): void {
    this.lastAlerts.set(symbol, Date.now());
  }

  async sendAlert(risk: CascadeRisk): Promise<void> {
    if (!this.shouldAlert(risk.symbol)) {
      return;
    }

    const payload: AlertPayload = {
      symbol: risk.symbol,
      riskScore: risk.riskScore,
      riskLevel: risk.riskLevel,
      prediction: risk.prediction,
      timestamp: risk.timestamp,
    };

    const promises: Promise<void>[] = [];

    if (this.config.telegram) {
      promises.push(this.sendTelegram(payload));
    }

    if (this.config.discord) {
      promises.push(this.sendDiscord(payload));
    }

    if (this.config.webhook) {
      promises.push(this.sendWebhook(payload));
    }

    await Promise.allSettled(promises);
    this.markAlerted(risk.symbol);
  }

  async checkAndAlert(risks: CascadeRisk[]): Promise<void> {
    const highRisks = risks.filter(r =>
      r.riskLevel === 'critical' || r.riskLevel === 'high'
    );

    for (const risk of highRisks) {
      await this.sendAlert(risk);
    }
  }

  private formatMessage(payload: AlertPayload): string {
    const icon = payload.riskLevel === 'critical' ? '🔴' : '🟠';
    const direction = payload.prediction?.direction === 'long_squeeze'
      ? '📉 LONG SQUEEZE'
      : '📈 SHORT SQUEEZE';

    let message = `${icon} PRISM ALERT: ${payload.symbol}\n\n`;
    message += `Risk Score: ${payload.riskScore}/100 (${payload.riskLevel.toUpperCase()})\n`;

    if (payload.prediction) {
      message += `\nPrediction:\n`;
      message += `• Direction: ${direction}\n`;
      message += `• Probability: ${(payload.prediction.probability * 100).toFixed(0)}%\n`;
      message += `• Est. Impact: $${(payload.prediction.estimatedImpact / 1_000_000).toFixed(1)}M\n`;
      message += `• Trigger: $${payload.prediction.triggerPrice.toLocaleString()} (${payload.prediction.triggerDistance.toFixed(1)}% away)\n`;
      message += `• Time Window: ${payload.prediction.timeWindow}\n`;
    }

    message += `\nTimestamp: ${new Date(payload.timestamp).toISOString()}`;

    return message;
  }

  private async sendTelegram(payload: AlertPayload): Promise<void> {
    if (!this.config.telegram) return;

    const { botToken, chatId } = this.config.telegram;
    const message = this.formatMessage(payload);

    try {
      await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
      });
      console.log(`[Alert] Telegram sent for ${payload.symbol}`);
    } catch (error) {
      console.error('[Alert] Telegram error:', error instanceof Error ? error.message : error);
    }
  }

  private async sendDiscord(payload: AlertPayload): Promise<void> {
    if (!this.config.discord) return;

    const icon = payload.riskLevel === 'critical' ? '🔴' : '🟠';
    const color = payload.riskLevel === 'critical' ? 0xff0000 : 0xff8c00;

    const embed = {
      title: `${icon} ${payload.symbol} Risk Alert`,
      color,
      fields: [
        {
          name: 'Risk Score',
          value: `${payload.riskScore}/100`,
          inline: true,
        },
        {
          name: 'Risk Level',
          value: payload.riskLevel.toUpperCase(),
          inline: true,
        },
      ],
      timestamp: new Date(payload.timestamp).toISOString(),
      footer: {
        text: 'Prism Risk Intelligence',
      },
    };

    if (payload.prediction) {
      embed.fields.push(
        {
          name: 'Direction',
          value: payload.prediction.direction === 'long_squeeze' ? '📉 Long Squeeze' : '📈 Short Squeeze',
          inline: true,
        },
        {
          name: 'Probability',
          value: `${(payload.prediction.probability * 100).toFixed(0)}%`,
          inline: true,
        },
        {
          name: 'Est. Impact',
          value: `$${(payload.prediction.estimatedImpact / 1_000_000).toFixed(1)}M`,
          inline: true,
        },
        {
          name: 'Trigger Price',
          value: `$${payload.prediction.triggerPrice.toLocaleString()} (${payload.prediction.triggerDistance.toFixed(1)}% away)`,
          inline: false,
        }
      );
    }

    try {
      await axios.post(this.config.discord.webhookUrl, {
        embeds: [embed],
      });
      console.log(`[Alert] Discord sent for ${payload.symbol}`);
    } catch (error) {
      console.error('[Alert] Discord error:', error instanceof Error ? error.message : error);
    }
  }

  private async sendWebhook(payload: AlertPayload): Promise<void> {
    if (!this.config.webhook) return;

    try {
      await axios.post(this.config.webhook.url, payload, {
        headers: {
          'Content-Type': 'application/json',
          ...this.config.webhook.headers,
        },
      });
      console.log(`[Alert] Webhook sent for ${payload.symbol}`);
    } catch (error) {
      console.error('[Alert] Webhook error:', error instanceof Error ? error.message : error);
    }
  }
}

// Helper to create alert manager from environment variables
export function createAlertManagerFromEnv(): AlertManager | null {
  const config: AlertConfig = {};

  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    config.telegram = {
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      chatId: process.env.TELEGRAM_CHAT_ID,
    };
  }

  if (process.env.DISCORD_WEBHOOK_URL) {
    config.discord = {
      webhookUrl: process.env.DISCORD_WEBHOOK_URL,
    };
  }

  if (process.env.ALERT_WEBHOOK_URL) {
    config.webhook = {
      url: process.env.ALERT_WEBHOOK_URL,
    };
  }

  if (Object.keys(config).length === 0) {
    return null;
  }

  return new AlertManager(config);
}
