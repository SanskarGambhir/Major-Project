// =============================================================================
// VERIFICATION — "did the fix actually work?"
//
// Docker saying "restarted" means the request was accepted. It does not mean
// the app inside is answering. A container reports `running` instantly; the
// Node process inside needs several more seconds to bind its port. Mark the
// incident resolved on `running` and you will regularly declare victory over
// a service that's still down.
//
// Three checks, in order:
//
//   1. PROOF     StartedAt changed. If it didn't, the restart never happened,
//                whatever Docker's status code said. (Skipped for exec ops —
//                flushing a cache doesn't restart anything.)
//   2. HEALTH    Poll the service's own /health URL with growing gaps —
//                2s, 3s, 5s, 8s, 12s — up to ~30s. First 200 wins.
//                Falls back to Docker's HEALTHCHECK status if there's no URL.
//   3. SETTLED   Wait a few seconds, then confirm CPU and memory are back
//                under the alert thresholds. A restart that lands straight
//                back at 95% memory has not fixed anything.
//
// The result is written into actions.verification as JSON, so the RCA agent
// can quote "health restored after 7.2s" rather than "it was restarted".
// =============================================================================

import { inspect } from '../docker/client.js';
import { getStats } from '../docker/stats.js';
import { getService } from '../incidents/store.js';
import { THRESHOLDS } from '../monitoring/rules.js';
import { recordVerification } from '../actions/executor.js';
import { emit } from '../realtime/socket.js';

const HEALTH_GAPS_MS  = [2000, 3000, 5000, 8000, 12000];   // ≈30s ceiling
const SETTLE_WAIT_MS  = Number(process.env.VERIFY_SETTLE_MS ?? 6000);
const HEALTH_TIMEOUT  = 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} actionRow   the finished `actions` row from the executor
 * @returns {{ ok: boolean, recovery_ms: number|null, steps: object[], reason?: string }}
 */
export async function verify(actionRow) {
  const { id, target, action_type, started_at_before } = actionRow;
  const t0 = Date.now();
  const steps = [];
  const note = (step, ok, detail) => {
    steps.push({ step, ok, at_ms: Date.now() - t0, ...detail });
    emit('action', { ...actionRow, stage: 'verifying', verification: { steps } });
  };

  const isExec = action_type === 'CLEAR_DEMO_CACHE';

  // --- 1. Proof the restart happened ---------------------------------------
  if (!isExec) {
    const info = await inspect(target);
    const after = info?.State?.StartedAt ?? null;
    const changed = Boolean(after) && after !== started_at_before;
    note('started_at_changed', changed, { before: started_at_before, after });
    if (!changed) {
      return fail(id, steps, 'container StartedAt did not change — the restart did not happen');
    }
    if (!info.State.Running) {
      return fail(id, steps, `container is ${info.State.Status} after the action`);
    }
  }

  // --- 2. Health -------------------------------------------------------------
  const service = await getService(target);
  let healthy = false;
  let healthAt = null;

  for (const gap of HEALTH_GAPS_MS) {
    await sleep(gap);
    const result = service?.health_url
      ? await httpHealthy(service.health_url)
      : await dockerHealthy(target);
    note('health', result.ok, { via: result.via, detail: result.detail });
    if (result.ok) { healthy = true; healthAt = Date.now() - t0; break; }
  }
  if (!healthy) {
    return fail(id, steps, `health did not recover within ${HEALTH_GAPS_MS.reduce((a, b) => a + b) / 1000}s`);
  }

  // --- 3. Resources settled --------------------------------------------------
  await sleep(SETTLE_WAIT_MS);
  let settled = true;
  let stats = null;
  try {
    stats = await getStats(target);
    settled = stats.cpu_pct < THRESHOLDS.CPU_PCT && stats.pct < THRESHOLDS.MEM_PCT;
    note('resources_settled', settled, { cpu_pct: stats.cpu_pct, mem_pct: stats.pct });
  } catch (err) {
    // Stats failing isn't proof of a problem; health already passed.
    note('resources_settled', true, { skipped: err.message });
  }
  if (!settled) {
    return fail(id, steps, `service is healthy but still under pressure (cpu ${stats.cpu_pct}%, mem ${stats.pct}%)`);
  }

  const result = { ok: true, recovery_ms: healthAt, steps };
  await recordVerification(id, { verified: true, verification: result });
  emit('action', { ...actionRow, stage: 'verified', verified: true, verification: result });
  return result;
}

async function fail(id, steps, reason) {
  const result = { ok: false, recovery_ms: null, steps, reason };
  const row = await recordVerification(id, { verified: false, verification: result });
  // The action itself succeeded; the service just didn't come back. The
  // browser still needs a finishing event or its button never re-enables.
  emit('action', { ...row, stage: 'failed', error: reason });
  return result;
}

// -----------------------------------------------------------------------------
// The two ways of asking "are you alive?"
// -----------------------------------------------------------------------------

async function httpHealthy(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(HEALTH_TIMEOUT) });
    return { ok: res.ok, via: 'http', detail: `${url} → ${res.status}` };
  } catch (err) {
    return { ok: false, via: 'http', detail: `${url} → ${err.cause?.code ?? err.name}` };
  }
}

async function dockerHealthy(target) {
  const info = await inspect(target);
  const status = info?.State?.Health?.Status;
  if (status) return { ok: status === 'healthy', via: 'docker-healthcheck', detail: status };
  // No HEALTHCHECK defined: the best we can say is "the process is up".
  const running = Boolean(info?.State?.Running);
  return { ok: running, via: 'docker-running', detail: info?.State?.Status };
}
