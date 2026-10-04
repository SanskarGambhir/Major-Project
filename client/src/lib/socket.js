// =============================================================================
// THE socket. One connection for the whole app.
//
// It is created HERE, at module level, on purpose. Not inside a component,
// not inside useEffect.
//
// WHY (plan §7)
// ---------------------------------------------------------------------------
// React 19's StrictMode runs every effect twice in development to surface
// bugs. A socket created inside an effect therefore connects twice. Both
// connections receive every broadcast, both call setIncidents, and EVERY
// INCIDENT APPEARS TWICE on screen. It looks exactly like a server bug and
// it isn't. A module runs once no matter how many times React re-renders,
// so the connection count is always one.
// =============================================================================

import { io } from 'socket.io-client';

const URL = import.meta.env.VITE_SOCKET_URL ?? 'http://localhost:3000';

export const socket = io(URL, {
  // Phase 5 will pass the JWT here. Until then the server accepts anyone.
  auth: (cb) => cb({ token: localStorage.getItem('token') ?? null }),
  // Reconnect forever, retrying every 0.5–2s. A nodemon restart takes ~2s,
  // so a 5s ceiling meant sitting on "disconnected" for seconds after the
  // server was already back. The next full-list broadcast after reconnect
  // catches the client up — no replay logic needed.
  reconnection: true,
  reconnectionDelay: 500,
  reconnectionDelayMax: 2000,
  timeout: 5000,
});

/** Phase 5 calls this after login so the new token is sent on reconnect. */
export function reconnectWithAuth() {
  socket.disconnect();
  socket.connect();
}
