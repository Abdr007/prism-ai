/**
 * Cascade Event Repository
 *
 * Dedicated persistence layer for liquidation cascade ground-truth data.
 * Provides idempotent inserts (deterministic IDs, ON CONFLICT DO NOTHING)
 * and time-range queries for backtesting alignment.
 *
 * Works with any pg.Pool — can share the pool from PrismDB or use its own.
 */

import type pg from 'pg';
import type { CascadeEvent } from '../predictor/cascadeDetector.js';

// ---------------------------------------------------------------------------
// Row type returned by queries
// ---------------------------------------------------------------------------

export interface CascadeEventRow {
  id: string;
  symbol: string;
  direction: 'LONG_SQUEEZE' | 'SHORT_SQUEEZE';
  start_time: Date;
  end_time: Date;
  price_change_pct: number;
  liquidation_volume_usd: number;
}

// ---------------------------------------------------------------------------
// Deterministic ID
// ---------------------------------------------------------------------------

/**
 * Produces a stable, human-readable ID from the natural key.
 *
 * Format: `BTC:LONG_SQUEEZE:1700000000000`
 *
 * Two cascade detections with identical (symbol, direction, start_time)
 * always produce the same ID, making inserts naturally idempotent via
 * the PRIMARY KEY conflict clause.
 */
export function cascadeEventId(
  symbol: string,
  direction: string,
  startTimeMs: number,
): string {
  return `${symbol}:${direction}:${startTimeMs}`;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class CascadeRepository {
  constructor(private readonly pool: pg.Pool) {}

  // -----------------------------------------------------------------------
  // Writes
  // -----------------------------------------------------------------------

  /**
   * Insert a single cascade event. Idempotent — duplicate natural keys
   * are silently skipped via ON CONFLICT DO NOTHING.
   *
   * Returns the deterministic id (whether inserted or already present).
   */
  async insertCascadeEvent(event: CascadeEvent): Promise<string> {
    const id = cascadeEventId(event.symbol, event.direction, event.startTime);

    await this.pool.query(
      `INSERT INTO cascade_events
        (id, symbol, direction, start_time, end_time,
         price_change_pct, liquidation_volume_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [
        id,
        event.symbol,
        event.direction,
        new Date(event.startTime),
        new Date(event.endTime),
        event.priceChangePct,
        event.liquidationVolumeUSD,
      ],
    );

    return id;
  }

  /**
   * Batch-insert cascade events in a single transaction.
   * Each row is idempotent — duplicates are silently skipped.
   *
   * Returns the count of rows actually inserted (excludes conflicts).
   */
  async insertCascadeEvents(events: CascadeEvent[]): Promise<number> {
    if (events.length === 0) return 0;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      let inserted = 0;
      for (const event of events) {
        const id = cascadeEventId(
          event.symbol,
          event.direction,
          event.startTime,
        );

        const result = await client.query(
          `INSERT INTO cascade_events
            (id, symbol, direction, start_time, end_time,
             price_change_pct, liquidation_volume_usd)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO NOTHING`,
          [
            id,
            event.symbol,
            event.direction,
            new Date(event.startTime),
            new Date(event.endTime),
            event.priceChangePct,
            event.liquidationVolumeUSD,
          ],
        );

        if (result.rowCount && result.rowCount > 0) {
          inserted++;
        }
      }

      await client.query('COMMIT');
      return inserted;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // -----------------------------------------------------------------------
  // Reads
  // -----------------------------------------------------------------------

  /**
   * Query cascade events for a symbol within a time range.
   *
   * Returns events whose start_time falls within [startTime, endTime].
   * Results ordered by start_time ASC for chronological backtest alignment.
   */
  async getCascadeEvents(
    symbol: string,
    startTime: Date,
    endTime: Date,
  ): Promise<CascadeEventRow[]> {
    const { rows } = await this.pool.query<CascadeEventRow>(
      `SELECT id, symbol, direction, start_time, end_time,
              price_change_pct, liquidation_volume_usd
       FROM cascade_events
       WHERE symbol = $1
         AND start_time >= $2
         AND start_time <= $3
       ORDER BY start_time ASC`,
      [symbol, startTime, endTime],
    );
    return rows;
  }

  /**
   * Query cascade events filtered by direction.
   */
  async getCascadeEventsByDirection(
    symbol: string,
    direction: 'LONG_SQUEEZE' | 'SHORT_SQUEEZE',
    startTime: Date,
    endTime: Date,
  ): Promise<CascadeEventRow[]> {
    const { rows } = await this.pool.query<CascadeEventRow>(
      `SELECT id, symbol, direction, start_time, end_time,
              price_change_pct, liquidation_volume_usd
       FROM cascade_events
       WHERE symbol = $1
         AND direction = $2
         AND start_time >= $3
         AND start_time <= $4
       ORDER BY start_time ASC`,
      [symbol, direction, startTime, endTime],
    );
    return rows;
  }

  /**
   * Get the most recent cascade events across all symbols.
   */
  async getRecentCascadeEvents(
    limit: number = 100,
  ): Promise<CascadeEventRow[]> {
    const { rows } = await this.pool.query<CascadeEventRow>(
      `SELECT id, symbol, direction, start_time, end_time,
              price_change_pct, liquidation_volume_usd
       FROM cascade_events
       ORDER BY start_time DESC
       LIMIT $1`,
      [limit],
    );
    return rows;
  }

  /**
   * Count cascade events per symbol within a time range.
   * Useful for backtest coverage validation.
   */
  async countBySymbol(
    startTime: Date,
    endTime: Date,
  ): Promise<Array<{ symbol: string; count: number }>> {
    const { rows } = await this.pool.query<{ symbol: string; count: string }>(
      `SELECT symbol, COUNT(*) AS count
       FROM cascade_events
       WHERE start_time >= $1 AND start_time <= $2
       GROUP BY symbol
       ORDER BY count DESC`,
      [startTime, endTime],
    );
    return rows.map((r) => ({ symbol: r.symbol, count: parseInt(r.count, 10) }));
  }
}
