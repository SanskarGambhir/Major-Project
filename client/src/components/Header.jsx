// Title, connection indicator, and (Phase 6) the provider pill.

import { Activity, Moon, Sun } from 'lucide-react';
import { cn } from '../lib/utils';

export function Header({ connected, dark, onToggleDark }) {
  return (
    <header className="flex items-center justify-between gap-4 py-3">
      <div className="flex items-center gap-2.5">
        <Activity className="size-5 text-sky-500" />
        <h1 className="text-base font-semibold tracking-tight">AI SRE Command Center</h1>
        {import.meta.env.VITE_DEMO_MODE === 'true' && (
          <span className="rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            demo
          </span>
        )}
      </div>

      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className={cn('size-2 rounded-full', connected ? 'bg-emerald-500' : 'bg-red-500 animate-pulse')} />
          {connected ? 'Live' : 'Disconnected'}
        </div>

        <button
          type="button"
          onClick={onToggleDark}
          className="rounded-md border p-1.5 text-muted-foreground hover:bg-accent"
          aria-label="Toggle dark mode"
        >
          {dark ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
        </button>
      </div>
    </header>
  );
}
