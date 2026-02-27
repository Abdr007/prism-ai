/**
 * One-time migration script: SQLite → PostgreSQL
 *
 * Usage:
 *   npx tsx scripts/migrate-sqlite-to-pg.ts [sqlite-path] [pg-url]
 *
 * Defaults:
 *   sqlite-path  = ./data/prism.db
 *   pg-url       = process.env.DATABASE_URL || postgresql://prism:prism@localhost:5432/prism
 */

import Database from 'better-sqlite3';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sqlitePath = process.argv[2] || path.join(__dirname, '../data/prism.db');
const pgUrl =
  process.argv[3] ||
  process.env.DATABASE_URL ||
  'postgresql://prism:prism@localhost:5432/prism';

async function migrate(): Promise<void> {
  // Verify SQLite file exists
  if (!fs.existsSync(sqlitePath)) {
    console.error(`SQLite file not found: ${sqlitePath}`);
    process.exit(1);
  }

  const sqlite = new Database(sqlitePath, { readonly: true });
  const pool = new pg.Pool({ connectionString: pgUrl });

  try {
    // Ensure PG schema exists
    const schemaPath = path.join(__dirname, '../src/db/schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf-8');
    await pool.query(schemaSql);
    console.log('PG schema ensured.');

    // -------------------------------------------------------------------
    // 1. market_snapshots → perp_market_data
    // -------------------------------------------------------------------
    const snapshots = sqlite
      .prepare('SELECT * FROM market_snapshots')
      .all() as Array<{
      timestamp: number;
      symbol: string;
      exchange: string;
      mark_price: number;
      index_price: number;
      funding_rate: number;
      open_interest: number;
      open_interest_value: number;
    }>;

    console.log(`Migrating ${snapshots.length} market snapshots...`);
    let inserted = 0;
    for (const row of snapshots) {
      try {
        await pool.query(
          `INSERT INTO perp_market_data
            (time, symbol, exchange, mark_price, index_price, funding_rate, open_interest, open_interest_usd)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT DO NOTHING`,
          [
            new Date(row.timestamp),
            row.symbol,
            row.exchange,
            row.mark_price || 0,
            row.index_price || 0,
            row.funding_rate || 0,
            row.open_interest || 0,
            row.open_interest_value || 0,
          ],
        );
        inserted++;
      } catch (err) {
        console.warn(`  skip snapshot row: ${(err as Error).message}`);
      }
    }
    console.log(`  inserted ${inserted} / ${snapshots.length}`);

    // -------------------------------------------------------------------
    // 2. aggregated_metrics → aggregated_snapshots
    // -------------------------------------------------------------------
    const aggRows = sqlite
      .prepare('SELECT * FROM aggregated_metrics')
      .all() as Array<{
      timestamp: number;
      symbol: string;
      total_oi_value: number;
      avg_funding_rate: number;
      avg_mark_price: number;
      price_deviation: number;
      exchanges_count: number;
    }>;

    console.log(`Migrating ${aggRows.length} aggregated metrics...`);
    inserted = 0;
    for (const row of aggRows) {
      try {
        await pool.query(
          `INSERT INTO aggregated_snapshots
            (time, symbol, avg_mark_price, avg_funding_rate, total_oi_usd,
             price_spread_pct, funding_spread_pct, exchange_count)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT DO NOTHING`,
          [
            new Date(row.timestamp),
            row.symbol,
            row.avg_mark_price || 0,
            row.avg_funding_rate || 0,
            row.total_oi_value || 0,
            row.price_deviation || 0,
            0, // funding_spread_pct not in old schema
            row.exchanges_count || 0,
          ],
        );
        inserted++;
      } catch (err) {
        console.warn(`  skip agg row: ${(err as Error).message}`);
      }
    }
    console.log(`  inserted ${inserted} / ${aggRows.length}`);

    // -------------------------------------------------------------------
    // 3. risk_scores → risk_scores (+ compute confidence retroactively)
    // -------------------------------------------------------------------
    const riskRows = sqlite
      .prepare('SELECT * FROM risk_scores')
      .all() as Array<{
      timestamp: number;
      symbol: string;
      risk_score: number;
      risk_level: string;
      prediction_direction: string | null;
      prediction_probability: number | null;
      prediction_impact: number | null;
      prediction_trigger_price: number | null;
    }>;

    console.log(`Migrating ${riskRows.length} risk scores...`);
    inserted = 0;
    for (const row of riskRows) {
      const confidence =
        1 / (1 + Math.exp(-0.1 * ((row.risk_score || 0) - 50)));
      try {
        await pool.query(
          `INSERT INTO risk_scores
            (time, symbol, risk_score, risk_level, confidence,
             prediction_direction, prediction_probability,
             prediction_impact_usd, prediction_trigger_price)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT DO NOTHING`,
          [
            new Date(row.timestamp),
            row.symbol,
            row.risk_score || 0,
            row.risk_level || 'low',
            confidence,
            row.prediction_direction || null,
            row.prediction_probability || null,
            row.prediction_impact || null,
            row.prediction_trigger_price || null,
          ],
        );
        inserted++;
      } catch (err) {
        console.warn(`  skip risk row: ${(err as Error).message}`);
      }
    }
    console.log(`  inserted ${inserted} / ${riskRows.length}`);

    // -------------------------------------------------------------------
    // 4. alerts → alerts
    // -------------------------------------------------------------------
    const alertRows = sqlite
      .prepare('SELECT * FROM alerts')
      .all() as Array<{
      timestamp: number;
      symbol: string;
      alert_type: string;
      severity: string;
      message: string | null;
      data: string | null;
    }>;

    console.log(`Migrating ${alertRows.length} alerts...`);
    inserted = 0;
    for (const row of alertRows) {
      try {
        await pool.query(
          `INSERT INTO alerts (time, symbol, alert_type, severity, message, data)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            new Date(row.timestamp),
            row.symbol,
            row.alert_type,
            row.severity,
            row.message || null,
            row.data || null, // already JSON string, PG will cast to JSONB
          ],
        );
        inserted++;
      } catch (err) {
        console.warn(`  skip alert row: ${(err as Error).message}`);
      }
    }
    console.log(`  inserted ${inserted} / ${alertRows.length}`);

    console.log('\nMigration complete!');
  } finally {
    sqlite.close();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
