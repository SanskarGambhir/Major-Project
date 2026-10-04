// =============================================================================
// REMEDIATE — run one action and walk the incident through the states.
//
// This is the piece that connects three things that know nothing about each
// other: the executor (does Docker), verification (checks health), and the
// state machine (records what happened). Both the manual Restart button
// (Phase 3) and the AI workflow driver (Phase 4) call this same function, so
// a human-triggered fix and an AI-triggered fix leave identical evidence.
//
//   EXECUTING ──► VERIFYING ──► RESOLVED
//        │             │
//        └── denied ───┴── unhealthy ──► REMEDIATION_FAILED
//
// Runs to completion in the background — verification alone can take 30s,
// and nobody should hold an HTTP request open for that. Progress reaches the
// browser through socket events ('incidents' on every transition, 'action'
// on every executor/verifier step).
// =============================================================================

import { execute, isBusy } from '../actions/executor.js';
import { verify } from '../verification/verify.js';
import { transition } from '../incidents/transitions.js';
import { getIncident, audit } from '../incidents/store.js';
import { isValidAction } from '../actions/catalog.js';

/**
 * @param {object} p
 * @param {string} p.action        catalog name, e.g. 'RESTART_CONTAINER'
 * @param {string} p.target        container name
 * @param {string} [p.incidentId]  the incident this is for, if any
 * @param {string} p.requestedBy   'ai-auto', or an operator's name
 * @returns {{ ok: boolean, action?: object, verification?: object, error?: string }}
 */
export async function remediate({ action, target, incidentId = null, requestedBy }) {
  if (!isValidAction(action)) return { ok: false, error: `unknown action ${action}` };
  if (isBusy(target))         return { ok: false, error: `an action is already running on ${target}` };

  const who = { actor: requestedBy };

  // --- ESCALATE_TO_HUMAN: no Docker involved ---------------------------------
  if (action === 'ESCALATE_TO_HUMAN') {
    if (incidentId) {
      await transition(incidentId, 'ESCALATED', { ...who, message: `Escalated to a human by ${requestedBy}` });
      await audit(requestedBy, 'ESCALATE', { incident: incidentId });
    }
    return { ok: true };
  }

  // --- Claim the incident --------------------------------------------------
  // The guarded transition is our lock. If two operators click at once, one
  // of them gets null here and stops — exactly one restart happens.
  if (incidentId) {
    const claimed = await transition(incidentId, 'EXECUTING', {
      ...who,
      message: `${action} on ${target} requested by ${requestedBy}`,
      detail: { action, target },
    });
    if (!claimed) {
      const inc = await getIncident(incidentId);
      return { ok: false, error: `incident ${incidentId} is ${inc?.status ?? 'missing'}, not in a state that can execute` };
    }
  }

  // --- Execute ---------------------------------------------------------------
  const act = await execute({ action, target, incidentId, requestedBy });

  if (act.result === 'denied') {
    if (incidentId) {
      await transition(incidentId, 'REMEDIATION_FAILED', {
        actor: 'policy',
        message: `Refused: ${act.policy_reason}`,
        detail: { action, target, code: act.error },
      });
    }
    return { ok: false, action: act, error: act.policy_reason };
  }

  if (act.result !== 'success') {
    if (incidentId) {
      await transition(incidentId, 'REMEDIATION_FAILED', {
        actor: 'executor',
        message: `${action} on ${target} failed: ${act.error}`,
        detail: { action, target, action_id: act.id },
      });
    }
    return { ok: false, action: act, error: act.error };
  }

  if (incidentId) {
    await transition(incidentId, 'VERIFYING', {
      actor: 'executor',
      message: `${action} on ${target} executed — checking the service actually recovered`,
      detail: { action_id: act.id, started_at_before: act.started_at_before, started_at_after: act.started_at_after },
    });
  }

  // --- Verify ----------------------------------------------------------------
  const v = await verify(act);

  if (incidentId) {
    if (v.ok) {
      await transition(incidentId, 'RESOLVED', {
        actor: 'verifier',
        message: `Verified: ${target} healthy ${(v.recovery_ms / 1000).toFixed(1)}s after ${action}`,
        detail: { action_id: act.id, recovery_ms: v.recovery_ms, steps: v.steps },
      });
    } else {
      await transition(incidentId, 'REMEDIATION_FAILED', {
        actor: 'verifier',
        message: `Verification failed: ${v.reason}`,
        detail: { action_id: act.id, steps: v.steps },
      });
    }
  } else {
    // No incident to hang it on, but the outcome is still worth a console line.
    console.log(`[remediate] ${action} on ${target}: ${v.ok ? `verified in ${v.recovery_ms}ms` : `NOT verified — ${v.reason}`}`);
  }

  return { ok: v.ok, action: act, verification: v, error: v.ok ? undefined : v.reason };
}
