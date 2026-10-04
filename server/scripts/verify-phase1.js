// Phase 1 verification — proves the schema, the catalog, and the guarded
// state machine all behave.
//
//   node scripts/verify-phase1.js

import { query, closePool, healthCheck } from '../src/db/pool.js';
import { createIncident, getTimeline, listServices, findOpenIncident } from '../src/incidents/store.js';
import { transition, canTransition } from '../src/incidents/transitions.js';
import { ACTIONS, isValidAction, needsApproval, actionNames, describeForPrompt } from '../src/actions/catalog.js';

let pass = 0, fail = 0;

function check(label, condition, extra = '') {
  if (condition) { console.log(`  PASS  ${label}`); pass++; }
  else           { console.log(`  FAIL  ${label} ${extra}`); fail++; }
}

console.log('\n=============================================');
console.log(' PHASE 1 VERIFICATION');
console.log('=============================================\n');

// --- 1. Database ------------------------------------------------------------
console.log('1. Database connection and schema');
check('can connect to sre-postgres', await healthCheck());

const tables = await query(`
  SELECT table_name FROM information_schema.tables
   WHERE table_schema = 'public' ORDER BY table_name`);
const names = tables.rows.map(r => r.table_name);
for (const t of ['services','incidents','incident_events','agent_runs','actions','metrics','audit_log']) {
  check(`table "${t}" exists`, names.includes(t));
}

// --- 2. Seed data -----------------------------------------------------------
console.log('\n2. Seeded services and dependency graph');
const services = await listServices();
check('4 services seeded', services.length === 4, `(got ${services.length})`);

const api = services.find(s => s.container_name === 'demo-api');
check('demo-api depends on demo-db',    api?.depends_on.includes('demo-db'));
check('demo-api depends on demo-cache', api?.depends_on.includes('demo-cache'));

const platform = services.filter(s => s.is_platform);
check('exactly 1 protected platform service', platform.length === 1, `(got ${platform.length})`);
check('the protected one is sre-postgres', platform[0]?.container_name === 'sre-postgres');

// --- 3. Action catalog ------------------------------------------------------
console.log('\n3. Action catalog');
check('RESTART_CONTAINER is valid',  isValidAction('RESTART_CONTAINER'));
check('DELETE_EVERYTHING is NOT valid', !isValidAction('DELETE_EVERYTHING'));
check('rm -rf / is NOT valid',       !isValidAction('rm -rf /'));
check('4 actions defined', actionNames().length === 4, `(got ${actionNames().length})`);

check('confidence 0.94 needs approval',      needsApproval('RESTART_CONTAINER', 0.94) === true);
check('confidence 0.96 does NOT',            needsApproval('RESTART_CONTAINER', 0.96) === false);
check('unknown action always needs approval', needsApproval('WHATEVER', 1.0) === true);
check('cache flush command is fixed in our code',
      Array.isArray(ACTIONS.CLEAR_DEMO_CACHE.execCommand));

// --- 4. The guarded state machine ------------------------------------------
console.log('\n4. State machine — legal moves');
const inc = await createIncident({
  service: 'demo-api',
  type: 'CONTAINER_OOM_KILLED',
  detail: { exitCode: 137, oomKilled: true },
});
console.log(`     created ${inc.id}`);
check('starts in DETECTED', inc.status === 'DETECTED');

const t1 = await transition(inc.id, 'TRIAGING', { message: 'Workflow driver picked it up' });
check('DETECTED -> TRIAGING allowed', t1?.status === 'TRIAGING');

const t2 = await transition(inc.id, 'EXECUTING', { message: 'Auto-approved, confidence 0.97' });
check('TRIAGING -> EXECUTING allowed', t2?.status === 'EXECUTING');

// --- 5. Illegal moves are refused ------------------------------------------
console.log('\n5. State machine — illegal moves refused');
const bad = await createIncident({ service: 'demo-cache', type: 'HIGH_CPU' });

const jump = await transition(bad.id, 'RESOLVED', { message: 'should be impossible' });
check('DETECTED -> RESOLVED returns null', jump === null);

const stillDetected = await query('SELECT status FROM incidents WHERE id = $1', [bad.id]);
check('...and the row is untouched', stillDetected.rows[0].status === 'DETECTED',
      `(is ${stillDetected.rows[0].status})`);

// A legal destination that simply isn't reachable from here: SUPPRESSED can
// only be entered from DETECTED, and this incident is in EXECUTING.
const unreachable = await transition(inc.id, 'SUPPRESSED', { message: 'should be impossible' });
check('EXECUTING -> SUPPRESSED returns null', unreachable === null);

// A destination that doesn't exist at all is a typo in OUR code, not a race.
// It should throw loudly rather than fail silently.
let threw = false;
try {
  await transition(inc.id, 'BANANA', { message: 'nonsense' });
} catch {
  threw = true;
}
check('an unknown target status throws', threw);

check('canTransition(DETECTED, RESOLVED) is false', canTransition('DETECTED', 'RESOLVED') === false);
check('canTransition(DETECTED, TRIAGING) is true',  canTransition('DETECTED', 'TRIAGING') === true);

// --- 6. Races: the double-clicked Approve button ----------------------------
console.log('\n6. Concurrency — two simultaneous transitions');
const [a, b] = await Promise.all([
  transition(inc.id, 'VERIFYING', { message: 'first click' }),
  transition(inc.id, 'VERIFYING', { message: 'second click' }),
]);
const winners = [a, b].filter(Boolean).length;
check('exactly one of two concurrent moves wins', winners === 1, `(got ${winners})`);

// --- 7. Duplicate detection -------------------------------------------------
console.log('\n7. Duplicate detection (feeds shouldFire in Phase 2)');
const dup = await findOpenIncident('demo-api', 'CONTAINER_OOM_KILLED');
check('finds the existing open incident', dup?.id === inc.id);
const none = await findOpenIncident('demo-api', 'SOMETHING_ELSE');
check('returns null for a type with no open incident', none === null);

// --- 8. Timeline ------------------------------------------------------------
console.log('\n8. Timeline');
const timeline = await getTimeline(inc.id);
check('timeline has entries', timeline.length >= 4, `(got ${timeline.length})`);
check('first entry is the detection', timeline[0]?.status === 'DETECTED');
console.log('\n     Timeline as the RCA agent will receive it:');
for (const e of timeline) {
  const t = new Date(e.at).toISOString().slice(11, 19);
  console.log(`       ${t}  ${(e.status ?? '').padEnd(18)} ${e.message}`);
}

// --- 9. Resolved sets resolved_at -------------------------------------------
console.log('\n9. resolved_at is stamped automatically');
await transition(inc.id, 'RESOLVED', { message: 'Verification passed' });
const done = await query('SELECT resolved_at FROM incidents WHERE id = $1', [inc.id]);
check('resolved_at is set on RESOLVED', done.rows[0].resolved_at !== null);

// --- cleanup ----------------------------------------------------------------
await query('DELETE FROM incidents WHERE id = ANY($1::text[])', [[inc.id, bad.id]]);
console.log('\n     (test incidents deleted)');

// --- prompt generation ------------------------------------------------------
console.log('\n10. Action list as the AI will be shown it:');
console.log(describeForPrompt().split('\n').map(l => '   ' + l).join('\n'));

console.log('\n=============================================');
console.log(` ${pass} passed, ${fail} failed`);
console.log('=============================================\n');

await closePool();
process.exit(fail === 0 ? 0 : 1);
