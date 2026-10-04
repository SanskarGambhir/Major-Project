// =============================================================================
// Agent client — the only code that talks to the Python service.
//
// Two calls per incident (agentsfile.md §6), plus a health poll:
//
//   POST /agent/analyze   evidence  → { severity, root_cause, action, ..., runs[] }
//   POST /agent/rca       timeline  → { report, recommendations[], runs[] }
//   GET  /health                    → { provider, model, cooling_down }
//
// Every request carries the shared secret. Every call has a hard timeout.
// Every failure returns NULL rather than throwing — the driver then uses
// fallbackAnalysis() below, which is Node's own copy of the rules rung.
//
// "Never be required for the system to work." If Python is down, or wifi is
// out, the incident still gets triaged and still gets a proposal. It's just a
// duller one, and the dashboard says so.
// =============================================================================

const AGENT_URL        = (process.env.AGENT_URL ?? 'http://localhost:8000').replace(/\/$/, '');
const AGENT_SECRET     = process.env.AGENT_SECRET ?? '';
// Must be LONGER than the Python side's REQUEST_BUDGET_SECONDS (default 90 s):
// Python fits its LLM calls inside that budget and falls to rules for
// whatever doesn't fit, so a reply always arrives before we give up here.
const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS ?? 120000);

async function call(method, path, body, timeoutMs = AGENT_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${AGENT_URL}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-agent-secret': AGENT_SECRET,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 200)}` : ''}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the AI what happened. Resolves to the analysis, or null if the service
 * is unreachable, slow, or refused us — the reason is logged, never thrown.
 */
export async function analyze(payload) {
  try {
    return await call('POST', '/agent/analyze', payload);
  } catch (err) {
    console.warn(`[agent] analyze failed for ${payload.incident_id}: ${err.name === 'AbortError' ? `timeout after ${AGENT_TIMEOUT_MS}ms` : err.message}`);
    return null;
  }
}

/** Ask the AI to write the report. Same contract: the report, or null. */
export async function rca(payload) {
  try {
    return await call('POST', '/agent/rca', payload);
  } catch (err) {
    console.warn(`[agent] rca failed for ${payload.incident?.id}: ${err.name === 'AbortError' ? `timeout after ${AGENT_TIMEOUT_MS}ms` : err.message}`);
    return null;
  }
}

/**
 * Is the Python service up, and which rung would answer?
 * @returns {{ ok: boolean, provider: string, model: string, cooling_down: object }}
 */
export async function health() {
  try {
    const h = await call('GET', '/health', undefined, 3000);
    return { ok: true, provider: h.provider, model: h.model, cooling_down: h.cooling_down ?? {} };
  } catch {
    return { ok: false, provider: 'node-rules', model: 'rules', cooling_down: {} };
  }
}

// -----------------------------------------------------------------------------
// Rung 4: Node's own rules. Used only when Python could not be reached at all.
//
// Deliberately conservative — confidence 0.5 means nothing here ever
// auto-approves. A human sees every proposal this function makes.
// -----------------------------------------------------------------------------

export function fallbackAnalysis(incident, reading = null) {
  const exited = ['exited', 'dead'].includes(reading?.status) ||
                 ['CONTAINER_OOM_KILLED', 'CONTAINER_EXITED'].includes(incident.type);

  let severity = incident.severity ?? 'SEV3';
  let category = 'UNKNOWN';
  let root_cause;
  let action;

  switch (incident.type) {
    case 'CONTAINER_OOM_KILLED':
      category = 'RESOURCE_EXHAUSTION';
      root_cause = `${incident.service} exhausted its container memory limit and was killed by the kernel OOM-killer.`;
      action = 'RESTART_CONTAINER';
      break;
    case 'CONTAINER_EXITED':
      category = 'SERVICE_DOWN';
      root_cause = `${incident.service}'s main process exited (exit code ${reading?.exit_code ?? 'unknown'}).`;
      action = reading?.exit_code === 0 ? 'START_CONTAINER' : 'RESTART_CONTAINER';
      break;
    case 'CONTAINER_UNHEALTHY':
      category = 'HEALTH_CHECK_FAILING';
      root_cause = `${incident.service} is running but its health check is failing.`;
      action = 'RESTART_CONTAINER';
      break;
    case 'HIGH_MEMORY':
      category = 'RESOURCE_EXHAUSTION';
      root_cause = `${incident.service} has been above the memory threshold for the sustained window.`;
      action = 'RESTART_CONTAINER';
      break;
    case 'HIGH_CPU':
      category = 'CPU_SATURATION';
      root_cause = `${incident.service} has been CPU-saturated for the sustained window.`;
      action = 'RESTART_CONTAINER';
      break;
    default:
      root_cause = `No rule covers incident type ${incident.type}.`;
      action = 'ESCALATE_TO_HUMAN';
  }
  if (exited && !severity) severity = 'SEV1';

  const risk = action === 'ESCALATE_TO_HUMAN' ? 'NONE' : 'LOW';
  const reasoning = 'Node rules: the AI service was unreachable, so this proposal comes from fixed rules and needs a human.';

  return {
    incident_id: incident.id,
    severity, category,
    triage_reasoning: 'Node rules: severity taken from the detection rule.',
    root_cause,
    confidence: 0.5,
    evidence: ['The AI service was unreachable; no log analysis was performed.'],
    action, target: incident.service, risk,
    action_confidence: 0.5,
    reasoning,
    provider: 'node-rules',
    runs: [{
      agent: 'triage', provider: 'node-rules', model: 'rules', latency_ms: 0,
      prompt_tokens: 0, completion_tokens: 0,
      output: { severity, category, root_cause, action, target: incident.service, risk },
      raw: '', ok: true, error: 'agents service unreachable',
    }],
  };
}
