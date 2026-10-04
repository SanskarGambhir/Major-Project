// =============================================================================
// Socket.IO — how the browser LEARNS things. (REST is how it DOES things.)
//
// Three events go out:
//
//   'metrics'     every poll, one message carrying EVERY service's reading
//   'incidents'   whenever anything changes, the FULL incident list
//   'snapshot'    once, on connect — everything the client needs to draw
//                 itself, so a browser refresh mid-incident rebuilds correctly
//
// WHY THE FULL LIST EVERY TIME (plan §7)
// ---------------------------------------------------------------------------
// We could send "incident X moved to RESOLVED". But then a delayed 'updated'
// arriving after 'resolved' would show a resolved incident as active — and
// the client would need sequence numbers and reconciliation to notice. With
// fewer than a hundred incidents on screen, resending the whole list costs
// nothing and makes that entire class of bug impossible. The client's state
// becomes `setIncidents(list)` and that's it.
// =============================================================================

import { Server } from 'socket.io';
import { listIncidents } from '../incidents/store.js';
import { setBroadcaster } from '../incidents/transitions.js';
import { corsOrigin } from '../cors.js';

let io = null;

// Latest reading per service + short history, kept here so a freshly
// connected client can be caught up without waiting for the next poll.
let latestMetrics = [];
let metricsHistory = {};

/**
 * Attach Socket.IO to the HTTP server. Call once from index.js.
 */
export function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: corsOrigin },
  });

  io.on('connection', (socket) => {
    console.log(`[socket] client connected (${io.engine.clientsCount} total)`);

    // Catch the newcomer up. Sent on request rather than pushed blindly on
    // connect: the browser's React hooks attach their listeners a moment
    // AFTER the socket connects, and a snapshot pushed into that gap is lost.
    // Letting the client ask once it's listening makes the timing irrelevant.
    const sendSnapshot = async () => {
      try {
        socket.emit('snapshot', {
          incidents: await listIncidents({ limit: 100 }),
          metrics: latestMetrics,
          history: metricsHistory,
        });
      } catch (err) {
        console.error('[socket] snapshot failed:', err.message);
      }
    };
    socket.on('snapshot:request', sendSnapshot);

    socket.on('disconnect', () => {
      console.log(`[socket] client disconnected (${io.engine.clientsCount} total)`);
    });
  });

  // From now on every transition() call re-broadcasts the incident list.
  // Fire-and-forget on purpose: a slow broadcast must never block a status
  // change, and a failed one is logged rather than thrown.
  setBroadcaster(() => {
    broadcastIncidents().catch((err) =>
      console.error('[socket] broadcast failed:', err.message)
    );
  });

  return io;
}

/** Push the full, current incident list to everyone. */
export async function broadcastIncidents() {
  if (!io) return;
  const incidents = await listIncidents({ limit: 100 });
  io.emit('incidents', incidents);
}

/**
 * Push this poll's readings. `history` is the poller's per-service ring
 * buffer; we keep a reference so 'snapshot' can hand it to new clients.
 */
export function emitMetrics(readings, history) {
  latestMetrics = readings;
  metricsHistory = history;
  if (!io) return;
  io.emit('metrics', readings);
}

/** Generic emit for events that don't need their own function yet. */
export function emit(event, payload) {
  if (!io) return;
  io.emit(event, payload);
}
