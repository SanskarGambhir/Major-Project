// =============================================================================
// Live service metrics.
//
//   current  — { 'demo-api': reading, 'demo-db': reading, ... }  latest only
//   history  — { 'demo-api': [reading × ≤40], ... }               for sparklines
//
// Two sources feed it:
//   'snapshot'  once on connect — the server's own history, so a browser
//               refresh shows a full sparkline instead of a single dot
//   'metrics'   every 3 seconds — this tick's readings for every service
//
// History is capped at 40 points. A tab left open for an hour would otherwise
// hold 1,200 points per service and the charts would crawl.
// =============================================================================

import { useState, useCallback } from 'react';
import { useSocketEvent } from './useSocketEvent';

const HISTORY_LENGTH = 40;

export function useMetrics() {
  const [current, setCurrent] = useState({});
  const [history, setHistory] = useState({});
  const [loaded, setLoaded]   = useState(false);

  const apply = useCallback((readings) => {
    setCurrent((prev) => {
      const next = { ...prev };
      for (const r of readings) next[r.service] = r;
      return next;
    });
    setHistory((prev) => {
      const next = { ...prev };
      for (const r of readings) {
        const list = [...(next[r.service] ?? []), r];
        next[r.service] = list.slice(-HISTORY_LENGTH);
      }
      return next;
    });
    setLoaded(true);
  }, []);

  useSocketEvent('snapshot', (snap) => {
    // Replace, don't merge: the server's history is authoritative.
    setHistory(snap.history ?? {});
    apply(snap.metrics ?? []);
  });

  useSocketEvent('metrics', apply);

  return { current, history, loaded };
}
