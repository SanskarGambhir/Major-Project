// =============================================================================
// Schema initialisation — safe, idempotent, automatic.
//
// ensureSchema() runs when the server starts. Because schema.sql uses
// IF NOT EXISTS everywhere and ON CONFLICT DO NOTHING for the seed, calling it
// against a database that already has data changes nothing and destroys
// nothing. Run it a hundred times; the result is identical.
//
// Nothing here can delete data. Destruction lives in drop.sql, reachable only
// through `npm run db:reset`.
// =============================================================================

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from './pool.js';

const here = dirname(fileURLToPath(import.meta.url));

const OUR_TABLES = [
  'services', 'incidents', 'incident_events',
  'agent_runs', 'actions', 'metrics', 'audit_log',
];

async function existingTables() {
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [OUR_TABLES]
  );
  return rows.map(r => r.table_name);
}

/**
 * Make sure every table exists. Creates only what is missing.
 *
 * @returns {{ created: string[], existing: string[], total: number }}
 */
export async function ensureSchema({ verbose = true } = {}) {
  const before = await existingTables();

  // Always run it. On an already-complete database this is a handful of
  // cheap no-ops, and it also repairs a partially-created schema — which can
  // happen if someone interrupts a reset halfway through.
  const sql = await readFile(join(here, 'schema.sql'), 'utf8');
  await pool.query(sql);

  const after = await existingTables();
  const created = after.filter(t => !before.includes(t));

  if (verbose) {
    if (created.length === after.length) {
      console.log(`[db] schema created — ${created.length} tables`);
    } else if (created.length > 0) {
      console.log(`[db] schema repaired — added ${created.join(', ')}`);
    } else {
      console.log(`[db] schema ok — ${after.length} tables`);
    }
  }

  return { created, existing: before, total: after.length };
}

/** Are all our tables present? */
export async function schemaIsComplete() {
  const found = await existingTables();
  return found.length === OUR_TABLES.length;
}

/**
 * Row counts, for the reset confirmation prompt and for diagnostics.
 * Returns null if the schema isn't there yet.
 */
export async function dataSummary() {
  if (!(await schemaIsComplete())) return null;

  const { rows } = await pool.query(`
    SELECT
      (SELECT count(*) FROM incidents)       AS incidents,
      (SELECT count(*) FROM incident_events) AS events,
      (SELECT count(*) FROM actions)         AS actions,
      (SELECT count(*) FROM agent_runs)      AS agent_runs,
      (SELECT count(*) FROM metrics)         AS metrics,
      (SELECT count(*) FROM audit_log)       AS audit_log,
      (SELECT count(*) FROM services)        AS services,
      (SELECT count(*) FROM incidents WHERE rca_report IS NOT NULL) AS rca_reports
  `);

  const r = rows[0];
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)]));
}
