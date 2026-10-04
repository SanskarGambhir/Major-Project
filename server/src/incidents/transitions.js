// =============================================================================
// THE GUARDED STATE MACHINE
//
// ONE RULE, NO EXCEPTIONS:
//   Nowhere else in this codebase may write `UPDATE incidents SET status`.
//   Every status change goes through transition() below.
//
// WHY THE GUARD IS IN THE SQL, NOT IN JAVASCRIPT
// ---------------------------------------------------------------------------
// The check lives in the WHERE clause:
//
//     UPDATE incidents SET status = $new
//      WHERE id = $id AND status = ANY($allowed_from)
//
// If the incident isn't in an expected previous state, zero rows come back and
// nothing changes. That gives us two guarantees for the price of one:
//
//   1. Illegal moves are impossible (DETECTED can never jump to RESOLVED).
//   2. RACES ARE IMPOSSIBLE. If two parts of the system try to move the same
//      incident at the same moment, Postgres serialises them and only the
//      first can match. The second gets zero rows.
//
// Guarantee 2 is why we need no locks, no idempotency keys, and no job queue.
// A double-clicked Approve button simply finds the incident already in
// EXECUTING, matches nothing, and does nothing.
// =============================================================================

import { query } from '../db/pool.js';
import { logEvent } from './store.js';

// For each destination status, the states it may legally be reached FROM.
export const ALLOWED = {
  // The workflow driver picks up a new incident.
  TRIAGING:           ['DETECTED', 'REMEDIATION_FAILED'],

  // The AI has proposed something. Either a human must approve it...
  AWAITING_APPROVAL:  ['TRIAGING'],
  // ...or confidence was high enough and low-risk enough to run on its own.
  // DETECTED and REMEDIATION_FAILED are the MANUAL paths: an operator clicks
  // Restart before the AI has looked, or retries after a failed attempt.
  EXECUTING:          ['DETECTED', 'TRIAGING', 'AWAITING_APPROVAL', 'REMEDIATION_FAILED'],

  VERIFYING:          ['EXECUTING'],
  RESOLVED:           ['VERIFYING'],

  // The action ran but didn't work, or the action itself errored.
  REMEDIATION_FAILED: ['EXECUTING', 'VERIFYING'],

  // Hand it to a person: the AI chose to, it failed, approval was rejected,
  // approval timed out, or the circuit breaker is open.
  ESCALATED:          ['DETECTED', 'TRIAGING', 'AWAITING_APPROVAL', 'REMEDIATION_FAILED'],

  // Correlation decided this is a symptom of another incident, not its own
  // problem. (Kill demo-db and demo-api's alerts land here.)
  SUPPRESSED:         ['DETECTED'],

  // The service recovered on its own before we acted. This genuinely happens,
  // and it MUST NOT be reported as an AI success — hence its own status.
  AUTO_RESOLVED:      ['DETECTED', 'TRIAGING', 'AWAITING_APPROVAL'],

  // Terminal. Set once the RCA report has been written.
  CLOSED:             ['RESOLVED', 'ESCALATED', 'SUPPRESSED', 'AUTO_RESOLVED'],
};

// Statuses where the incident is finished and needs no further work.
export const TERMINAL = ['CLOSED', 'SUPPRESSED', 'AUTO_RESOLVED'];

// Statuses that count as "still open" when checking for duplicates.
export const OPEN_STATUSES = [
  'DETECTED', 'TRIAGING', 'AWAITING_APPROVAL',
  'EXECUTING', 'VERIFYING', 'REMEDIATION_FAILED',
];

// -----------------------------------------------------------------------------
// Broadcast hook.
//
// Phase 2 plugs the Socket.IO broadcaster in here via setBroadcaster(), so this
// file never has to import the realtime layer. Until then it's a no-op.
// -----------------------------------------------------------------------------
let broadcast = () => {};
export function setBroadcaster(fn) {
  broadcast = fn;
}

/**
 * For writes that change an incident WITHOUT changing its status — creation,
 * the AI's analysis landing, the RCA report arriving. The browser needs to
 * hear about those too, and they don't pass through transition().
 */
export function notifyIncidentsChanged() {
  broadcast();
}

/**
 * Move an incident to a new status.
 *
 * @returns the updated row, or NULL if the move was illegal or lost a race.
 *          Callers must handle null — it is normal, not exceptional.
 */
export async function transition(incidentId, to, { actor = 'system', message, detail = null } = {}) {
  const allowedFrom = ALLOWED[to];
  if (!allowedFrom) {
    throw new Error(`transition(): unknown target status "${to}"`);
  }

  const { rows } = await query(
    `UPDATE incidents
        SET status      = $1,
            updated_at  = now(),
            resolved_at = CASE
                            WHEN $1 IN ('RESOLVED', 'AUTO_RESOLVED') THEN now()
                            ELSE resolved_at
                          END
      WHERE id = $2
        AND status = ANY($3::text[])
      RETURNING *`,
    [to, incidentId, allowedFrom]
  );

  // Zero rows means either an illegal move or a lost race. We treat both the
  // same way deliberately: the caller wanted a state that isn't available, and
  // the correct response in both cases is "do nothing".
  if (rows.length === 0) return null;

  await logEvent(incidentId, {
    status: to,
    actor,
    message: message ?? `Status changed to ${to}`,
    detail,
  });

  broadcast();
  return rows[0];
}

/** Would this move be legal? Useful for the UI and for tests. */
export function canTransition(from, to) {
  return (ALLOWED[to] ?? []).includes(from);
}

/** Every status the machine knows about. */
export function allStatuses() {
  return [...new Set(['DETECTED', ...Object.keys(ALLOWED), ...Object.values(ALLOWED).flat()])];
}
