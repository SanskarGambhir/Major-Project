// =============================================================================
// The whole app, once logged in. Two columns: services left, incidents right.
//
// Data comes from exactly two hooks (useMetrics, useIncidents) plus one
// REST call on mount for the static service list. Everything else on screen
// is derived from those — no component fetches its own data.
// =============================================================================

import { useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';
import { Header } from '../components/Header';
import { StatsRow } from '../components/StatsRow';
import { ServiceGrid } from '../components/ServiceGrid';
import { IncidentPanel } from '../components/IncidentPanel';
import { useMetrics } from '../hooks/useMetrics';
import { useIncidents } from '../hooks/useIncidents';
import { useConnection } from '../hooks/useConnection';
import { useSnapshot } from '../hooks/useSnapshot';
import { useActions } from '../hooks/useActions';
import { Toaster } from 'sonner';
import { getServices } from '../lib/api';

function useDarkMode() {
  const [dark, setDark] = useState(() => {
    try {
      const saved = localStorage.getItem('theme');
      if (saved) return saved === 'dark';
    } catch { /* ignore */ }
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  });
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch { /* ignore */ }
  }, [dark]);
  return [dark, () => setDark((d) => !d)];
}

export default function Dashboard() {
  const [services, setServices] = useState([]);
  const metrics   = useMetrics();
  const { incidents, loaded: incidentsLoaded } = useIncidents();
  const { connected, everConnected, showBanner } = useConnection();
  useSnapshot();   // AFTER useMetrics/useIncidents, so their listeners exist first
  const { busy, run } = useActions();
  const [dark, toggleDark] = useDarkMode();

  // The service list is static (seeded in Phase 1); fetch it once. Retry on
  // reconnect in case the first attempt happened while the server was down.
  useEffect(() => {
    if (!connected) return;
    getServices().then(setServices).catch((err) => console.warn('services:', err.message));
  }, [connected]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 space-y-4 pb-10">
        <Header connected={connected} dark={dark} onToggleDark={toggleDark} />

        {showBanner && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-700 dark:text-amber-300">
            <WifiOff className="size-4 shrink-0" />
            {everConnected
              ? 'Connection to the server lost — reconnecting. Numbers on screen may be stale.'
              : 'Cannot reach the server at ' + (import.meta.env.VITE_SOCKET_URL ?? 'http://localhost:3000') + '. Is it running?'}
          </div>
        )}

        <StatsRow services={services} metrics={metrics} incidents={incidents} />

        <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
          <ServiceGrid
            services={services}
            metrics={metrics}
            incidents={incidents}
            loaded={metrics.loaded}
            busy={busy}
            onRun={run}
          />
          <IncidentPanel incidents={incidents} loaded={incidentsLoaded} />
        </div>
      </div>
      {/* One Toaster for the whole app, themed to match our own dark toggle.
          useActions() is the only thing that calls toast(). */}
      <Toaster position="bottom-right" richColors closeButton theme={dark ? 'dark' : 'light'} />
    </div>
  );
}
