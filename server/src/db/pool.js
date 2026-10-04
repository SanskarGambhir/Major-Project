// Postgres connection pool.
//
// Everything that touches the database goes through query() here, so there is
// exactly one place to add logging, timing, or error handling later.

import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  host:     process.env.DB_HOST ?? 'localhost',
  port:     parseInt(process.env.DB_PORT ?? '5432', 10),
  user:     process.env.DB_USER ?? 'sre',
  password: process.env.DB_PASSWORD ?? 'sre_dev_password',
  database: process.env.DB_NAME ?? 'sre_platform',
  max: 10,
  idleTimeoutMillis: 30_000,
});

// An idle client erroring (e.g. Postgres restarted) would otherwise crash the
// whole Node process with an unhandled 'error' event.
pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

/**
 * Run a parameterised query.
 * ALWAYS pass values as $1, $2... — never build SQL by string concatenation.
 */
export async function query(text, params = []) {
  const started = Date.now();
  const res = await pool.query(text, params);
  const ms = Date.now() - started;
  if (ms > 200) console.warn(`[db] slow query ${ms}ms: ${text.slice(0, 80)}`);
  return res;
}

/** Convenience: first row, or null. */
export async function queryOne(text, params = []) {
  const { rows } = await query(text, params);
  return rows[0] ?? null;
}

/** Convenience: all rows. */
export async function queryAll(text, params = []) {
  const { rows } = await query(text, params);
  return rows;
}

export async function healthCheck() {
  try {
    await query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export async function closePool() {
  await pool.end();
}
