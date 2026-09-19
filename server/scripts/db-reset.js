// DESTRUCTIVE. Drops every table and recreates them empty.
//
//   npm run db:reset            asks you to type "yes" first
//   npm run db:reset -- --force skips the prompt (scripts, CI)
//
// This is the ONLY way to delete data in this project. The server can never
// reach it; nothing imports it.

import readline from 'node:readline/promises';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool, closePool } from '../src/db/pool.js';
import { ensureSchema, dataSummary } from '../src/db/init.js';

const here = dirname(fileURLToPath(import.meta.url));
const force = process.argv.includes('--force') || process.argv.includes('-f');

const host = process.env.DB_HOST ?? 'localhost';
const port = process.env.DB_PORT ?? '5432';
const name = process.env.DB_NAME ?? 'sre_platform';

console.log('\n╔════════════════════════════════════════════════════╗');
console.log('║  DATABASE RESET — THIS DELETES DATA                 ║');
console.log('╚════════════════════════════════════════════════════╝\n');
console.log(`Target: ${host}:${port}/${name}\n`);

try {
  // Show exactly what is about to be lost. "3 incidents" is abstract;
  // "2 RCA reports" is the line that makes people stop and think.
  const data = await dataSummary();

  if (!data) {
    console.log('No schema found — nothing to delete. Will create fresh tables.\n');
  } else {
    const hasData = data.incidents > 0 || data.metrics > 0 || data.audit_log > 0;

    console.log('You are about to permanently delete:\n');
    console.log(`    ${String(data.incidents).padStart(6)}  incidents`);
    console.log(`    ${String(data.events).padStart(6)}  timeline entries`);
    console.log(`    ${String(data.actions).padStart(6)}  remediation records`);
    console.log(`    ${String(data.agent_runs).padStart(6)}  AI runs`);
    console.log(`    ${String(data.metrics).padStart(6)}  metric samples`);
    console.log(`    ${String(data.audit_log).padStart(6)}  audit entries`);

    if (data.rca_reports > 0) {
      console.log(`\n  ⚠  ${data.rca_reports} RCA REPORT(S) will be lost.`);
      console.log('     If any of those are going in your project report, back up first:');
      console.log('       docker exec sre-postgres pg_dump -U sre -d sre_platform \\');
      console.log('         --clean --if-exists -f /tmp/backup.sql');
      console.log('       docker cp sre-postgres:/tmp/backup.sql ./sre_backup.sql');
    }

    if (!hasData) {
      console.log('\n  (the database is already effectively empty)');
    }
    console.log('');
  }

  // --- confirmation --------------------------------------------------------
  if (!force) {
    if (!process.stdin.isTTY) {
      console.error('Not an interactive terminal, so I cannot ask for confirmation.');
      console.error('Re-run with --force if you are sure:\n');
      console.error('    npm run db:reset -- --force\n');
      process.exitCode = 1;
      await closePool();
      process.exit();
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('Type "yes" to confirm, anything else to cancel: ');
    rl.close();

    if (answer.trim().toLowerCase() !== 'yes') {
      console.log('\nCancelled. Nothing was deleted.\n');
      await closePool();
      process.exit(0);
    }
  } else {
    console.log('--force given, skipping confirmation.\n');
  }

  // --- do it ---------------------------------------------------------------
  console.log('\nDropping tables...');
  const dropSql = await readFile(join(here, '..', 'src', 'db', 'drop.sql'), 'utf8');
  await pool.query(dropSql);

  console.log('Recreating schema...');
  const { total } = await ensureSchema({ verbose: false });

  console.log(`\nDone. ${total} empty tables, services re-seeded.`);
  console.log('Incident numbering restarts at INC-1000.\n');
} catch (err) {
  console.error(`\nFailed: ${err.message}\n`);
  process.exitCode = 1;
} finally {
  await closePool();
}
