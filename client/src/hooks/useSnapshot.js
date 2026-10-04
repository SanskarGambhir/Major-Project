// =============================================================================
// Ask the server for a full snapshot whenever we (re)connect.
//
// Mounted ONCE, in Dashboard, after useMetrics and useIncidents have attached
// their 'snapshot' listeners. Ordering inside a component is guaranteed by
// React (effects run in declaration order), so by the time this asks, the
// hooks that need the answer are already listening.
//
// The server does not push a snapshot on its own — see socket.js on the
// server for why. This hook is the only place that requests one.
// =============================================================================

import { useEffect } from 'react';
import { socket } from '../lib/socket';

export function useSnapshot() {
  useEffect(() => {
    const ask = () => socket.emit('snapshot:request');
    socket.on('connect', ask);
    if (socket.connected) ask();      // connected before we mounted
    return () => socket.off('connect', ask);
  }, []);
}
