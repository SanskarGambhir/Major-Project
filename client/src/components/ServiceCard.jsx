// One monitored container: name, state, CPU, memory, uptime, sparkline.
// The Restart button is added in Phase 3.

import { Card } from './ui/card';
import { Sparkline } from './Sparkline';
import { cn } from '../lib/utils';
import { bytes, pct, duration, serviceState, STATE_STYLES } from '../lib/format';

function Meter({ label, value, sub, hot }) {
  const width = Math.min(Math.max(value ?? 0, 0), 100);
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums">
          <span className={cn('font-medium', hot && 'text-red-600 dark:text-red-400')}>{pct(value)}</span>
          {sub && <span className="text-muted-foreground ml-1">{sub}</span>}
        </span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
        <div
          className={cn(
            'h-full rounded-full transition-[width,background-color] duration-500',
            width >= 90 ? 'bg-red-500' : width >= 70 ? 'bg-amber-500' : 'bg-emerald-500'
          )}
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}

export function ServiceCard({ service, reading, history }) {
  const state = serviceState(reading);
  const style = STATE_STYLES[state];
  const name  = service.display_name || service.container_name;

  const uptime = reading?.status === 'running' && reading.started_at
    ? duration(Date.now() - new Date(reading.started_at).getTime())
    : null;

  const statusLine = (() => {
    if (!reading) return 'No data yet';
    if (reading.status === 'exited') {
      return reading.oom_killed
        ? `Killed by kernel · exit ${reading.exit_code} · OOM`
        : `Exited · code ${reading.exit_code}`;
    }
    if (reading.status !== 'running') return reading.status;
    if (reading.health === 'unhealthy') return 'Health check failing';
    if (reading.health === 'starting') return 'Starting up';
    return uptime ? `Up ${uptime}` : 'Running';
  })();

  return (
    <Card className={cn('gap-3 py-4 px-4 transition-colors duration-500', style.ring)}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium truncate">{name}</div>
          <div className="text-xs text-muted-foreground truncate">{statusLine}</div>
        </div>
        <div className={cn('flex items-center gap-1.5 text-xs font-medium shrink-0', style.text)}>
          <span className={cn('size-2 rounded-full', style.dot, state === 'critical' && 'animate-pulse')} />
          {style.label}
        </div>
      </div>

      <Meter label="CPU" value={reading?.cpu_pct} hot={reading?.cpu_pct >= 90} />
      <Meter
        label="Memory"
        value={reading?.mem_pct}
        sub={reading?.mem_limit ? `${bytes(reading.mem_used)} / ${bytes(reading.mem_limit)}` : null}
        hot={reading?.mem_pct >= 90}
      />

      <div className={cn('mt-1', state === 'critical' ? 'text-red-500' : state === 'warning' ? 'text-amber-500' : 'text-emerald-500')}>
        <Sparkline data={history} dataKey="mem_pct" />
      </div>
    </Card>
  );
}
