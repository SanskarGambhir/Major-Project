// =============================================================================
// The poller — the 3-second heartbeat of the whole system.
//
// Every tick:
//   1. Ask Docker "how is everyone?"            (listOurContainers)
//   2. For each container, build one READING    (inspect + stats)
//   3. Remember it                              (in-memory history + metrics table)
//   4. Tell the browser                         (emitMetrics)
//   5. For each demo service, ask the rules     (evaluate → shouldFire → create)
//   6. Check whether open incidents recovered   (isRecovered → AUTO_RESOLVED)
//
// PROMISE.ALLSETTLED, NOT PROMISE.ALL
// ---------------------------------------------------------------------------
// One container's stats call hanging or throwing must not lose the reading
// for the other three. allSettled gives us every result that succeeded and
// an error for each that didn't; we log the errors and carry on.
//
// INSPECT ON EXIT, IMMEDIATELY
// ---------------------------------------------------------------------------
// ExitCode and OOMKilled only exist while the stopped container still exists.
// If someone runs `docker compose down`, the evidence is gone. So the moment
// we see `exited`, we inspect and stash the answer inside the incident's
// first timeline entry, where nothing can delete it.
// =============================================================================

import { listOurContainers, inspect, LABEL_PLATFORM } from '../docker/client.js';
import { getStats } from '../docker/stats.js';
import { evaluate, isRecovered } from './rules.js';
import { shouldFire } from './shouldFire.js';
import { query } from '../db/pool.js';
import {
  createIncident, listOpenIncidents, markSuppressedBy, logEvent, audit,
} from '../incidents/store.js';
import { transition } from '../incidents/transitions.js';
import { emitMetrics } from '../realtime/socket.js';

const POLL_INTERVAL_MS        = Number(process.env.POLL_INTERVAL_MS ?? 3000);
const METRICS_RETENTION_HOURS = Number(process.env.METRICS_RETENTION_HOURS ?? 2);
const HISTORY_LENGTH          = 40;   // sparkline points per service

// service name → [reading, reading, ...] newest last
const history = {};

let timer = null;
let ticking = false;
let tickCount = 0;

// -----------------------------------------------------------------------------
// Building one reading
// -----------------------------------------------------------------------------

/**
 * Everything we know about one container right now, flattened into one
 * plain object. This shape is what the rules, the DB, and the UI all see.
 */
async function readContainer(summary) {
  const name = summary.Names[0].replace(/^\//, '');
  const isPlatform = summary.Labels?.[LABEL_PLATFORM] === 'true';

  const info = await inspect(name);
  if (!info) return null;   // removed between list and inspect

  const state = info.State;
  const reading = {
    service:       name,
    is_platform:   isPlatform,
    at:            Date.now(),
    status:        state.Status,                       // running | exited | ...
    health:        state.Health?.Status ?? 'none',     // healthy | unhealthy | starting | none
    exit_code:     state.ExitCode,
    oom_killed:    Boolean(state.OOMKilled),
    started_at:    state.StartedAt,
    finished_at:   state.FinishedAt,
    restart_count: info.RestartCount ?? 0,
    cpu_pct:       0,
    mem_used:      0,
    mem_limit:     0,
    mem_pct:       0,
  };

  // Stats only make sense for a running container. Asking a stopped one
  // returns zeros after a delay, so skip it.
  if (state.Running) {
    try {
      const s = await getStats(name);
      reading.cpu_pct   = s.cpu_pct;
      reading.mem_used  = s.used;
      reading.mem_limit = s.limit;
      reading.mem_pct   = s.pct;
    } catch (err) {
      console.warn(`[poller] stats failed for ${name}: ${err.message}`);
    }
  }

  return reading;
}

function remember(reading) {
  const list = history[reading.service] ??= [];
  list.push(reading);
  if (list.length > HISTORY_LENGTH) list.shift();
}

async function persist(readings) {
  if (readings.length === 0) return;

  // One INSERT with many rows, not one INSERT per row.
  const values = [];
  const params = [];
  readings.forEach((r, i) => {
    const b = i * 8;
    values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8})`);
    params.push(r.service, r.status, r.health, r.cpu_pct, r.mem_used, r.mem_limit, r.mem_pct, r.restart_count);
  });

  await query(
    `INSERT INTO metrics (service, status, health, cpu_pct, mem_used, mem_limit, mem_pct, restart_count)
     VALUES ${values.join(', ')}`,
    params
  );
}

// -----------------------------------------------------------------------------
// Detection
// -----------------------------------------------------------------------------

async function detect(reading) {
  // Platform containers are monitored (you can see sre-postgres on the
  // dashboard) but never become incidents: they're outside remediation, and
  // if sre-postgres is down we couldn't write the incident anyway.
  if (reading.is_platform) return;

  const hit = evaluate(reading, history[reading.service] ?? []);
  if (!hit) return;

  const verdict = await shouldFire(reading.service, hit.type);

  if (verdict.fire) {
    const inc = await createIncident({
      service:  reading.service,
      type:     hit.type,
      severity: hit.severity,
      detail:   { ...hit.detail, message: hit.message, reading },
    });
    console.log(`[poller] ${inc.id} ${hit.type} on ${reading.service} — ${hit.message}`);
    return;
  }

  // Not firing. 'duplicate' and 'cooldown' are the normal quiet cases and
  // happen every tick — don't log them or the console becomes useless.

  if (verdict.reason === 'correlated') {
    await recordSuppressed(reading, hit, verdict.suppressedBy);
  }

  if (verdict.reason === 'breaker') {
    await recordBreaker(reading, hit);
  }
}

/**
 * Correlation: we still create the incident — so the CorrelationPanel can
 * show "2 alerts suppressed" — but it's born and immediately moved to
 * SUPPRESSED, pointing at the upstream cause. Once per root incident, not
 * once per tick.
 */
async function recordSuppressed(reading, hit, root) {
  const { rows } = await query(
    `SELECT id FROM incidents
      WHERE service = $1 AND type = $2 AND suppressed_by = $3
      LIMIT 1`,
    [reading.service, hit.type, root.id]
  );
  if (rows.length) return;

  const inc = await createIncident({
    service:  reading.service,
    type:     hit.type,
    severity: hit.severity,
    detail:   { ...hit.detail, message: hit.message },
  });
  await markSuppressedBy(inc.id, root.id, `${reading.service} depends on ${root.service}, which has open incident ${root.id}`);
  await transition(inc.id, 'SUPPRESSED', {
    actor: 'correlation',
    message: `Suppressed: symptom of ${root.id} (${root.service} ${root.type})`,
    detail: { root_incident: root.id },
  });
  console.log(`[poller] ${inc.id} suppressed — symptom of ${root.id}`);
}

/**
 * Circuit breaker: too many restarts this hour. Create the incident but send
 * it straight to ESCALATED so the driver never tries to fix it again.
 */
async function recordBreaker(reading, hit) {
  const inc = await createIncident({
    service:  reading.service,
    type:     hit.type,
    severity: hit.severity,
    detail:   { ...hit.detail, message: hit.message },
  });
  await transition(inc.id, 'ESCALATED', {
    actor: 'circuit-breaker',
    message: `Escalated: ${reading.service} has hit the restart limit for this hour`,
  });
  await audit('circuit-breaker', 'ESCALATE', { incident: inc.id, service: reading.service });
  console.log(`[poller] ${inc.id} escalated — circuit breaker open for ${reading.service}`);
}

// -----------------------------------------------------------------------------
// Auto-resolution
// -----------------------------------------------------------------------------

/**
 * Some incidents fix themselves before we do anything: a CPU burn ends, a
 * container someone stopped gets started again by hand. We must notice, and
 * we must NOT count it as an AI success — hence AUTO_RESOLVED, not RESOLVED.
 *
 * Only incidents that haven't started executing qualify. Once we've acted,
 * verification decides the outcome, not this function.
 */
async function autoResolve(readingsByService) {
  const open = await listOpenIncidents();
  for (const inc of open) {
    if (!['DETECTED', 'TRIAGING', 'AWAITING_APPROVAL'].includes(inc.status)) continue;

    const reading = readingsByService[inc.service];
    if (!reading) continue;
    if (!isRecovered(inc.type, reading)) continue;

    const ok = await transition(inc.id, 'AUTO_RESOLVED', {
      actor: 'monitor',
      message: `Recovered without intervention (${inc.type} condition cleared)`,
      detail: { reading },
    });
    if (ok) console.log(`[poller] ${inc.id} auto-resolved`);
  }
}

// -----------------------------------------------------------------------------
// The tick
// -----------------------------------------------------------------------------

async function tick() {
  // A slow tick (Docker hanging) must not overlap with the next one.
  if (ticking) return;
  ticking = true;
  tickCount++;

  try {
    const containers = await listOurContainers();

    const settled = await Promise.allSettled(containers.map(readContainer));
    const readings = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value) readings.push(r.value);
      else if (r.status === 'rejected') {
        console.warn(`[poller] read failed for ${containers[i].Names[0]}: ${r.reason.message}`);
      }
    });

    readings.forEach(remember);

    // Tell the browser before touching the DB, so a slow DB never delays the
    // dashboard. The metrics table is for charts-after-the-fact, not liveness.
    emitMetrics(readings, history);

    await persist(readings);

    const byService = Object.fromEntries(readings.map((r) => [r.service, r]));

    for (const r of readings) {
      try { await detect(r); }
      catch (err) { console.error(`[poller] detect failed for ${r.service}:`, err.message); }
    }

    await autoResolve(byService);

    // Housekeeping once a minute-ish: drop metrics older than the retention
    // window. Two hours at 3s × 4 services is ~10k rows — plenty for charts.
    if (tickCount % 20 === 0) {
      await query(
        `DELETE FROM metrics WHERE at < now() - ($1 || ' hours')::interval`,
        [String(METRICS_RETENTION_HOURS)]
      );
    }
  } catch (err) {
    console.error('[poller] tick failed:', err.message);
  } finally {
    ticking = false;
  }
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export function startPoller() {
  if (timer) return;
  console.log(`[poller] started, every ${POLL_INTERVAL_MS}ms`);
  tick();
  timer = setInterval(tick, POLL_INTERVAL_MS);
}

export function stopPoller() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Latest reading per service — used by the REST /api/services route. */
export function latestReadings() {
  return Object.values(history)
    .map((list) => list[list.length - 1])
    .filter(Boolean);
}

export function readingHistory() {
  return history;
}
