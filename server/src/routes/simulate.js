// =============================================================================
// POST /api/simulate/:scenario — FAULT INJECTION. Break things on purpose.
//
// This is the server side of the ScenarioRunner buttons (Phase 6 UI). Until
// then it's a curl target that saves you remembering demo-api's debug URLs.
//
// THIS IS NOT REMEDIATION AND DOES NOT GO THROUGH THE POLICY ENGINE.
// It goes the other way: it makes things worse. But it still refuses to touch
// anything that isn't labelled sre.demo=true, for the same reason the policy
// engine does — "stop" must never be pointed at sre-postgres, even by us.
// =============================================================================

import { Router } from 'express';
import { docker, inspect, withTimeout, LABEL_DEMO } from '../docker/client.js';
import { audit } from '../incidents/store.js';

const DEMO_API_URL = process.env.DEMO_API_URL ?? 'http://localhost:3001';

const router = Router();

const SCENARIOS = {
  cpu:     { label: 'CPU spike',      run: () => hitDemoApi('/debug/cpu?seconds=60') },
  leak:    { label: 'Memory leak',    run: () => hitDemoApi('/debug/leak?mb=400') },
  error:   { label: 'Error storm',    run: () => hitDemoApi('/debug/error?seconds=60') },
  stop:    { label: 'Stop demo-api',  run: () => stopDemoContainer('demo-api') },
  'db-down': { label: 'Database down', run: () => stopDemoContainer('demo-db') },
  reset:   { label: 'Reset all',      run: resetAll },
};

router.get('/', (_req, res) => {
  res.json(Object.entries(SCENARIOS).map(([name, s]) => ({ name, label: s.label })));
});

router.post('/:scenario', async (req, res, next) => {
  const s = SCENARIOS[req.params.scenario];
  if (!s) return res.status(404).json({ error: `unknown scenario; try ${Object.keys(SCENARIOS).join(', ')}` });

  try {
    const detail = await s.run();
    await audit(req.get('x-user') || 'operator', 'SIMULATE', { scenario: req.params.scenario, ...detail });
    console.log(`[simulate] ${req.params.scenario} — ${JSON.stringify(detail)}`);
    res.json({ ok: true, scenario: req.params.scenario, ...detail });
  } catch (err) { next(err); }
});

// -----------------------------------------------------------------------------

async function hitDemoApi(path) {
  const url = DEMO_API_URL + path;
  const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return { url, ...body };
}

async function stopDemoContainer(name) {
  const info = await inspect(name);
  if (!info) throw new Error(`${name} does not exist`);
  if (info.Config?.Labels?.[LABEL_DEMO] !== 'true') {
    throw new Error(`refusing to stop ${name}: not a demo container`);
  }
  if (!info.State.Running) return { stopped: name, note: 'was already stopped' };
  await withTimeout(docker.getContainer(name).stop({ t: 2 }), 15000, `stop ${name}`);
  return { stopped: name };
}

/**
 * Put every demo container back the way it was. Restarting demo-api clears
 * every in-process fault (leak, burn, error storm) in one go — a fresh
 * process has none of them — and start() brings back anything stopped.
 */
async function resetAll() {
  const list = await withTimeout(docker.listContainers({ all: true }), 5000, 'listContainers');
  const demo = list.filter((c) => c.Labels?.[LABEL_DEMO] === 'true');
  const done = [];

  for (const c of demo) {
    const name = c.Names[0].replace(/^\//, '');
    const container = docker.getContainer(name);
    if (c.State !== 'running') {
      await withTimeout(container.start(), 30000, `start ${name}`);
      done.push(`${name}: started`);
    } else if (name === 'demo-api') {
      await withTimeout(container.restart({ t: 2 }), 30000, `restart ${name}`);
      done.push(`${name}: restarted`);
    }
  }
  return { reset: done };
}

export default router;
