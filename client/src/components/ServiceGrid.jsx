// The left column: one ServiceCard per demo service, then the protected
// platform container underneath, greyed out and locked.
//
// SHOW THE PROTECTED ONE, DON'T HIDE IT. Visible protection demonstrates the
// safety model; an absent container just looks absent.

import { Lock } from 'lucide-react';
import { ServiceCard, RestartButton } from './ServiceCard';
import { Card } from './ui/card';
import { cn } from '../lib/utils';
import { serviceState, STATE_STYLES, pct, isActive } from '../lib/format';

function SkeletonCard() {
  return (
    <Card className="gap-3 py-4 px-4 animate-pulse">
      <div className="h-4 w-24 rounded bg-muted" />
      <div className="h-3 w-32 rounded bg-muted" />
      <div className="h-1.5 w-full rounded bg-muted" />
      <div className="h-1.5 w-full rounded bg-muted" />
      <div className="h-9 w-full rounded bg-muted" />
    </Card>
  );
}

// The Restart button is HERE TOO, on purpose. Letting someone click it and
// watch the policy engine refuse — red toast, reason on screen — proves the
// safety model far better than hiding the button would.
function ProtectedCard({ service, reading, busy, onRun }) {
  const state = serviceState(reading);
  const style = STATE_STYLES[state];
  return (
    <Card className="gap-2 py-3 px-4 bg-muted/40 border-dashed">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Lock className="size-3.5 text-muted-foreground shrink-0" />
          <span className="font-medium text-sm truncate">{service.display_name || service.container_name}</span>
          <span className="text-[10px] uppercase tracking-wide rounded border px-1.5 py-0.5 text-muted-foreground">
            platform
          </span>
        </div>
        <div className={cn('flex items-center gap-1.5 text-xs font-medium shrink-0', style.text)}>
          <span className={cn('size-2 rounded-full', style.dot)} />
          {style.label}
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>Cannot be modified by automated remediation.</span>
        <div className="flex items-center gap-3 shrink-0">
          {reading && (
            <span className="tabular-nums">CPU {pct(reading.cpu_pct)} · Mem {pct(reading.mem_pct)}</span>
          )}
          <RestartButton target={service.container_name} busy={busy} onRun={onRun} variant="ghost" className="h-7 text-xs" />
        </div>
      </div>
    </Card>
  );
}

export function ServiceGrid({ services, metrics, incidents = [], loaded, busy, onRun }) {
  const demo     = services.filter((s) => !s.is_platform);
  const platform = services.filter((s) => s.is_platform);

  // The open incident on each service, so a Restart click links to it and
  // the incident walks EXECUTING → VERIFYING → RESOLVED on screen.
  const openFor = (name) => incidents.find((i) => i.service === name && isActive(i));

  return (
    <section className="space-y-3">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Services</h2>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {!loaded && demo.length === 0 && [0, 1, 2].map((i) => <SkeletonCard key={i} />)}
        {demo.map((s) => (
          <ServiceCard
            key={s.container_name}
            service={s}
            reading={metrics.current[s.container_name]}
            history={metrics.history[s.container_name]}
            incident={openFor(s.container_name)}
            busy={busy}
            onRun={onRun}
          />
        ))}
      </div>

      {platform.length > 0 && (
        <div className="space-y-2 pt-1">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Protected</h3>
          {platform.map((s) => (
            <ProtectedCard key={s.container_name} service={s} reading={metrics.current[s.container_name]} busy={busy} onRun={onRun} />
          ))}
        </div>
      )}
    </section>
  );
}
