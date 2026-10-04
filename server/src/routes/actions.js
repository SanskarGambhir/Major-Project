// =============================================================================
// POST /api/actions — "please run this action on this container."
//
// Responds 202 Accepted the moment the request is valid, then does the work
// in the background. Execution takes a few seconds and verification up to
// 30 more; the browser learns the outcome the same way it learns everything
// else — over the socket. The click is a request, not a result.
//
// Phase 5 adds requireRole('operator') in front of this.
// =============================================================================

import { Router } from 'express';
import { remediate } from '../workflow/remediate.js';
import { isBusy } from '../actions/executor.js';
import { isValidAction, actionNames } from '../actions/catalog.js';
import { getIncident, findAnyOpenIncident } from '../incidents/store.js';
import { queryAll } from '../db/pool.js';

const router = Router();

router.post('/', async (req, res, next) => {
  try {
    const { action, target, incidentId } = req.body ?? {};

    if (!isValidAction(action)) {
      return res.status(400).json({ error: `action must be one of ${actionNames().join(', ')}` });
    }
    if (typeof target !== 'string' || !/^[a-z0-9][a-z0-9_.-]*$/i.test(target)) {
      return res.status(400).json({ error: 'target must be a container name' });
    }
    if (isBusy(target)) {
      return res.status(409).json({ error: `an action is already running on ${target}` });
    }

    // Link to an incident: the one the caller named, or the open one on this
    // service if there is exactly such a thing. A manual restart with no
    // incident is fine too — it's recorded as an action with no incident_id.
    let incident = null;
    if (incidentId) {
      incident = await getIncident(incidentId);
      if (!incident) return res.status(404).json({ error: `no incident ${incidentId}` });
    } else {
      incident = await findAnyOpenIncident(target);
    }

    // Phase 5 fills this from the JWT. Until then, the header or 'operator'.
    const requestedBy = req.get('x-user') || 'operator';

    remediate({ action, target, incidentId: incident?.id ?? null, requestedBy })
      .catch((err) => console.error('[actions] remediate crashed:', err));

    res.status(202).json({ accepted: true, action, target, incidentId: incident?.id ?? null });
  } catch (err) { next(err); }
});

// Recent actions, newest first — for the drawer's "what was tried" list.
router.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const rows = await queryAll(
      'SELECT * FROM actions ORDER BY started_at DESC LIMIT $1', [limit]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

export default router;
