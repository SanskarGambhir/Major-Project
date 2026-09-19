// =============================================================================
// Incident store — reads and writes for incidents and their timeline.
//
// Note what is NOT here: any function that changes `status`. That belongs
// exclusively to transition() in transitions.js. Keeping it out of this file
// is what makes the "one rule, no exceptions" claim actually true.
// =============================================================================

import { query, queryOne, queryAll } from '../db/pool.js';
import { OPEN_STATUSES, notifyIncidentsChanged } from './transitions.js';

// -----------------------------------------------------------------------------
// Timeline
// -----------------------------------------------------------------------------

/**
 * Append one line to an incident's timeline.
 *
 * This feeds four things at once: the on-screen timeline, the audit trail,
 * the RCA prompt, and our own debugging. Log generously — a missing line is
 * a hole in the story the RCA agent has to tell.
 */
export async function logEvent(incidentId, { status = null, actor = 'system', message, detail = null }) {
  await query(
    `INSERT INTO incident_events (incident_id, status, actor, message, detail)
     VALUES ($1, $2, $3, $4, $5)`,
    [incidentId, status, actor, message, detail ? JSON.stringify(detail) : null]
  );
}

export function getTimeline(incidentId) {
  return queryAll(
    `SELECT at, status, actor, message, detail
       FROM incident_events
      WHERE incident_id = $1
      ORDER BY at ASC, id ASC`,
    [incidentId]
  );
}

// -----------------------------------------------------------------------------
// Creating and reading incidents
// -----------------------------------------------------------------------------

/**
 * Create an incident. Always starts life in DETECTED.
 *
 * The caller should already have run shouldFire() (Phase 2) — this function
 * does not check for duplicates itself.
 */
export async function createIncident({ service, type, severity = null, detail = null }) {
  const row = await queryOne(
    `INSERT INTO incidents (service, type, severity, status)
     VALUES ($1, $2, $3, 'DETECTED')
     RETURNING *`,
    [service, type, severity]
  );

  await logEvent(row.id, {
    status: 'DETECTED',
    actor: 'monitor',
    message: `Incident detected on ${service}: ${type}`,
    detail,
  });

  // A new incident is a change the browser must hear about immediately —
  // it won't go through transition() until the driver picks it up.
  notifyIncidentsChanged();
  return row;
}

export function getIncident(id) {
  return queryOne('SELECT * FROM incidents WHERE id = $1', [id]);
}

export function listIncidents({ limit = 100 } = {}) {
  return queryAll(
    'SELECT * FROM incidents ORDER BY detected_at DESC LIMIT $1',
    [limit]
  );
}

export function listOpenIncidents() {
  return queryAll(
    `SELECT * FROM incidents
      WHERE status = ANY($1::text[])
      ORDER BY detected_at DESC`,
    [OPEN_STATUSES]
  );
}

// -----------------------------------------------------------------------------
// Queries that the suppression checks depend on (Phase 2)
// -----------------------------------------------------------------------------

/**
 * Is there already an open incident for this service + type?
 *
 * Without this, an exited container would create a NEW incident on every
 * 3-second poll — hundreds of duplicates for one problem.
 */
export function findOpenIncident(service, type) {
  return queryOne(
    `SELECT * FROM incidents
      WHERE service = $1 AND type = $2 AND status = ANY($3::text[])
      ORDER BY detected_at DESC
      LIMIT 1`,
    [service, type, OPEN_STATUSES]
  );
}

/** Any open incident on this service at all, whatever the type. */
export function findAnyOpenIncident(service) {
  return queryOne(
    `SELECT * FROM incidents
      WHERE service = $1 AND status = ANY($2::text[])
      ORDER BY detected_at DESC
      LIMIT 1`,
    [service, OPEN_STATUSES]
  );
}

// -----------------------------------------------------------------------------
// Updating incident FIELDS (never status — that's transition()'s job)
// -----------------------------------------------------------------------------

/** Store what the AI concluded. */
export async function saveAnalysis(id, a) {
  const row = await queryOne(
    `UPDATE incidents
        SET severity        = COALESCE($2, severity),
            category        = $3,
            root_cause      = $4,
            confidence      = $5,
            evidence        = $6,
            proposed_action = $7,
            target          = $8,
            risk            = $9,
            reasoning       = $10,
            updated_at      = now()
      WHERE id = $1
      RETURNING *`,
    [
      id, a.severity, a.category, a.root_cause, a.confidence,
      a.evidence ? JSON.stringify(a.evidence) : null,
      a.action, a.target, a.risk, a.reasoning,
    ]
  );
  notifyIncidentsChanged();
  return row;
}

/** Set the approval deadline. Without one, an unanswered approval hangs forever. */
export async function setApprovalDeadline(id, minutes = 5) {
  return queryOne(
    `UPDATE incidents
        SET approval_expires_at = now() + ($2 || ' minutes')::interval,
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [id, String(minutes)]
  );
}

/** Incidents whose approval window has run out — Phase 5 escalates these. */
export function findExpiredApprovals() {
  return queryAll(
    `SELECT * FROM incidents
      WHERE status = 'AWAITING_APPROVAL'
        AND approval_expires_at IS NOT NULL
        AND approval_expires_at < now()`
  );
}

export async function setApprovedBy(id, user) {
  return queryOne(
    'UPDATE incidents SET approved_by = $2, updated_at = now() WHERE id = $1 RETURNING *',
    [id, user]
  );
}

/** Record that this incident was a symptom of another one. */
export async function markSuppressedBy(id, rootIncidentId, reason) {
  return queryOne(
    `UPDATE incidents
        SET suppressed_by = $2, suppression_reason = $3, updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [id, rootIncidentId, reason]
  );
}

export async function saveRca(id, { report, recommendations }) {
  const row = await queryOne(
    `UPDATE incidents
        SET rca_report = $2, rca_recommendations = $3, updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [id, report, recommendations ? JSON.stringify(recommendations) : null]
  );
  notifyIncidentsChanged();
  return row;
}

// -----------------------------------------------------------------------------
// Services
// -----------------------------------------------------------------------------

export function listServices() {
  return queryAll('SELECT * FROM services ORDER BY is_platform ASC, container_name ASC');
}

export function getService(containerName) {
  return queryOne('SELECT * FROM services WHERE container_name = $1', [containerName]);
}

// -----------------------------------------------------------------------------
// Audit log
// -----------------------------------------------------------------------------

export async function audit(actor, action, detail = null) {
  await query(
    'INSERT INTO audit_log (actor, action, detail) VALUES ($1, $2, $3)',
    [actor, action, detail ? JSON.stringify(detail) : null]
  );
}
