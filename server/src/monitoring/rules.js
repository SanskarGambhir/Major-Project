// =============================================================================
// Detection rules — "when does a reading become a problem?"
//
// Each rule looks at ONE service's current reading (plus its recent history
// for the sustained checks) and returns either null or a candidate incident:
//
//     { type, severity, message, detail }
//
// The rules decide what LOOKS wrong. They do not decide whether to create an
// incident — that's shouldFire()'s job (duplicates, cooldown, correlation).
// Keeping "is it bad?" separate from "should we act?" is what lets you tune
// thresholds without touching suppression logic, and vice versa.
//
// TWO KINDS OF RULE
// ---------------------------------------------------------------------------
// INSTANT rules fire on one reading. A container that has exited is exited;
// there's nothing to wait for.
//
// SUSTAINED rules need the condition to hold for SUSTAIN_WINDOW_MS. A CPU
// spike lasting two seconds is normal (garbage collection, a big request).
// One lasting thirty seconds is a problem. Without the window you would page
// someone every time the JIT warmed up.
// =============================================================================

const SUSTAIN_WINDOW_MS = Number(process.env.SUSTAIN_WINDOW_MS ?? 30000);

export const THRESHOLDS = {
  CPU_PCT: 90,
  MEM_PCT: 90,
};

// The incident types this system knows how to detect. Also referenced by the
// UI for colours/labels, and by the AI prompts as the vocabulary.
export const INCIDENT_TYPES = {
  CONTAINER_OOM_KILLED: 'CONTAINER_OOM_KILLED',
  CONTAINER_EXITED:     'CONTAINER_EXITED',
  CONTAINER_UNHEALTHY:  'CONTAINER_UNHEALTHY',
  HIGH_CPU:             'HIGH_CPU',
  HIGH_MEMORY:          'HIGH_MEMORY',
};

// -----------------------------------------------------------------------------
// Instant rules
// -----------------------------------------------------------------------------

function ruleExited(reading) {
  if (reading.status !== 'exited' && reading.status !== 'dead') return null;

  // OOM is its own type because the fix and the story are different: a
  // container that was killed by the kernel for eating memory needs a
  // different root-cause than one whose process simply crashed.
  if (reading.oom_killed) {
    return {
      type: INCIDENT_TYPES.CONTAINER_OOM_KILLED,
      severity: 'SEV1',
      message: `Container killed by the kernel (exit ${reading.exit_code}, OOMKilled)`,
      detail: { exit_code: reading.exit_code, oom_killed: true, finished_at: reading.finished_at },
    };
  }

  return {
    type: INCIDENT_TYPES.CONTAINER_EXITED,
    severity: reading.exit_code === 0 ? 'SEV2' : 'SEV1',
    message: `Container exited with code ${reading.exit_code}`,
    detail: { exit_code: reading.exit_code, oom_killed: false, finished_at: reading.finished_at },
  };
}

function ruleUnhealthy(reading) {
  if (reading.status !== 'running') return null;
  if (reading.health !== 'unhealthy') return null;
  return {
    type: INCIDENT_TYPES.CONTAINER_UNHEALTHY,
    severity: 'SEV2',
    message: 'Docker health check is failing',
    detail: { health: reading.health },
  };
}

// -----------------------------------------------------------------------------
// Sustained rules
// -----------------------------------------------------------------------------

/**
 * True if `pick(reading)` was over `threshold` for EVERY reading in the last
 * SUSTAIN_WINDOW_MS. `history` is newest-last, as the poller keeps it.
 */
function sustainedOver(history, pick, threshold) {
  if (history.length === 0) return false;

  const now = Date.now();
  const recent = history.filter((r) => now - r.at <= SUSTAIN_WINDOW_MS);

  // We need to have been watching long enough to fill the window, otherwise
  // a container that has been up for 3 seconds with 95% CPU (normal at boot)
  // would fire immediately.
  const oldest = recent[0];
  if (!oldest || now - oldest.at < SUSTAIN_WINDOW_MS * 0.8) return false;

  return recent.every((r) => pick(r) >= threshold);
}

function ruleHighCpu(reading, history) {
  if (reading.status !== 'running') return null;
  if (!sustainedOver(history, (r) => r.cpu_pct, THRESHOLDS.CPU_PCT)) return null;
  return {
    type: INCIDENT_TYPES.HIGH_CPU,
    severity: 'SEV2',
    message: `CPU above ${THRESHOLDS.CPU_PCT}% for ${SUSTAIN_WINDOW_MS / 1000}s (now ${reading.cpu_pct}%)`,
    detail: { cpu_pct: reading.cpu_pct, window_ms: SUSTAIN_WINDOW_MS },
  };
}

function ruleHighMemory(reading, history) {
  if (reading.status !== 'running') return null;
  if (!sustainedOver(history, (r) => r.mem_pct, THRESHOLDS.MEM_PCT)) return null;
  return {
    type: INCIDENT_TYPES.HIGH_MEMORY,
    severity: 'SEV2',
    message: `Memory above ${THRESHOLDS.MEM_PCT}% for ${SUSTAIN_WINDOW_MS / 1000}s (now ${reading.mem_pct}%)`,
    detail: { mem_pct: reading.mem_pct, mem_used: reading.mem_used, mem_limit: reading.mem_limit },
  };
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

// Order matters: the first match wins, and the most serious condition should
// win. An exited container has high nothing — check that first.
const RULES = [ruleExited, ruleUnhealthy, ruleHighMemory, ruleHighCpu];

/**
 * Evaluate every rule against one service.
 * @returns the first matching candidate, or null if all is well.
 */
export function evaluate(reading, history = []) {
  for (const rule of RULES) {
    const hit = rule(reading, history);
    if (hit) return hit;
  }
  return null;
}

/**
 * The opposite question: does the CURRENT reading show the incident's
 * condition has gone away? Used to auto-resolve incidents the system never
 * acted on (the CPU burn finished on its own, the container came back).
 */
export function isRecovered(type, reading) {
  switch (type) {
    case INCIDENT_TYPES.CONTAINER_OOM_KILLED:
    case INCIDENT_TYPES.CONTAINER_EXITED:
      return reading.status === 'running' && reading.health !== 'unhealthy';
    case INCIDENT_TYPES.CONTAINER_UNHEALTHY:
      return reading.status === 'running' && reading.health === 'healthy';
    case INCIDENT_TYPES.HIGH_CPU:
      return reading.status === 'running' && reading.cpu_pct < THRESHOLDS.CPU_PCT * 0.7;
    case INCIDENT_TYPES.HIGH_MEMORY:
      return reading.status === 'running' && reading.mem_pct < THRESHOLDS.MEM_PCT * 0.7;
    default:
      return false;
  }
}
