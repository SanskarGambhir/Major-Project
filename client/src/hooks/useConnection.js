// =============================================================================
// Is the socket connected? Drives the amber "disconnected" banner.
//
// A silent stale screen must never masquerade as a calm one. If the server
// dies mid-demo, the numbers on screen freeze — and without this banner they
// look like a perfectly healthy system.
//
// `showBanner` lags `connected` by a short grace period. On a fresh page load
// the socket takes a few hundred ms to connect; without the grace period the
// banner flashes on every reload and makes a healthy system look broken.
// =============================================================================

import { useEffect, useState } from 'react';
import { socket } from '../lib/socket';

const GRACE_MS = 1500;

export function useConnection() {
  const [connected, setConnected] = useState(socket.connected);
  const [everConnected, setEverConnected] = useState(socket.connected);
  const [showBanner, setShowBanner] = useState(false);

  useEffect(() => {
    const up   = () => { setConnected(true); setEverConnected(true); };
    const down = () => setConnected(false);
    socket.on('connect', up);
    socket.on('disconnect', down);

    // The socket starts connecting the moment its module loads — possibly
    // BEFORE this effect attaches the listeners. If 'connect' fired in that
    // gap we'd never hear it and sit on "Disconnected" with live data on
    // screen. So re-read the real state now that we're listening.
    if (socket.connected) up();

    return () => {
      socket.off('connect', up);
      socket.off('disconnect', down);
    };
  }, []);

  useEffect(() => {
    if (connected) { setShowBanner(false); return; }
    const t = setTimeout(() => setShowBanner(true), GRACE_MS);
    return () => clearTimeout(t);
  }, [connected]);

  return { connected, everConnected, showBanner };
}
