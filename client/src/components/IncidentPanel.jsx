// The right column. Active incidents on top, then a short "recent" list.
// The empty state is a deliberate tick + sentence, not a blank panel — a
// blank panel in a demo reads as "broken", a tick reads as "healthy".

import { CheckCircle2 } from 'lucide-react';
import { IncidentCard } from './IncidentCard';
import { Card } from './ui/card';
import { isActive } from '../lib/format';

function Skeleton() {
  return (
    <Card className="gap-3 py-4 px-4 animate-pulse">
      <div className="h-4 w-28 rounded bg-muted" />
      <div className="h-3 w-40 rounded bg-muted" />
      <div className="h-2.5 w-full rounded bg-muted" />
    </Card>
  );
}

export function IncidentPanel({ incidents, loaded, onSelect }) {
  const active = incidents.filter(isActive);
  const recent = incidents.filter((i) => !isActive(i)).slice(0, 8);

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Active incidents
        </h2>
        {active.length > 0 && (
          <span className="text-xs font-medium text-red-600 dark:text-red-400">{active.length} open</span>
        )}
      </div>

      {!loaded && <Skeleton />}

      {loaded && active.length === 0 && (
        <Card className="items-center gap-2 py-8 px-4 text-center border-dashed">
          <CheckCircle2 className="size-6 text-emerald-500" />
          <div className="text-sm font-medium">All services healthy</div>
          <div className="text-xs text-muted-foreground">No active incidents.</div>
        </Card>
      )}

      <div className="space-y-2">
        {active.map((inc) => (
          <IncidentCard key={inc.id} incident={inc} onClick={onSelect ? () => onSelect(inc) : undefined} />
        ))}
      </div>

      {recent.length > 0 && (
        <div className="space-y-2 pt-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Recent</h3>
          {recent.map((inc) => (
            <IncidentCard key={inc.id} incident={inc} onClick={onSelect ? () => onSelect(inc) : undefined} />
          ))}
        </div>
      )}
    </section>
  );
}
