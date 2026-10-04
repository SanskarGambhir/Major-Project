// =============================================================================
// The workflow driver — moves incidents through the AI part of the lifecycle.
//
//   DETECTED ──► TRIAGING ──► AWAITING_APPROVAL ──► (human) ──► remediate()
//                    │                 │
//                    │                 └── expired ──► ESCALATED
//                    ├── auto-approved ──► remediate()   (EXECUTING → … → RESOLVED)
//                    └── ESCALATE_TO_HUMAN ──► ESCALATED
//
//   RESOLVED (no report yet) ──► POST /agent/rca ──► CLOSED
//
// A setInterval, like the poller. Every tick it looks for work in the
// database, never in memory — so a server restart mid-incident picks up
// exactly where it left off (server.md §7, last question).
//
// The AI is asked ONCE per incident, with everything it needs in the body
// (agentsfile.md §2: "never fetch its own evidence"). What it says back is a
// proposal. Whether it runs is decided here, by the catalog's thresholds, and
// executed by Phase 3's remediate() — the same path a human's click takes.
// =============================================================================

import { analyze, rca, health, fallbackAnalysis } from './agentClient.js';
import { remediate } from './remediate.js';
import { transition } from '../incidents/transitions.js';
import {
  findByStatus, findStale, findIncidentsNeedingRca, findExpiredApprovals,
  saveAnalysis, saveAgentRun, saveRca, setApprovalDeadline, setApprovedBy,
  getTimeline, listActionsFor, audit, logEvent,
} from '../incidents/store.js';
import { actionNames, needsApproval, getAction } from '../actions/catalog.js';
import { readingHistory } from '../monitoring/poller.js';
import { getCleanLogs, compactLogs } from '../docker/logs.js';
import { inspect } from '../docker/client.js';
import { queryAll } from '../db/pool.js';
import { emit } from '../realtime/socket.js';

const DRIVER_INTERVAL_MS   = Number(process.env.DRIVER_INTERVAL_MS ?? 2000);
const HEALTH_INTERVAL_MS   = Number(process.env.AGENT_HEALTH_INTERVAL_MS ?? 10000);
const APPROVAL_TTL_MINUTES = Number(process.env.APPROVAL_TTL_MINUTES ?? 5);
const AGENT_TIMEOUT_MS     = Number(process.env.AGENT_TIMEOUT_MS ?? 120000);
const LOG_TAIL             = 200;

// A TRIAGING row older than this has outlived any possible analysis — the
// server died mid-call, or the call threw before decide() ran. Escalate it
// rather than leave it stuck (nothing else ever re-queues TRIAGING).
const STALE_TRIAGING_S     = Math.ceil(AGENT_TIMEOUT_MS / 1000) + 60;

// RCA retries: a null from rca() might be a timeout or a transient 5xx, not
// a dead service. Try a few times with growing gaps before closing with a
// placeholder, so the real report isn't thrown away on the first hiccup.
const RCA_MAX_ATTEMPTS     = 3;
const rcaAttempts          = new Map();   // incident id → { n, nextAt }

// Incidents this process is working on right now. The database guard makes
// double-work harmless; this just stops us paying for it.
const inFlight = new Set();

let timer = null;
let healthTimer = null;
let ticking = false;
let lastProvider = null;

// -----------------------------------------------------------------------------
// Evidence — everything the AI is allowed to see, chosen here
// -----------------------------------------------------------------------------

async function collectEvidence(incident) {
  const service = incident.service;

  // Metrics: the poller's in-memory ring buffer (last 40 readings), or the
  // metrics table if the server was just restarted and the buffer is empty.
  let metrics_history = (readingHistory()[service] ?? []).map((r) => ({
    at: r.at, status: r.status, health: r.health,
    cpu_pct: r.cpu_pct, mem_used: r.mem_used, mem_limit: r.mem_limit, mem_pct: r.mem_pct,
    exit_code: r.exit_code ?? -1, oom_killed: Boolean(r.oom_killed), restart_count: r.restart_count ?? 0,
  }));
  if (metrics_history.length === 0) {
    const rows = await queryAll(
      `SELECT at, status, health, cpu_pct, mem_used, mem_limit, mem_pct, restart_count
         FROM metrics WHERE service = $1 AND at > now() - interval '5 minutes'
        ORDER BY at ASC LIMIT 100`,
      [service]
    );
    metrics_history = rows.map((r) => ({ ...r, at: new Date(r.at).getTime(), exit_code: -1, oom_killed: false }));
  }

  // Logs: demuxed and compacted by the server (plan §5, trap 3). Missing
  // logs are missing evidence, not a reason to skip the analysis.
  let logs = [];
  try { logs = compactLogs(await getCleanLogs(service, { tail: LOG_TAIL })); }
  catch (err) { console.warn(`[driver] logs unavailable for ${service}: ${err.message}`); }

  // Container state: the trimmed inspect. Exit code and OOMKilled are read
  // now, while the stopped container still exists.
  let container_info = {};
  let info = null;
  try { info = await inspect(service); }
  catch (err) { console.warn(`[driver] inspect failed for ${service}: ${err.message}`); }
  if (info) {
    container_info = {
      status:         info.State?.Status ?? '',
      memory_limit:   info.HostConfig?.Memory ?? 0,
      restart_policy: info.HostConfig?.RestartPolicy?.Name || 'no',
      exit_code:      info.State?.ExitCode ?? -1,
      oom_killed:     Boolean(info.State?.OOMKilled),
      started_at:     info.State?.StartedAt ?? '',
      finished_at:    info.State?.FinishedAt ?? '',
      image:          info.Config?.Image ?? '',
    };
  }

  // The detection rule stashed exit code / OOM in the first timeline entry.
  const first = (await getTimeline(incident.id))[0];
  const detail = first?.detail ?? {};

  return {
    incident_id: incident.id,
    service,
    type: incident.type,
    exit_code: detail.exit_code ?? container_info.exit_code ?? -1,
    oom_killed: Boolean(detail.oom_killed ?? container_info.oom_killed),
    metrics_history,
    logs,
    container_info,
    allowed_actions: actionNames(),          // generated from the catalog, never typed twice
    rule_suggested_severity: incident.severity ?? '',
    similar_past_incidents: [],              // Phase 6 fills this from ChromaDB
  };
}

// -----------------------------------------------------------------------------
// One incident: DETECTED → analysed → decided
// -----------------------------------------------------------------------------

function progress(incidentId, message, extra = {}) {
  emit('agent.progress', { incident_id: incidentId, at: new Date(), message, ...extra });
}

function runLine(run) {
  const tok = (run.prompt_tokens ?? 0) + (run.completion_tokens ?? 0);
  return `${run.model ?? run.provider} · ${tok.toLocaleString()} tok · ${((run.latency_ms ?? 0) / 1000).toFixed(1)}s`;
}

async function analyseIncident(incident) {
  // Claim it. If another tick (or a manual Restart) got there first, this
  // returns null and we walk away.
  const claimed = await transition(incident.id, 'TRIAGING', {
    actor: 'ai',
    message: 'AI analysis started — collecting evidence',
  });
  if (!claimed) return;
  progress(incident.id, 'AI analysis started');

  try {
    await analyseClaimed(incident);
  } catch (err) {
    // Whatever broke — evidence, DB, socket — the incident must not sit in
    // TRIAGING forever. ESCALATED is legal from TRIAGING; a human takes it.
    console.error(`[driver] ${incident.id} analysis failed:`, err);
    await transition(incident.id, 'ESCALATED', {
      actor: 'driver',
      message: `AI analysis failed (${err.message}) — escalated to a human`,
    }).catch((e) => console.error(`[driver] ${incident.id} could not escalate:`, e.message));
  }
}

async function analyseClaimed(incident) {
  const evidence = await collectEvidence(incident);
  const reading = evidence.metrics_history[evidence.metrics_history.length - 1] ?? null;

  let result = await analyze(evidence);
  if (!result) {
    result = fallbackAnalysis(incident, reading);
    await logEvent(incident.id, {
      actor: 'ai', message: 'AI service unreachable — using the server\'s own rules',
    });
  }
  setProvider(result.provider, modelFor(result));

  // Every attempt on record, in the shape the table expects.
  for (const run of result.runs ?? []) {
    await saveAgentRun(incident.id, run);
  }
  await saveAnalysis(incident.id, result);

  // The timeline lines the drawer shows — one per agent, with the cost.
  const byAgent = Object.fromEntries((result.runs ?? []).map((r) => [r.agent, r]));
  if (byAgent.triage) {
    await logEvent(incident.id, { actor: 'ai', message: `Triage: ${result.severity} · ${result.category}`, detail: { run: runLine(byAgent.triage), provider: byAgent.triage.provider } });
  }
  if (byAgent.investigate) {
    await logEvent(incident.id, { actor: 'ai', message: `Root cause: ${result.root_cause} (${Math.round(result.confidence * 100)}%)`, detail: { run: runLine(byAgent.investigate), provider: byAgent.investigate.provider, evidence: result.evidence } });
  }
  if (byAgent.mitigate) {
    await logEvent(incident.id, { actor: 'ai', message: `Proposes: ${result.action} on ${result.target} (risk ${result.risk})`, detail: { run: runLine(byAgent.mitigate), provider: byAgent.mitigate.provider, reasoning: result.reasoning } });
  }
  progress(incident.id, `Proposes ${result.action} on ${result.target}`, { provider: result.provider });

  await decide(incident, result);
}

/** The model that belongs to the OVERALL provider (the lowest rung any agent
 *  needed) — not whichever model triage happened to use. */
function modelFor(result) {
  const run = (result.runs ?? []).find((r) => r.provider === result.provider);
  return run?.model ?? '';
}

/**
 * The proposal is a WORD. Decide what to do with it:
 *   ESCALATE_TO_HUMAN                 → ESCALATED
 *   needs approval (catalog threshold, or risk not LOW) → AWAITING_APPROVAL + deadline
 *   otherwise                         → remediate() right now, as 'ai-auto'
 *
 * Confidence used for the threshold is the LOWER of "how sure about the
 * cause" and "how sure the action fixes it".
 */
async function decide(incident, result) {
  const action = result.action;
  const spec = getAction(action);
  const confidence = Math.min(Number(result.confidence ?? 0), Number(result.action_confidence ?? 0));

  if (!spec || action === 'ESCALATE_TO_HUMAN') {
    await transition(incident.id, 'ESCALATED', {
      actor: 'ai',
      message: spec ? `AI escalated to a human: ${result.reasoning}` : `AI proposed unknown action "${action}" — escalated`,
    });
    await audit('ai', 'ESCALATE', { incident: incident.id, action, reason: result.reasoning });
    return;
  }

  if (needsApproval(action, confidence) || spec.risk !== 'LOW') {
    const why = spec.risk !== 'LOW'
      ? `risk ${spec.risk} always needs a human`
      : `confidence ${confidence.toFixed(2)} is below the ${spec.autoApproveAt} auto-approve threshold`;
    const moved = await transition(incident.id, 'AWAITING_APPROVAL', {
      actor: 'ai',
      message: `${action} on ${result.target} proposed — approval required: ${why}`,
      detail: { action, target: result.target, risk: spec.risk, confidence, threshold: spec.autoApproveAt },
    });
    if (moved) await setApprovalDeadline(incident.id, APPROVAL_TTL_MINUTES);
    return;
  }

  await logEvent(incident.id, {
    actor: 'ai',
    message: `Auto-approved: risk LOW and confidence ${confidence.toFixed(2)} ≥ ${spec.autoApproveAt}`,
  });
  await audit('ai-auto', 'AUTO_APPROVE', { incident: incident.id, action, target: result.target, confidence });
  // remediate() claims the incident via transition(EXECUTING), legal from TRIAGING.
  const res = await remediate({ action, target: result.target, incidentId: incident.id, requestedBy: 'ai-auto' });

  // It can decline WITHOUT touching the incident — another action is already
  // running on that container. Don't leave TRIAGING: park it for a human,
  // with the deadline so the expiry sweep still applies.
  if (!res.ok && !res.action) {
    const moved = await transition(incident.id, 'AWAITING_APPROVAL', {
      actor: 'driver',
      message: `Auto-run could not start (${res.error}) — a human can approve once the target is free`,
      detail: { action, target: result.target, risk: spec.risk, confidence, threshold: spec.autoApproveAt },
    });
    if (moved) await setApprovalDeadline(incident.id, APPROVAL_TTL_MINUTES);
  }
}

// -----------------------------------------------------------------------------
// Approval — called by the routes, and by the deadline sweep
// -----------------------------------------------------------------------------

/** An operator said yes. Records who, then runs the proposal through remediate(). */
export async function approve(incident, user) {
  if (incident.status !== 'AWAITING_APPROVAL') {
    return { ok: false, error: `incident ${incident.id} is ${incident.status}, not AWAITING_APPROVAL` };
  }
  await setApprovedBy(incident.id, user);
  await audit(user, 'APPROVE', { incident: incident.id, action: incident.proposed_action, target: incident.target });
  const res = await remediate({
    action: incident.proposed_action,
    target: incident.target,
    incidentId: incident.id,
    requestedBy: user,
  });
  if (!res.ok && !res.action) {
    // Declined before anything ran (target busy). The route already said
    // 202, so the timeline is the only place the operator can learn why.
    // The incident stays AWAITING_APPROVAL; they can approve again.
    await logEvent(incident.id, {
      actor: 'driver',
      message: `Approval by ${user} could not start: ${res.error}. Still awaiting — approve again when the target is free.`,
    });
    progress(incident.id, `Could not start: ${res.error}`);
  }
  return res;
}

/** An operator said no. The incident goes to a human; nothing touches Docker. */
export async function reject(incident, user, reason = '') {
  const moved = await transition(incident.id, 'ESCALATED', {
    actor: user,
    message: `Proposal rejected by ${user}${reason ? `: ${reason}` : ''}`,
    detail: { action: incident.proposed_action, target: incident.target },
  });
  if (!moved) return { ok: false, error: `incident ${incident.id} is ${incident.status}, cannot reject` };
  await audit(user, 'REJECT', { incident: incident.id, reason });
  return { ok: true };
}

async function escalateStaleTriaging() {
  for (const inc of await findStale('TRIAGING', STALE_TRIAGING_S)) {
    if (inFlight.has(inc.id)) continue;   // genuinely still being analysed by us
    const moved = await transition(inc.id, 'ESCALATED', {
      actor: 'driver',
      message: `Stuck in TRIAGING for over ${STALE_TRIAGING_S}s (analysis lost, probably a server restart) — escalated`,
    });
    if (moved) console.log(`[driver] ${inc.id} stale TRIAGING → ESCALATED`);
  }
}

async function expireApprovals() {
  for (const inc of await findExpiredApprovals()) {
    const moved = await transition(inc.id, 'ESCALATED', {
      actor: 'driver',
      message: `Approval window expired after ${APPROVAL_TTL_MINUTES} minutes — escalated`,
    });
    if (moved) {
      await audit('driver', 'APPROVAL_EXPIRED', { incident: inc.id });
      console.log(`[driver] ${inc.id} approval expired → ESCALATED`);
    }
  }
}

// -----------------------------------------------------------------------------
// RCA — after RESOLVED, write the report and close
// -----------------------------------------------------------------------------

async function writeReport(incident) {
  const timeline = await getTimeline(incident.id);
  const actions = await listActionsFor(incident.id);

  const res = await rca({
    incident: {
      id: incident.id, service: incident.service, type: incident.type,
      severity: incident.severity ?? '', status: incident.status,
      root_cause: incident.root_cause ?? '', confidence: incident.confidence ?? 0,
      evidence: incident.evidence ?? [],
      proposed_action: incident.proposed_action ?? '', target: incident.target ?? '',
      risk: incident.risk ?? '',
      detected_at: incident.detected_at, resolved_at: incident.resolved_at,
    },
    timeline: timeline.map((e) => ({ at: e.at, status: e.status ?? '', actor: e.actor ?? '', message: e.message ?? '' })),
    actions: actions.map((a) => ({
      action_type: a.action_type, target: a.target, result: a.result, requested_by: a.requested_by,
      policy_reason: a.policy_reason, started_at_before: a.started_at_before, started_at_after: a.started_at_after,
      verified: a.verified,
    })),
    similar_past_incidents: [],
  });

  if (res) {
    rcaAttempts.delete(incident.id);
    for (const run of res.runs ?? []) await saveAgentRun(incident.id, run);
    await saveRca(incident.id, { report: res.report, recommendations: res.recommendations });
    setProvider(res.provider, res.runs?.[0]?.model);
    await transition(incident.id, 'CLOSED', {
      actor: 'ai',
      message: 'RCA report written',
      detail: { run: res.runs?.[0] ? runLine(res.runs[0]) : undefined, provider: res.provider },
    });
    return;
  }

  // Null = timeout, 5xx, or down. Retry with growing gaps (30 s, 60 s) before
  // giving up — a report lost to one slow call is a report lost for good,
  // because findIncidentsNeedingRca() never revisits a row with rca_report set.
  const state = rcaAttempts.get(incident.id) ?? { n: 0 };
  state.n += 1;
  if (state.n < RCA_MAX_ATTEMPTS) {
    state.nextAt = Date.now() + 30000 * state.n;
    rcaAttempts.set(incident.id, state);
    await logEvent(incident.id, { actor: 'driver', message: `RCA attempt ${state.n} failed — will retry` });
    return;
  }

  // Don't leave it hanging in RESOLVED forever. Close with an honest note;
  // the timeline is still there for a human to write it up.
  rcaAttempts.delete(incident.id);
  await saveRca(incident.id, {
    report: `RCA not generated: the AI service did not answer after ${RCA_MAX_ATTEMPTS} attempts. See the incident timeline for the record.`,
    recommendations: ['Write up this incident by hand from the timeline.'],
  });
  await transition(incident.id, 'CLOSED', { actor: 'driver', message: `Closed without an AI report (${RCA_MAX_ATTEMPTS} attempts failed)` });
}

// -----------------------------------------------------------------------------
// Provider pill
// -----------------------------------------------------------------------------

function setProvider(provider, model) {
  if (!provider) return;
  const next = { provider, model: model ?? '' };
  if (lastProvider?.provider !== next.provider || lastProvider?.model !== next.model) {
    lastProvider = next;
    emit('provider', { ...next, ok: provider !== 'node-rules', at: new Date() });
  }
}

async function pollHealth() {
  const h = await health();
  // The pill shows what WOULD answer right now. Once a request has run,
  // setProvider() has already reported what actually did.
  const provider = h.ok ? h.provider : 'node-rules';
  if (lastProvider?.provider !== provider || lastProvider?.model !== h.model) {
    lastProvider = { provider, model: h.model };
    emit('provider', { provider, model: h.model, ok: h.ok, cooling_down: h.cooling_down, at: new Date() });
    console.log(`[driver] agent service ${h.ok ? 'up' : 'DOWN'} — provider ${provider}${h.model ? ` (${h.model})` : ''}`);
  }
}

export function currentProvider() {
  return lastProvider ?? { provider: 'unknown', model: '' };
}

// -----------------------------------------------------------------------------
// The tick
// -----------------------------------------------------------------------------

async function withClaim(id, fn) {
  if (inFlight.has(id)) return;
  inFlight.add(id);
  try { await fn(); }
  catch (err) { console.error(`[driver] ${id} failed:`, err); }
  finally { inFlight.delete(id); }
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    // New incidents, one at a time in detection order. The Python service is
    // stateless and could handle these in parallel, but a laptop running
    // Ollama cannot — and in-order keeps the timeline readable.
    for (const inc of await findByStatus('DETECTED')) {
      await withClaim(inc.id, () => analyseIncident(inc));
    }

    await expireApprovals();
    await escalateStaleTriaging();

    for (const inc of await findIncidentsNeedingRca()) {
      const retry = rcaAttempts.get(inc.id);
      if (retry?.nextAt && Date.now() < retry.nextAt) continue;   // backing off
      await withClaim(inc.id, () => writeReport(inc));
    }
  } catch (err) {
    console.error('[driver] tick failed:', err.message);
  } finally {
    ticking = false;
  }
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export function startDriver() {
  if (timer) return;
  console.log(`[driver] started, every ${DRIVER_INTERVAL_MS}ms; agent health every ${HEALTH_INTERVAL_MS}ms`);
  pollHealth();
  tick();
  timer = setInterval(tick, DRIVER_INTERVAL_MS);
  healthTimer = setInterval(pollHealth, HEALTH_INTERVAL_MS);
}

export function stopDriver() {
  if (timer) clearInterval(timer);
  if (healthTimer) clearInterval(healthTimer);
  timer = healthTimer = null;
}
