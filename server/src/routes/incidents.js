// =============================================================================
// POST /api/incidents/:id/approve  — "yes, run the AI's proposal"
// POST /api/incidents/:id/reject   — "no, hand it to a person"
// GET  /api/incidents/:id/runs     — every agent attempt, for the drawer
//
// Approve responds 202 the moment the incident is claimed, then remediate()
// does the work in the background — same contract as POST /api/actions.
// The status guard in transition() is what stops a double-clicked Approve
// from restarting twice: the second call finds EXECUTING and matches nothing.
//
// Phase 5 adds requireRole('operator') in front of approve and reject.
// =============================================================================

import { Router } from 'express';
import { getIncident, listAgentRuns } from '../incidents/store.js';
import { approve, reject } from '../workflow/driver.js';

const router = Router();

router.post('/:id/approve', async (req, res, next) => {
  try {
    const incident = await getIncident(req.params.id);
    if (!incident) return res.status(404).json({ error: 'not found' });
    if (incident.status !== 'AWAITING_APPROVAL') {
      return res.status(409).json({ error: `incident is ${incident.status}, not AWAITING_APPROVAL` });
    }

    // Phase 5 fills this from the JWT. Until then, the header or 'operator'.
    const user = req.get('x-user') || 'operator';

    approve(incident, user).catch((err) => console.error('[incidents] approve crashed:', err));

    res.status(202).json({
      accepted: true, incidentId: incident.id,
      action: incident.proposed_action, target: incident.target, approvedBy: user,
    });
  } catch (err) { next(err); }
});

router.post('/:id/reject', async (req, res, next) => {
  try {
    const incident = await getIncident(req.params.id);
    if (!incident) return res.status(404).json({ error: 'not found' });

    const user = req.get('x-user') || 'operator';
    const result = await reject(incident, user, req.body?.reason ?? '');
    if (!result.ok) return res.status(409).json({ error: result.error });

    res.json({ ok: true, incidentId: incident.id, rejectedBy: user });
  } catch (err) { next(err); }
});

router.get('/:id/runs', async (req, res, next) => {
  try {
    const incident = await getIncident(req.params.id);
    if (!incident) return res.status(404).json({ error: 'not found' });
    res.json(await listAgentRuns(incident.id));
  } catch (err) { next(err); }
});

export default router;
