// =============================================================================
// shouldFire — "the rules say something is wrong. Do we open an incident?"
//
// A rule fires on every 3-second poll for as long as the condition holds. An
// exited container stays exited, so without this file one dead container
// would create a new incident every 3 seconds — hundreds in a few minutes.
//
// Four checks, in order. The first one that says "no" wins.
//
//   1. DUPLICATE   — there's already an open incident for this service+type
//   2. COOLDOWN    — we just remediated this service; give it time to settle
//   3. CORRELATED  — something this service DEPENDS ON is already broken, so
//                    this is a symptom, not the disease   (Phase 6 fills in)
//   4. BREAKER     — we've restarted this too many times; stop and escalate
//
// The result is always an object so the caller can log WHY nothing happened.
// "Nothing happened" with no reason is the hardest thing to debug at 2am.
// =============================================================================

import { queryOne } from '../db/pool.js';
import { findOpenIncident, findAnyOpenIncident, getService } from '../incidents/store.js';

const COOLDOWN_MS           = Number(process.env.COOLDOWN_MS ?? 60000);
const MAX_RESTARTS_PER_HOUR = Number(process.env.MAX_RESTARTS_PER_HOUR ?? 3);

/**
 * Did we run a successful action against this container within `ms`?
 * Containers look unhealthy for a few seconds after any restart — we must
 * not raise an incident about our own fix.
 */
async function remediatedWithin(service, ms) {
  const row = await queryOne(
    `SELECT id FROM actions
      WHERE target = $1
        AND result = 'success'
        AND finished_at > now() - ($2 || ' milliseconds')::interval
      LIMIT 1`,
    [service, String(ms)]
  );
  return Boolean(row);
}

/** How many times have we restarted this container in the last hour? */
async function restartsInLastHour(service) {
  const row = await queryOne(
    `SELECT count(*)::int AS n FROM actions
      WHERE target = $1
        AND action_type IN ('RESTART_CONTAINER', 'START_CONTAINER')
        AND result = 'success'
        AND started_at > now() - interval '1 hour'`,
    [service]
  );
  return row?.n ?? 0;
}

/**
 * ALERT CORRELATION.
 *
 * If demo-db is down, demo-api will throw connection errors, fail its health
 * check, and look sick — but restarting demo-api fixes nothing. The right
 * move is to fix demo-db and let demo-api recover on its own.
 *
 * Returns the open incident on an upstream dependency, or null.
 * Phase 2 ships this as a working-but-simple version; Phase 6 adds the UI
 * panel that makes the suppression visible.
 */
export async function findBrokenDependency(service) {
  const svc = await getService(service);
  if (!svc || !svc.depends_on?.length) return null;

  for (const dep of svc.depends_on) {
    const upstream = await findAnyOpenIncident(dep);
    if (upstream) return upstream;
  }
  return null;
}

/**
 * @param {string} service   container name
 * @param {string} type      incident type from rules.js
 * @returns {{fire: boolean, reason?: string, suppressedBy?: object, escalate?: boolean}}
 */
export async function shouldFire(service, type) {
  if (await findOpenIncident(service, type)) {
    return { fire: false, reason: 'duplicate' };
  }

  if (await remediatedWithin(service, COOLDOWN_MS)) {
    return { fire: false, reason: 'cooldown' };
  }

  const upstream = await findBrokenDependency(service);
  if (upstream) {
    return { fire: false, reason: 'correlated', suppressedBy: upstream };
  }

  if ((await restartsInLastHour(service)) >= MAX_RESTARTS_PER_HOUR) {
    return { fire: false, reason: 'breaker', escalate: true };
  }

  return { fire: true };
}
