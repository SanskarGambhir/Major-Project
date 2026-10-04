// Five numbers derived from the two hooks. No fetching of its own.

import { cn } from '../lib/utils';
import { serviceState, isActive } from '../lib/format';

function Stat({ label, value, tone }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className={cn('text-2xl font-semibold tabular-nums leading-none', tone)}>{value}</span>
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground truncate">{label}</span>
    </div>
  );
}

export function StatsRow({ services, metrics, incidents }) {
  const demo = services.filter((s) => !s.is_platform);
  const states = demo.map((s) => serviceState(metrics.current[s.container_name]));

  const healthy = states.filter((s) => s === 'healthy').length;
  const warning = states.filter((s) => s === 'warning').length;
  const critical = states.filter((s) => s === 'critical').length;
  const active = incidents.filter(isActive).length;

  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const resolvedToday = incidents.filter(
    (i) => i.resolved_at && new Date(i.resolved_at) >= todayStart
  ).length;

  return (
    <div className="grid grid-cols-3 sm:grid-cols-5 gap-4 rounded-xl border bg-card px-5 py-4">
      <Stat label="Services" value={demo.length} />
      <Stat label="Healthy"  value={healthy}  tone="text-emerald-600 dark:text-emerald-400" />
      <Stat label="Warning"  value={warning + critical} tone={warning + critical ? 'text-amber-600 dark:text-amber-400' : undefined} />
      <Stat label="Active"   value={active}   tone={active ? 'text-red-600 dark:text-red-400' : undefined} />
      <Stat label="Resolved today" value={resolvedToday} />
    </div>
  );
}
