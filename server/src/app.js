// =============================================================================
// Express app — the REST side. "Do things" and "ask for a snapshot".
//
// Live updates do NOT come through here; that's Socket.IO (realtime/socket.js).
// REST exists for two reasons: the initial page load, and actions (Phase 3+).
// =============================================================================

import express from 'express';
import cors from 'cors';
import { healthCheck } from './db/pool.js';
import { ping } from './docker/client.js';
import { listServices, listIncidents, getIncident, getTimeline } from './incidents/store.js';
import { latestReadings } from './monitoring/poller.js';
import { queryAll } from './db/pool.js';
import { ACTIONS } from './actions/catalog.js';
import { corsOrigin } from './cors.js';

const app = express();

app.use(cors({ origin: corsOrigin }));
app.use(express.json());

// -----------------------------------------------------------------------------
// Health — the dashboard's connection indicator hits this
// -----------------------------------------------------------------------------
app.get('/api/health', async (_req, res) => {
  const [db, dockerOk] = await Promise.all([healthCheck(), ping()]);
  const ok = Boolean(db) && dockerOk;
  res.status(ok ? 200 : 503).json({ ok, db: Boolean(db), docker: dockerOk, at: new Date() });
});

// -----------------------------------------------------------------------------
// Services — the seed rows joined with whatever the poller last saw
// -----------------------------------------------------------------------------
app.get('/api/services', async (_req, res, next) => {
  try {
    const services = await listServices();
    const live = Object.fromEntries(latestReadings().map((r) => [r.service, r]));
    res.json(services.map((s) => ({ ...s, live: live[s.container_name] ?? null })));
  } catch (err) { next(err); }
});

// -----------------------------------------------------------------------------
// Incidents
// -----------------------------------------------------------------------------
app.get('/api/incidents', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    res.json(await listIncidents({ limit }));
  } catch (err) { next(err); }
});

app.get('/api/incidents/:id', async (req, res, next) => {
  try {
    const incident = await getIncident(req.params.id);
    if (!incident) return res.status(404).json({ error: 'not found' });
    const timeline = await getTimeline(req.params.id);
    res.json({ ...incident, timeline });
  } catch (err) { next(err); }
});

// -----------------------------------------------------------------------------
// Metrics history for one service (for charts longer than the sparkline)
// -----------------------------------------------------------------------------
app.get('/api/metrics/:service', async (req, res, next) => {
  try {
    const minutes = Math.min(Number(req.query.minutes ?? 15), 120);
    const rows = await queryAll(
      `SELECT at, status, health, cpu_pct, mem_used, mem_limit, mem_pct
         FROM metrics
        WHERE service = $1 AND at > now() - ($2 || ' minutes')::interval
        ORDER BY at ASC`,
      [req.params.service, String(minutes)]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// The action catalog, so the UI can label things without hardcoding them.
app.get('/api/actions/catalog', (_req, res) => {
  res.json(ACTIONS);
});

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------
// Express 5 note: a catch-all route must be '/*splat', not '*'.
app.use('/*splat', (_req, res) => res.status(404).json({ error: 'not found' }));

app.use((err, _req, res, _next) => {
  console.error('[api]', err);
  res.status(500).json({ error: err.message });
});

export default app;
