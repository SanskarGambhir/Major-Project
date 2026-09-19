// =============================================================================
// Small formatting helpers, defined ONCE.
//
// Every number on the dashboard gets a unit. "238 MB", not "238". Severity
// colours are defined here and nowhere else, so SEV1 is the same red on a
// card, a badge, and a timeline line.
// =============================================================================

export function bytes(n) {
  if (n == null || Number.isNaN(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function pct(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return `${Math.round(n)}%`;
}

/** "4m 12s", "38s", "2h 5m" */
export function duration(ms) {
  if (ms == null || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** "just now", "42s ago", "3m ago" */
export function ago(dateLike) {
  if (!dateLike) return '—';
  const diff = Date.now() - new Date(dateLike).getTime();
  if (diff < 5000) return 'just now';
  return `${duration(diff)} ago`;
}

export function time(dateLike) {
  if (!dateLike) return '—';
  return new Date(dateLike).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// -----------------------------------------------------------------------------
// Service health: one word derived from a reading, used everywhere
// -----------------------------------------------------------------------------

/** 'critical' | 'warning' | 'healthy' | 'starting' | 'unknown' */
export function serviceState(reading) {
  if (!reading) return 'unknown';
  if (reading.status !== 'running') return 'critical';
  if (reading.health === 'unhealthy') return 'critical';
  if (reading.health === 'starting') return 'starting';
  if (reading.cpu_pct >= 90 || reading.mem_pct >= 90) return 'warning';
  if (reading.cpu_pct >= 70 || reading.mem_pct >= 70) return 'warning';
  return 'healthy';
}

export const STATE_STYLES = {
  healthy:  { dot: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400', label: 'Healthy',  ring: 'border-border' },
  warning:  { dot: 'bg-amber-500',   text: 'text-amber-600 dark:text-amber-400',     label: 'Warning',  ring: 'border-amber-500/40' },
  critical: { dot: 'bg-red-500',     text: 'text-red-600 dark:text-red-400',         label: 'Critical', ring: 'border-red-500/50' },
  starting: { dot: 'bg-sky-500',     text: 'text-sky-600 dark:text-sky-400',         label: 'Starting', ring: 'border-border' },
  unknown:  { dot: 'bg-zinc-400',    text: 'text-muted-foreground',                  label: 'Unknown',  ring: 'border-border' },
};

// -----------------------------------------------------------------------------
// Severity and status
// -----------------------------------------------------------------------------

export const SEVERITY_STYLES = {
  SEV1: 'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30',
  SEV2: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
  SEV3: 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30',
};

export function severityClass(sev) {
  return SEVERITY_STYLES[sev] ?? 'bg-muted text-muted-foreground border-border';
}

export const STATUS_LABELS = {
  DETECTED:           'Detected',
  TRIAGING:           'Analysing',
  AWAITING_APPROVAL:  'Awaiting approval',
  EXECUTING:          'Executing',
  VERIFYING:          'Verifying',
  RESOLVED:           'Resolved',
  CLOSED:             'Closed',
  REMEDIATION_FAILED: 'Remediation failed',
  ESCALATED:          'Escalated',
  SUPPRESSED:         'Suppressed',
  AUTO_RESOLVED:      'Auto-resolved',
};

export function statusLabel(status) {
  return STATUS_LABELS[status] ?? status;
}

export function statusClass(status) {
  switch (status) {
    case 'RESOLVED': case 'CLOSED': case 'AUTO_RESOLVED':
      return 'text-emerald-600 dark:text-emerald-400';
    case 'REMEDIATION_FAILED': case 'ESCALATED':
      return 'text-red-600 dark:text-red-400';
    case 'AWAITING_APPROVAL':
      return 'text-amber-600 dark:text-amber-400';
    case 'SUPPRESSED':
      return 'text-muted-foreground';
    default:
      return 'text-sky-600 dark:text-sky-400';
  }
}

export const ACTIVE_STATUSES = [
  'DETECTED', 'TRIAGING', 'AWAITING_APPROVAL', 'EXECUTING', 'VERIFYING', 'REMEDIATION_FAILED',
];

export function isActive(incident) {
  return ACTIVE_STATUSES.includes(incident.status);
}

/** "CONTAINER_OOM_KILLED" → "Container OOM killed" */
export function typeLabel(type) {
  if (!type) return '';
  return type
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\boom\b/, 'OOM')
    .replace(/\bcpu\b/, 'CPU')
    .replace(/^./, (c) => c.toUpperCase());
}
