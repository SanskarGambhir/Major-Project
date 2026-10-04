// =============================================================================
// The incident list. Three lines of logic, because the server sends the FULL
// list on every change (plan §7). No merging, no ordering problems, no "did
// the update for INC-1024 arrive before or after its resolve?" — the newest
// message is the truth and we render it.
// =============================================================================

import { useState } from 'react';
import { useSocketEvent } from './useSocketEvent';

export function useIncidents() {
  const [incidents, setIncidents] = useState([]);
  const [loaded, setLoaded] = useState(false);

  useSocketEvent('snapshot', (snap) => { setIncidents(snap.incidents ?? []); setLoaded(true); });
  useSocketEvent('incidents', (list) => { setIncidents(list); setLoaded(true); });

  return { incidents, loaded };
}
