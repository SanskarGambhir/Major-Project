// =============================================================================
// The six dots: Detect · Analyse · Approve · Execute · Verify · Report
//
// This is the component that makes the multi-step workflow LEGIBLE. It's what
// shows an examiner this isn't one AI call — each dot is a stage the incident
// passed through, and the pulsing one is where it is right now.
//
// Each stage is filled, current (pulsing), or empty, derived purely from
// incident.status. Terminal statuses that skipped stages (AUTO_RESOLVED,
// SUPPRESSED, ESCALATED) show a short label instead of pretending.
// =============================================================================

import { cn } from '../lib/utils';

const STAGES = ['Detect', 'Analyse', 'Approve', 'Execute', 'Verify', 'Report'];

// Which stage index is "current" for each status. Stages before it are done.
const CURRENT = {
  DETECTED:           0,
  TRIAGING:           1,
  AWAITING_APPROVAL:  2,
  EXECUTING:          3,
  VERIFYING:          4,
  RESOLVED:           5,
  REMEDIATION_FAILED: 4,
  CLOSED:             6,   // past the end — everything filled
};

// Statuses that left the happy path. We show what happened rather than dots.
const OFF_PATH = {
  AUTO_RESOLVED: { label: 'Recovered on its own', tone: 'text-emerald-600 dark:text-emerald-400' },
  SUPPRESSED:    { label: 'Symptom of another incident', tone: 'text-muted-foreground' },
  ESCALATED:     { label: 'Handed to a human', tone: 'text-red-600 dark:text-red-400' },
};

export function WorkflowStages({ status, compact = false }) {
  const off = OFF_PATH[status];
  if (off) {
    return <div className={cn('text-xs', off.tone)}>{off.label}</div>;
  }

  const current = CURRENT[status] ?? 0;
  const failed  = status === 'REMEDIATION_FAILED';

  return (
    <div className="flex items-center gap-1.5" aria-label={`Stage: ${STAGES[Math.min(current, 5)]}`}>
      {STAGES.map((name, i) => {
        const done    = i < current;
        const active  = i === current;
        return (
          <div key={name} className="flex items-center gap-1.5">
            <div className="flex flex-col items-center gap-1">
              <span
                className={cn(
                  'size-2.5 rounded-full border transition-colors duration-500',
                  done   && 'bg-emerald-500 border-emerald-500',
                  active && !failed && 'bg-sky-500 border-sky-500 animate-pulse',
                  active && failed  && 'bg-red-500 border-red-500',
                  !done && !active  && 'bg-transparent border-muted-foreground/40'
                )}
              />
              {!compact && (
                <span className={cn(
                  'text-[10px] leading-none',
                  active ? 'text-foreground font-medium' : 'text-muted-foreground'
                )}>
                  {name}
                </span>
              )}
            </div>
            {i < STAGES.length - 1 && (
              <span className={cn(
                'h-px w-3 -mt-3',
                compact && 'mt-0',
                i < current ? 'bg-emerald-500' : 'bg-muted-foreground/30'
              )} />
            )}
          </div>
        );
      })}
    </div>
  );
}
