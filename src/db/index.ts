import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { AggregatedData } from '../aggregator/index.js';
import type { CascadeRisk } from '../predictor/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_DATABASE_URL = 'postgresql://prism:prism@localhost:5432/prism';

// ---------------------------------------------------------------------------
// Typed Row Interfaces
// ---------------------------------------------------------------------------

export interface PerpMarketDataRow {
  time: Date;
  symbol: string;
  exchange: string;
  mark_price: number;
  index_price: number;
  funding_rate: number;
  open_interest: number;
  open_interest_usd: number;
}

export interface AggregatedSnapshotRow {
  time: Date;
  symbol: string;
  avg_mark_price: number;
  avg_funding_rate: number;
  total_oi_usd: number;
  price_spread_pct: number;
  funding_spread_pct: number;
  funding_z_score: number;
  oi_z_score: number;
  exchange_count: number;
}

export interface RiskScoreRow {
  time: Date;
  symbol: string;
  risk_score: number;
  risk_level: string;
  confidence: number;
  prediction_direction: string | null;
  prediction_probability: number | null;
  prediction_impact_usd: number | null;
  prediction_trigger_price: number | null;
}

export interface AlertRow {
  id: string;
  time: Date;
  symbol: string;
  alert_type: string;
  severity: string;
  message: string | null;
  data: Record<string, unknown> | null;
}

export interface CascadeEventRow {
  id: string;
  symbol: string;
  direction: string;
  start_time: Date;
  end_time: Date;
  price_change_pct: number;
  liquidation_volume_usd: number;
}

export interface DbStats {
  snapshotCount: number;
  oldestSnapshot: number | null;
  newestSnapshot: number | null;
  alertCount: number;
}

// ---------------------------------------------------------------------------
// PrismDB — PostgreSQL async repository
// ---------------------------------------------------------------------------

export class PrismDB {
  private pool: pg.Pool;

  constructor(databaseUrl?: string) {
    const connectionString =
      databaseUrl || process.env.DATABASE_URL || DEFAULT_DATABASE_URL;

    this.pool = new pg.Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }

  // -----------------------------------------------------------------------
  // Schema bootstrap (idempotent)
  // -----------------------------------------------------------------------

  async ensureSchema(): Promise<void> {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf-8');
    await this.pool.query(sql);
  }

  // -----------------------------------------------------------------------
  // Writes
  // -----------------------------------------------------------------------

  async saveSnapshot(data: AggregatedData): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      for (const symbol of data.symbols) {
        const metrics = data.metrics[symbol];
        if (!metrics) continue;

        // Per-exchange rows
        for (const exchange of data.exchanges) {
          const oi = metrics.openInterestByExchange[exchange] || 0;
          const funding = metrics.fundingRateByExchange[exchange] || 0;
          const price = metrics.markPriceByExchange[exchange] || 0;

          await client.query(
            `INSERT INTO perp_market_data
              (time, symbol, exchange, mark_price, index_price, funding_rate, open_interest, open_interest_usd)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (time, symbol, exchange) DO UPDATE SET
              mark_price        = EXCLUDED.mark_price,
              index_price       = EXCLUDED.index_price,
              funding_rate      = EXCLUDED.funding_rate,
              open_interest     = EXCLUDED.open_interest,
              open_interest_usd = EXCLUDED.open_interest_usd`,
            [
              new Date(data.timestamp),
              symbol,
              exchange,
              price,
              price, // index_price same as mark for simplicity
              funding,
              oi / (price || 1), // contracts
              oi,
            ],
          );
        }

        // Compute funding_spread_pct from exchange rates
        const fundingRates = Object.values(metrics.fundingRateByExchange);
        const fundingSpreadPct =
          fundingRates.length >= 2
            ? Math.max(...fundingRates) - Math.min(...fundingRates)
            : 0;

        // Aggregated row
        await client.query(
          `INSERT INTO aggregated_snapshots
            (time, symbol, avg_mark_price, avg_funding_rate, total_oi_usd,
             price_spread_pct, funding_spread_pct, exchange_count)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (time, symbol) DO UPDATE SET
            avg_mark_price     = EXCLUDED.avg_mark_price,
            avg_funding_rate   = EXCLUDED.avg_funding_rate,
            total_oi_usd       = EXCLUDED.total_oi_usd,
            price_spread_pct   = EXCLUDED.price_spread_pct,
            funding_spread_pct = EXCLUDED.funding_spread_pct,
            exchange_count     = EXCLUDED.exchange_count`,
          [
            new Date(data.timestamp),
            symbol,
            metrics.avgMarkPrice,
            metrics.avgFundingRate,
            metrics.totalOpenInterestValue,
            metrics.priceDeviation,
            fundingSpreadPct,
            data.exchanges.length,
          ],
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async saveRiskScores(risks: CascadeRisk[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      for (const risk of risks) {
        await client.query(
          `INSERT INTO risk_scores
            (time, symbol, risk_score, risk_level, confidence,
             prediction_direction, prediction_probability,
             prediction_impact_usd, prediction_trigger_price)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (time, symbol) DO UPDATE SET
            risk_score               = EXCLUDED.risk_score,
            risk_level               = EXCLUDED.risk_level,
            confidence               = EXCLUDED.confidence,
            prediction_direction     = EXCLUDED.prediction_direction,
            prediction_probability   = EXCLUDED.prediction_probability,
            prediction_impact_usd    = EXCLUDED.prediction_impact_usd,
            prediction_trigger_price = EXCLUDED.prediction_trigger_price`,
          [
            new Date(risk.timestamp),
            risk.symbol,
            risk.riskScore,
            risk.riskLevel,
            risk.confidence,
            risk.prediction?.direction || null,
            risk.prediction?.probability || null,
            risk.prediction?.estimatedImpact || null,
            risk.prediction?.triggerPrice || null,
          ],
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async saveAlert(
    timestamp: number,
    symbol: string,
    alertType: string,
    severity: string,
    message: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO alerts (time, symbol, alert_type, severity, message, data)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        new Date(timestamp),
        symbol,
        alertType,
        severity,
        message,
        data ? JSON.stringify(data) : null,
      ],
    );
  }

  // -----------------------------------------------------------------------
  // Reads
  // -----------------------------------------------------------------------

  async getRecentSnapshots(
    symbol: string,
    limit: number = 100,
  ): Promise<PerpMarketDataRow[]> {
    const { rows } = await this.pool.query<PerpMarketDataRow>(
      `SELECT * FROM perp_market_data
       WHERE symbol = $1
       ORDER BY time DESC
       LIMIT $2`,
      [symbol, limit],
    );
    return rows;
  }

  async getAggregatedHistory(
    symbol: string,
    hours: number = 24,
  ): Promise<AggregatedSnapshotRow[]> {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const { rows } = await this.pool.query<AggregatedSnapshotRow>(
      `SELECT * FROM aggregated_snapshots
       WHERE symbol = $1 AND time > $2
       ORDER BY time ASC`,
      [symbol, since],
    );
    return rows;
  }

  async getRiskHistory(
    symbol: string,
    hours: number = 24,
  ): Promise<RiskScoreRow[]> {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const { rows } = await this.pool.query<RiskScoreRow>(
      `SELECT * FROM risk_scores
       WHERE symbol = $1 AND time > $2
       ORDER BY time ASC`,
      [symbol, since],
    );
    return rows;
  }

  async getHighRiskPeriods(minScore: number = 60): Promise<RiskScoreRow[]> {
    const { rows } = await this.pool.query<RiskScoreRow>(
      `SELECT * FROM risk_scores
       WHERE risk_score >= $1
       ORDER BY time DESC
       LIMIT 100`,
      [minScore],
    );
    return rows;
  }

  async getAlerts(
    hours: number = 24,
    severity?: string,
  ): Promise<AlertRow[]> {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    if (severity) {
      const { rows } = await this.pool.query<AlertRow>(
        `SELECT * FROM alerts
         WHERE time > $1 AND severity = $2
         ORDER BY time DESC`,
        [since, severity],
      );
      return rows;
    }

    const { rows } = await this.pool.query<AlertRow>(
      `SELECT * FROM alerts
       WHERE time > $1
       ORDER BY time DESC`,
      [since],
    );
    return rows;
  }

  async getStats(): Promise<DbStats> {
    const snapResult = await this.pool.query(
      `SELECT COUNT(*) AS count, MIN(time) AS oldest, MAX(time) AS newest
       FROM perp_market_data`,
    );
    const alertResult = await this.pool.query(
      `SELECT COUNT(*) AS count FROM alerts`,
    );

    const snap = snapResult.rows[0];
    const alertCount = parseInt(alertResult.rows[0].count, 10);

    return {
      snapshotCount: parseInt(snap.count, 10),
      oldestSnapshot: snap.oldest ? new Date(snap.oldest).getTime() : null,
      newestSnapshot: snap.newest ? new Date(snap.newest).getTime() : null,
      alertCount,
    };
  }

  // -----------------------------------------------------------------------
  // Backtest methods
  // -----------------------------------------------------------------------

  async saveCascadeEvent(
    startTime: Date,
    endTime: Date,
    symbol: string,
    priceChangePct: number,
    liquidationVolumeUsd: number,
    direction: string,
  ): Promise<string> {
    const id = `${symbol}:${direction}:${startTime.getTime()}`;
    await this.pool.query(
      `INSERT INTO cascade_events
        (id, symbol, direction, start_time, end_time,
         price_change_pct, liquidation_volume_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [id, symbol, direction, startTime, endTime, priceChangePct, liquidationVolumeUsd],
    );
    return id;
  }

  async getCascadeEvents(
    symbol?: string,
    limit: number = 100,
  ): Promise<CascadeEventRow[]> {
    if (symbol) {
      const { rows } = await this.pool.query<CascadeEventRow>(
        `SELECT * FROM cascade_events
         WHERE symbol = $1
         ORDER BY start_time DESC
         LIMIT $2`,
        [symbol, limit],
      );
      return rows;
    }

    const { rows } = await this.pool.query<CascadeEventRow>(
      `SELECT * FROM cascade_events
       ORDER BY start_time DESC
       LIMIT $1`,
      [limit],
    );
    return rows;
  }

  async getRiskScoresForBacktest(
    symbol: string,
    startTime: Date,
    endTime: Date,
  ): Promise<RiskScoreRow[]> {
    const { rows } = await this.pool.query<RiskScoreRow>(
      `SELECT * FROM risk_scores
       WHERE symbol = $1 AND time >= $2 AND time <= $3
       ORDER BY time ASC`,
      [symbol, startTime, endTime],
    );
    return rows;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /** Expose the pool so dedicated repositories (e.g. CascadeRepository) can share it. */
  getPool(): pg.Pool {
    return this.pool;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
