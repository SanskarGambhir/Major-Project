// =============================================================================
// THE POLICY ENGINE — the last gate before anything touches Docker.
//
// Five checks, in order. The first one that fails wins, and the reason is
// returned in plain words so it can be shown on screen and stored forever in
// the actions table. A refusal is a security event, not an error.
//
//   1. Is this action in the catalog at all?
//   2. Does the target container exist?
//   3. Is the target PROTECTED (sre.platform=true)?      ← the critical one
//   4. Is the target actually one of ours (sre.demo=true)?
//   5. Does this action allow this target? (CLEAR_DEMO_CACHE only on demo-cache)
//   6. Circuit breaker — have we restarted this thing too often already?
//
// WHY WE ASK DOCKER FOR LABELS AT EXECUTION TIME
// ---------------------------------------------------------------------------
// We could keep a list of "safe names" in code. We don't, because names can
// be crafted to look safe: a container called "demo-api-2" isn't in our
// compose file, and a container called "sre-postgres" could be renamed. The
// label on the container is set by the compose file and cannot be influenced
// by the AI, by logs, or by a request body. So we inspect the container at
// the moment of the decision and read the labels off it. Nothing else counts.
//
// WHY THE PLATFORM CHECK COMES BEFORE THE DEMO CHECK
// ---------------------------------------------------------------------------
// A container carrying BOTH labels (misconfiguration, or malice) must be
// refused. Checking "is it protected?" first makes that the default outcome.
// =============================================================================

import { isValidAction, getAction } from './catalog.js';
import { inspect, LABEL_PLATFORM, LABEL_DEMO } from '../docker/client.js';
import { restartsInLastHour } from '../monitoring/shouldFire.js';

const MAX_RESTARTS_PER_HOUR = Number(process.env.MAX_RESTARTS_PER_HOUR ?? 3);

/**
 * Decide whether `action` may run against `target`.
 *
 * Never throws for a policy reason — a refusal is a normal result. Throws
 * only if Docker itself is unreachable, which the caller treats as "failed",
 * not "denied".
 *
 * @returns {{ allowed: true, labels: object }
 *         | { allowed: false, code: string, reason: string }}
 */
export async function checkPolicy(action, target) {
  // 1. Catalog
  if (!isValidAction(action)) {
    return deny('UNKNOWN_ACTION', `"${action}" is not in the action catalog`);
  }
  const spec = getAction(action);

  // ESCALATE_TO_HUMAN touches nothing, so there is nothing to protect.
  if (spec.dockerOp === null) {
    return { allowed: true, labels: {} };
  }

  // 2. Target exists
  const info = await inspect(target);
  if (!info) {
    return deny('NO_SUCH_CONTAINER', `container "${target}" does not exist`);
  }
  const labels = info.Config?.Labels ?? {};

  // 3. Protected — read from the live container, not from a name list
  if (labels[LABEL_PLATFORM] === 'true') {
    return deny(
      'PROTECTED_TARGET',
      `${target} is a platform container (${LABEL_PLATFORM}=true) and can never be a remediation target`
    );
  }

  // 4. Must be one of ours
  if (labels[LABEL_DEMO] !== 'true') {
    return deny(
      'NOT_A_MANAGED_TARGET',
      `${target} does not carry ${LABEL_DEMO}=true, so this system has no authority over it`
    );
  }

  // 5. Action-specific target restriction
  if (spec.onlyOn && !spec.onlyOn.includes(target)) {
    return deny(
      'WRONG_TARGET_FOR_ACTION',
      `${action} is only allowed on ${spec.onlyOn.join(', ')}, not ${target}`
    );
  }

  // 6. Circuit breaker
  if (action === 'RESTART_CONTAINER' || action === 'START_CONTAINER') {
    const n = await restartsInLastHour(target);
    if (n >= MAX_RESTARTS_PER_HOUR) {
      return deny(
        'CIRCUIT_BREAKER',
        `${target} has already been restarted ${n} times this hour (limit ${MAX_RESTARTS_PER_HOUR}); a human needs to look`
      );
    }
  }

  return { allowed: true, labels };
}

function deny(code, reason) {
  return { allowed: false, code, reason };
}
