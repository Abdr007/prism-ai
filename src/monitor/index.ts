import { EventEmitter } from 'events';
import type { ExchangeClient } from '../exchanges/types.js';
import { DataAggregator, type AggregatedData, type RiskSignal } from '../aggregator/index.js';
import { CascadePredictor, type CascadeRisk } from '../predictor/index.js';
import { PrismDB } from '../db/index.js';
import { DataValidator } from '../middleware/validation.js';

export interface MonitorConfig {
  symbols: string[];
  intervalMs: number;  // Polling interval in milliseconds
  persistData?: boolean; // Whether to save to database
  databaseUrl?: string;  // PostgreSQL connection URL
}

export interface MonitorEvents {
  data: (data: AggregatedData) => void;
  risk: (signals: RiskSignal[]) => void;
  cascade: (risks: CascadeRisk[]) => void;
  error: (error: Error) => void;
}

export class PrismMonitor extends EventEmitter {
  private aggregator: DataAggregator;
  private predictor: CascadePredictor;
  private validator: DataValidator;
  private db: PrismDB | null = null;
  private config: MonitorConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private lastData: AggregatedData | null = null;
  private lastRisks: CascadeRisk[] = [];

  constructor(clients: ExchangeClient[], config: MonitorConfig) {
    super();
    this.aggregator = new DataAggregator(clients);
    this.predictor = new CascadePredictor();
    this.validator = new DataValidator();
    this.config = config;

    if (config.persistData) {
      this.db = new PrismDB(config.databaseUrl);
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    // Bootstrap database schema
    if (this.db) {
      await this.db.ensureSchema();
    }

    // Fetch immediately on start
    await this.tick();

    // Then poll on interval
    this.timer = setInterval(() => {
      this.tick().catch(err => {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      });
    }, this.config.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;

    if (this.db) {
      await this.db.close();
    }
  }

  private async tick(): Promise<void> {
    try {
      // Fetch → Validate → Aggregate → Risk (no bypass)
      const rawData = await this.aggregator.fetchAll(this.config.symbols);
      const validatedData = this.validator.validateBatch(rawData);
      const data = await this.aggregator.aggregate(validatedData, this.config.symbols);
      this.lastData = data;

      // Analyze cascade risk (only validated data reaches here)
      const risks = this.predictor.analyze(data);
      this.lastRisks = risks;

      // Persist to database
      if (this.db) {
        await this.db.saveSnapshot(data);
        await this.db.saveRiskScores(risks);

        // Save high-priority alerts
        for (const risk of risks) {
          if (risk.riskLevel === 'critical' || risk.riskLevel === 'high') {
            await this.db.saveAlert(
              risk.timestamp,
              risk.symbol,
              'CASCADE_RISK',
              risk.riskLevel,
              `${risk.symbol} cascade risk: ${risk.riskScore}/100`,
              { riskScore: risk.riskScore, prediction: risk.prediction }
            );
          }
        }
      }

      this.emit('data', data);
      this.emit('cascade', risks);

      // Emit risk signals separately for easy handling
      if (data.riskSignals.length > 0) {
        this.emit('risk', data.riskSignals);
      }
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    }
  }

  getLastData(): AggregatedData | null {
    return this.lastData;
  }

  getLastRisks(): CascadeRisk[] {
    return this.lastRisks;
  }

  getDatabase(): PrismDB | null {
    return this.db;
  }

  isActive(): boolean {
    return this.isRunning;
  }
}
