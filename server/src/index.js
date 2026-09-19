// =============================================================================
// Entry point. Startup order matters:
//
//   1. env                 (dotenv, pulled in by db/pool.js)
//   2. database schema     ensureSchema() — safe to run every time
//   3. Docker reachable?   refuse to start blind
//   4. HTTP + Socket.IO    attach realtime to the same port
//   5. poller              only once everything it writes to exists
// =============================================================================

import 'dotenv/config';
import http from 'node:http';
import app from './app.js';
import { ensureSchema } from './db/init.js';
import { healthCheck, closePool } from './db/pool.js';
import { ping } from './docker/client.js';
import { initSocket } from './realtime/socket.js';
import { startPoller, stopPoller } from './monitoring/poller.js';

const PORT = Number(process.env.PORT ?? 3000);

/**
 * Bind the port, retrying on EADDRINUSE.
 *
 * WHY: nodemon on Windows force-kills the old process and starts the new one
 * before Windows has released the port. The new one then hits EADDRINUSE,
 * crashes, and nodemon sits at "waiting for file changes" — meaning every
 * browser reload shows "cannot reach the server" until someone types `rs`.
 * Waiting a second and trying again fixes it in practice.
 */
function listenWithRetry(server, port, { attempts = 10, delayMs = 1000 } = {}) {
  return new Promise((resolve, reject) => {
    let left = attempts;
    const tryListen = () => {
      const onError = (err) => {
        server.off('listening', onListening);
        if (err.code === 'EADDRINUSE' && --left > 0) {
          console.warn(`[http] port ${port} busy, retrying in ${delayMs}ms (${left} left)`);
          setTimeout(tryListen, delayMs);
        } else {
          reject(err);
        }
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port);
    };
    tryListen();
  });
}

// A promise nobody caught must not take the whole server down mid-demo.
// Log it loudly and keep going; the poller's next tick will retry anyway.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandled rejection]', reason instanceof Error ? reason.stack : reason);
});

async function main() {
  console.log('AI SRE Command Center — server');

  // --- database -------------------------------------------------------------
  if (!(await healthCheck())) {
    console.error(`\nCannot reach Postgres at ${process.env.DB_HOST}:${process.env.DB_PORT}.`);
    console.error('Is sre-postgres running?  docker compose -f docker/platform.compose.yml up -d\n');
    process.exit(1);
  }
  await ensureSchema({ verbose: false });
  console.log('[db] ready');

  // --- docker ---------------------------------------------------------------
  if (!(await ping())) {
    console.error(`\nCannot reach Docker at ${process.env.DOCKER_SOCKET}.`);
    console.error('Is Docker Desktop running?\n');
    process.exit(1);
  }
  console.log('[docker] ready');

  // --- http + realtime ------------------------------------------------------
  const server = http.createServer(app);
  initSocket(server);

  await listenWithRetry(server, PORT);
  console.log(`[http] listening on http://localhost:${PORT}`);
  startPoller();

  // --- shutdown -------------------------------------------------------------
  const shutdown = async (signal) => {
    console.log(`\n[${signal}] shutting down`);
    stopPoller();
    server.close();
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
