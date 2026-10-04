-- =============================================================================
-- DESTRUCTIVE. This deletes every incident, timeline, RCA report, action
-- record, metric, and audit entry.
--
-- Nothing in the application ever runs this file. It is reachable only through
-- `npm run db:reset`, which counts what you are about to lose and asks you to
-- type "yes" first.
--
-- Order matters: children before parents, so foreign keys don't block the drop.
-- =============================================================================

DROP TABLE IF EXISTS metrics         CASCADE;
DROP TABLE IF EXISTS audit_log       CASCADE;
DROP TABLE IF EXISTS actions         CASCADE;
DROP TABLE IF EXISTS agent_runs      CASCADE;
DROP TABLE IF EXISTS incident_events CASCADE;
DROP TABLE IF EXISTS incidents       CASCADE;
DROP TABLE IF EXISTS services        CASCADE;

-- Dropped too, so a reset starts numbering at INC-1000 again rather than
-- continuing from wherever the old data left off.
DROP SEQUENCE IF EXISTS incident_seq;
