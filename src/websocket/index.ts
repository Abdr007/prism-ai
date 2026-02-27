import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { AggregatedData } from '../aggregator/index.js';
import type { CascadeRisk } from '../predictor/index.js';
import { logger as rootLogger } from '../lib/logger.js';

const log = rootLogger.child({ component: 'websocket' });

export interface WSMessage {
  type: 'data' | 'risk' | 'alert' | 'connected' | 'error' | 'ping' | 'pong';
  payload?: unknown;
  timestamp: number;
}

export class PrismWebSocket {
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(server: Server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.init();
  }

  private init(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      this.clients.add(ws);
      log.info({ totalClients: this.clients.size }, 'Client connected');

      // Send welcome message
      this.send(ws, {
        type: 'connected',
        payload: {
          message: 'Connected to Prism WebSocket',
          clientId: Math.random().toString(36).substring(7),
        },
        timestamp: Date.now(),
      });

      ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.type === 'ping') {
            this.send(ws, { type: 'pong', timestamp: Date.now() });
          }
        } catch {
          // Ignore invalid messages
        }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        log.info({ totalClients: this.clients.size }, 'Client disconnected');
      });

      ws.on('error', (error) => {
        log.error({ err: error.message }, 'Client error');
        this.clients.delete(ws);
      });
    });

    // Ping clients every 30s to keep connections alive
    this.pingInterval = setInterval(() => {
      this.broadcast({ type: 'ping', timestamp: Date.now() });
    }, 30000);
  }

  private send(ws: WebSocket, message: WSMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  broadcast(message: WSMessage): void {
    const payload = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  broadcastData(data: AggregatedData): void {
    this.broadcast({
      type: 'data',
      payload: data,
      timestamp: Date.now(),
    });
  }

  broadcastRisk(risks: CascadeRisk[]): void {
    this.broadcast({
      type: 'risk',
      payload: risks,
      timestamp: Date.now(),
    });

    // Send separate alerts for high-risk situations
    const criticalRisks = risks.filter(r =>
      r.riskLevel === 'critical' || r.riskLevel === 'high'
    );

    if (criticalRisks.length > 0) {
      this.broadcast({
        type: 'alert',
        payload: {
          level: 'high',
          risks: criticalRisks.map(r => ({
            symbol: r.symbol,
            riskScore: r.riskScore,
            riskLevel: r.riskLevel,
            prediction: r.prediction,
          })),
        },
        timestamp: Date.now(),
      });
    }
  }

  getClientCount(): number {
    return this.clients.size;
  }

  close(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }
    this.wss.close();
  }
}
