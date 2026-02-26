import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import type { AggregatedData } from '../aggregator/index.js';
import type { CascadeRisk } from '../predictor/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/prism.db');

export class PrismDB {
  private db: Database.Database;

  constructor(dbPath: string = DB_PATH) {
    // Ensure data directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.init();
  }

  private init(): void {
    // Market data snapshots
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS market_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        symbol TEXT NOT NULL,
        exchange TEXT NOT NULL,
        open_interest REAL,
        open_interest_value REAL,
        funding_rate REAL,
        mark_price REAL,
        index_price REAL,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      );

      CREATE INDEX IF NOT EXISTS idx_snapshots_timestamp ON market_snapshots(timestamp);
      CREATE INDEX IF NOT EXISTS idx_snapshots_symbol ON market_snapshots(symbol);
      CREATE INDEX IF NOT EXISTS idx_snapshots_exchange ON market_snapshots(exchange);
    `);

    // Aggregated metrics
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS aggregated_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        symbol TEXT NOT NULL,
        total_oi_value REAL,
        avg_funding_rate REAL,
        avg_mark_price REAL,
        price_deviation REAL,
        exchanges_count INTEGER,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      );

      CREATE INDEX IF NOT EXISTS idx_agg_timestamp ON aggregated_metrics(timestamp);
      CREATE INDEX IF NOT EXISTS idx_agg_symbol ON aggregated_metrics(symbol);
    `);

    // Risk scores
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS risk_scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        symbol TEXT NOT NULL,
        risk_score INTEGER,
        risk_level TEXT,
        prediction_direction TEXT,
        prediction_probability REAL,
        prediction_impact REAL,
        prediction_trigger_price REAL,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      );

      CREATE INDEX IF NOT EXISTS idx_risk_timestamp ON risk_scores(timestamp);
      CREATE INDEX IF NOT EXISTS idx_risk_symbol ON risk_scores(symbol);
      CREATE INDEX IF NOT EXISTS idx_risk_level ON risk_scores(risk_level);
    `);

    // Alerts history
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        symbol TEXT NOT NULL,
        alert_type TEXT NOT NULL,
        severity TEXT NOT NULL,
        message TEXT,
        data TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      );

      CREATE INDEX IF NOT EXISTS idx_alerts_timestamp ON alerts(timestamp);
      CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts(severity);
    `);
  }

  // Save market snapshot from aggregated data
  saveSnapshot(data: AggregatedData): void {
    const insertSnapshot = this.db.prepare(`
      INSERT INTO market_snapshots
      (timestamp, symbol, exchange, open_interest, open_interest_value, funding_rate, mark_price, index_price)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertAggregated = this.db.prepare(`
      INSERT INTO aggregated_metrics
      (timestamp, symbol, total_oi_value, avg_funding_rate, avg_mark_price, price_deviation, exchanges_count)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction(() => {
      // Save per-exchange data
      for (const symbol of data.symbols) {
        const metrics = data.metrics[symbol];
        if (!metrics) continue;

        // Save exchange-level data
        for (const exchange of data.exchanges) {
          const oi = metrics.openInterestByExchange[exchange] || 0;
          const funding = metrics.fundingRateByExchange[exchange] || 0;
          const price = metrics.markPriceByExchange[exchange] || 0;

          insertSnapshot.run(
            data.timestamp,
            symbol,
            exchange,
            oi / (price || 1), // Convert back to contracts
            oi,
            funding,
            price,
            price // Using mark as index for simplicity
          );
        }

        // Save aggregated metrics
        insertAggregated.run(
          data.timestamp,
          symbol,
          metrics.totalOpenInterestValue,
          metrics.avgFundingRate,
          metrics.avgMarkPrice,
          metrics.priceDeviation,
          data.exchanges.length
        );
      }
    });

    transaction();
  }

  // Save risk scores
  saveRiskScores(risks: CascadeRisk[]): void {
    const insert = this.db.prepare(`
      INSERT INTO risk_scores
      (timestamp, symbol, risk_score, risk_level, prediction_direction, prediction_probability, prediction_impact, prediction_trigger_price)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction(() => {
      for (const risk of risks) {
        insert.run(
          risk.timestamp,
          risk.symbol,
          risk.riskScore,
          risk.riskLevel,
          risk.prediction?.direction || null,
          risk.prediction?.probability || null,
          risk.prediction?.estimatedImpact || null,
          risk.prediction?.triggerPrice || null
        );
      }
    });

    transaction();
  }

  // Save alert
  saveAlert(
    timestamp: number,
    symbol: string,
    alertType: string,
    severity: string,
    message: string,
    data?: Record<string, unknown>
  ): void {
    this.db.prepare(`
      INSERT INTO alerts (timestamp, symbol, alert_type, severity, message, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(timestamp, symbol, alertType, severity, message, data ? JSON.stringify(data) : null);
  }

  // Query methods

  getRecentSnapshots(symbol: string, limit: number = 100): unknown[] {
    return this.db.prepare(`
      SELECT * FROM market_snapshots
      WHERE symbol = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(symbol, limit);
  }

  getAggregatedHistory(symbol: string, hours: number = 24): unknown[] {
    const since = Date.now() - hours * 60 * 60 * 1000;
    return this.db.prepare(`
      SELECT * FROM aggregated_metrics
      WHERE symbol = ? AND timestamp > ?
      ORDER BY timestamp ASC
    `).all(symbol, since);
  }

  getRiskHistory(symbol: string, hours: number = 24): unknown[] {
    const since = Date.now() - hours * 60 * 60 * 1000;
    return this.db.prepare(`
      SELECT * FROM risk_scores
      WHERE symbol = ? AND timestamp > ?
      ORDER BY timestamp ASC
    `).all(symbol, since);
  }

  getHighRiskPeriods(minScore: number = 60): unknown[] {
    return this.db.prepare(`
      SELECT * FROM risk_scores
      WHERE risk_score >= ?
      ORDER BY timestamp DESC
      LIMIT 100
    `).all(minScore);
  }

  getAlerts(hours: number = 24, severity?: string): unknown[] {
    const since = Date.now() - hours * 60 * 60 * 1000;

    if (severity) {
      return this.db.prepare(`
        SELECT * FROM alerts
        WHERE timestamp > ? AND severity = ?
        ORDER BY timestamp DESC
      `).all(since, severity);
    }

    return this.db.prepare(`
      SELECT * FROM alerts
      WHERE timestamp > ?
      ORDER BY timestamp DESC
    `).all(since);
  }

  // Stats
  getStats(): {
    snapshotCount: number;
    oldestSnapshot: number | null;
    newestSnapshot: number | null;
    alertCount: number;
  } {
    const snapshots = this.db.prepare(`
      SELECT COUNT(*) as count, MIN(timestamp) as oldest, MAX(timestamp) as newest
      FROM market_snapshots
    `).get() as { count: number; oldest: number | null; newest: number | null };

    const alerts = this.db.prepare(`
      SELECT COUNT(*) as count FROM alerts
    `).get() as { count: number };

    return {
      snapshotCount: snapshots.count,
      oldestSnapshot: snapshots.oldest,
      newestSnapshot: snapshots.newest,
      alertCount: alerts.count,
    };
  }

  close(): void {
    this.db.close();
  }
}
