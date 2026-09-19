// Create any missing tables. SAFE — never deletes anything.
//
//   npm run db:init
//
// You rarely need to run this by hand: the server calls ensureSchema() on
// startup. It's here for setting up before the server exists, and for
// checking the database is reachable.

import { ensureSchema, dataSummary } from '../src/db/init.js';
import { closePool } from '../src/db/pool.js';

const host = process.env.DB_HOST ?? 'localhost';
const port = process.env.DB_PORT ?? '5432';
const name = process.env.DB_NAME ?? 'sre_platform';

console.log(`\nTarget: ${host}:${port}/${name}\n`);

try {
  const { created, total } = await ensureSchema({ verbose: false });

  if (created.length === total) {
    console.log(`Created ${total} tables:`);
    for (const t of created) console.log(`  + ${t}`);
  } else if (created.length > 0) {
    console.log(`Schema was incomplete. Added:`);
    for (const t of created) console.log(`  + ${t}`);
  } else {
    console.log(`Schema already complete — ${total} tables, nothing to do.`);
  }

  const data = await dataSummary();
  if (data) {
    console.log(`\nCurrent contents:`);
    console.log(`  services   ${data.services}`);
    console.log(`  incidents  ${data.incidents}`);
    console.log(`  metrics    ${data.metrics}`);
  }

  console.log('\nDone. No data was deleted.\n');
} catch (err) {
  console.error(`\nFailed: ${err.message}\n`);

  if (err.code === '28P01') {
    console.error('"password authentication failed" usually means something ELSE is');
    console.error(`listening on port ${port} — a native Postgres install, for example.`);
    console.error('Check with:');
    console.error(`  Get-NetTCPConnection -LocalPort ${port} -State Listen\n`);
  }
  if (err.code === 'ECONNREFUSED') {
    console.error('Nothing is listening. Is the container running?');
    console.error('  docker compose -f docker/platform.compose.yml up -d\n');
  }

  process.exitCode = 1;
} finally {
  await closePool();
}
