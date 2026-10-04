// One incident in the right-hand panel. Clicking it opens the drawer (Phase 4).

import { useEffect, useState } from 'react';
import { Card } from './ui/card';
import { WorkflowStages } from './WorkflowStages';
import { cn } from '../lib/utils';
import { ago, severityClass, statusLabel, statusClass, typeLabel, isActive } from '../lib/format';

// Re-render every 10s so "42s ago" keeps moving without a socket event.
function useTicker(ms = 10000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

export function IncidentCard({ incident, onClick }) {
  useTicker();
  const active = isActive(incident);

  return (
    <Card
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={(e) => { if (onClick && (e.key === 'Enter' || e.key === ' ')) onClick(); }}
      className={cn(
        'gap-2.5 py-3.5 px-4 transition-colors duration-500',
        onClick && 'cursor-pointer hover:bg-accent/40',
        active && incident.severity === 'SEV1' && 'border-red-500/50',
        !active && 'opacity-80'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-medium">{incident.id}</span>
            <span className={cn('rounded border px-1.5 py-0.5 text-[10px] font-semibold', severityClass(incident.severity))}>
              {incident.severity ?? '—'}
            </span>
          </div>
          <div className="text-sm truncate">
            <span className="font-medium">{incident.service}</span>
            <span className="text-muted-foreground"> · {typeLabel(incident.type)}</span>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className={cn('text-xs font-medium', statusClass(incident.status))}>
            {statusLabel(incident.status)}
          </div>
          <div className="text-[11px] text-muted-foreground">{ago(incident.detected_at)}</div>
        </div>
      </div>

      <WorkflowStages status={incident.status} />

      {incident.root_cause && (
        <div className="text-xs text-muted-foreground line-clamp-2">{incident.root_cause}</div>
      )}
    </Card>
  );
}
