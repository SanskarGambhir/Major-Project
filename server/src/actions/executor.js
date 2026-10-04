// =============================================================================
// THE EXECUTOR — the only file that changes a container AS A FIX.
//
// Everything else only READS Docker, with one deliberate exception:
// routes/simulate.js, which BREAKS containers for demos and is hard-limited
// to sre.demo=true. If you are looking for where a remediation actually
// happens, it is here and nowhere else. That makes the safety claim
// checkable: every Docker mutation in this file sits behind checkPolicy().
//
// WHAT ONE EXECUTION LOOKS LIKE
// ---------------------------------------------------------------------------
//   1. Write an `actions` row immediately — even if we end up refusing.
//      Refusals are worth recording; "we blocked a restart of sre-postgres"
//      is exactly the kind of line you want in an audit.
//   2. Ask the policy engine. If no: record the reason, tell the browser, stop.
//   3. Record the container's StartedAt BEFORE.
//   4. Do the Docker operation.
//   5. Record StartedAt AFTER.
//   6. Mark the row success or failed.
//
// Steps 3 and 5 are what let verification PROVE a restart happened rather
// than assume it. Docker returning 204 tells you the request was accepted,
// not that the process was replaced. A changed StartedAt is the proof.
// =============================================================================

import { docker, inspect, withTimeout } from '../docker/client.js';
import { getAction } from './catalog.js';
import { checkPolicy } from './policy.js';
import { query, queryOne } from '../db/pool.js';
import { audit } from '../incidents/store.js';
import { emit } from '../realtime/socket.js';

const DOCKER_OP_TIMEOUT_MS = 30000;   // `docker restart` waits up to 10s for a graceful stop

// Targets with an action currently running. A double-clicked Restart, or two
// operators clicking at once, must not restart the same container twice.
const inFlight = new Set();

export function isBusy(target) {
  return inFlight.has(target);
}

/**
 * Run one catalog action against one container.
 *
 * Always resolves to the finished `actions` row. `result` is one of
 * 'denied' | 'success' | 'failed'. Never throws for a policy refusal or a
 * Docker failure — those are results, and the caller decides what the
 * incident should do about them.
 */
export async function execute({ action, target, incidentId = null, requestedBy = 'system' }) {
  if (inFlight.has(target)) {
    return { result: 'failed', error: `an action is already running on ${target}`, action_type: action, target };
  }
  inFlight.add(target);

  // 1. Record the attempt first.
  const row = await queryOne(
    `INSERT INTO actions (incident_id, action_type, target, requested_by)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [incidentId, action, target, requestedBy]
  );

  try {
    // 2. Policy.
    const verdict = await checkPolicy(action, target);
    if (!verdict.allowed) {
      const denied = await finish(row.id, {
        policy_allowed: false, policy_reason: verdict.reason, result: 'denied', error: verdict.code,
      });
      await audit(requestedBy, 'ACTION_DENIED', { action, target, code: verdict.code, reason: verdict.reason, incident: incidentId });
      console.warn(`[executor] DENIED ${action} on ${target} — ${verdict.reason}`);

      emit('policy.denied', { action, target, code: verdict.code, reason: verdict.reason, requestedBy, incidentId });
      emit('action', { ...denied, stage: 'denied' });
      return denied;
    }

    await query('UPDATE actions SET policy_allowed = true WHERE id = $1', [row.id]);
    emit('action', { ...row, policy_allowed: true, stage: 'executing' });

    // 3. Evidence before.
    const before = await inspect(target);
    const startedBefore = before?.State?.StartedAt ?? null;

    // 4. The operation. This is the only place Docker is mutated.
    const spec = getAction(action);
    await performDockerOp(spec, target);

    // 5. Evidence after.
    const after = await inspect(target);
    const startedAfter = after?.State?.StartedAt ?? null;

    // 6. Done.
    const done = await finish(row.id, {
      policy_allowed: true, result: 'success',
      started_at_before: startedBefore, started_at_after: startedAfter,
    });
    await audit(requestedBy, 'ACTION_EXECUTED', { action, target, incident: incidentId, action_id: row.id });
    console.log(`[executor] ${action} on ${target} ok (StartedAt ${startedBefore} → ${startedAfter})`);
    emit('action', { ...done, stage: 'executed' });
    return done;

  } catch (err) {
    const failed = await finish(row.id, { result: 'failed', error: err.message });
    await audit(requestedBy, 'ACTION_FAILED', { action, target, incident: incidentId, error: err.message });
    console.error(`[executor] ${action} on ${target} FAILED — ${err.message}`);
    emit('action', { ...failed, stage: 'failed' });
    return failed;

  } finally {
    inFlight.delete(target);
  }
}

// -----------------------------------------------------------------------------
// The Docker calls. Three of them. Nothing here reads request input — the
// operation and the command both come from the catalog.
// -----------------------------------------------------------------------------
async function performDockerOp(spec, target) {
  const c = docker.getContainer(target);

  switch (spec.dockerOp) {
    case 'restart':
      // t = seconds to wait for a graceful stop before SIGKILL. A restart on
      // an already-stopped container simply starts it, which is what we want.
      await withTimeout(c.restart({ t: 5 }), DOCKER_OP_TIMEOUT_MS, `restart ${target}`);
      return;

    case 'start':
      try {
        await withTimeout(c.start(), DOCKER_OP_TIMEOUT_MS, `start ${target}`);
      } catch (err) {
        if (err.statusCode !== 304) throw err;   // 304 = already running; fine
      }
      return;

    case 'exec': {
      // The command array is the catalog's, fixed in our code.
      const exec = await c.exec({ Cmd: spec.execCommand, AttachStdout: true, AttachStderr: true });
      const stream = await withTimeout(exec.start({}), DOCKER_OP_TIMEOUT_MS, `exec ${target}`);
      await new Promise((resolve, reject) => {
        stream.on('end', resolve);
        stream.on('error', reject);
        stream.resume();
      });
      const info = await exec.inspect();
      if (info.ExitCode !== 0) throw new Error(`${spec.execCommand.join(' ')} exited with ${info.ExitCode}`);
      return;
    }

    default:
      throw new Error(`no docker operation for ${spec.dockerOp}`);
  }
}

async function finish(id, fields) {
  const cols = Object.keys(fields);
  const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
  return queryOne(
    `UPDATE actions SET ${sets}, finished_at = now() WHERE id = $1 RETURNING *`,
    [id, ...cols.map((c) => fields[c])]
  );
}

/** Update the verification columns once verify.js has an answer. */
export async function recordVerification(id, { verified, verification }) {
  return queryOne(
    `UPDATE actions SET verified = $2, verification = $3 WHERE id = $1 RETURNING *`,
    [id, verified, JSON.stringify(verification)]
  );
}
