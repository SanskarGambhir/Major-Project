-- =============================================================================
-- AI SRE Command Center — schema
--
-- THIS FILE IS SAFE TO RUN AT ANY TIME.
--
-- Every statement uses IF NOT EXISTS / ON CONFLICT DO NOTHING, so running it
-- against a database that already has data changes nothing and destroys
-- nothing. That is what lets the server run it automatically on startup.
--
-- To DESTROY everything and start clean, use drop.sql (npm run db:reset).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- services — what we monitor, and how they depend on each other.
--
-- `depends_on` powers alert correlation: if demo-db is already broken, an
-- alert about demo-api is a symptom, not a new problem.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS services (
  id             SERIAL PRIMARY KEY,
  container_name TEXT UNIQUE NOT NULL,
  display_name   TEXT,
  health_url     TEXT,
  depends_on     TEXT[]      NOT NULL DEFAULT '{}',
  is_platform    BOOLEAN     NOT NULL DEFAULT FALSE,   -- TRUE = protected, never a target
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- -----------------------------------------------------------------------------
-- incidents — one row per problem, carrying its current state.
--
-- IDs read as INC-1000, INC-1001... friendlier on screen and in a report than
-- a UUID.
-- -----------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS incident_seq START 1000;

CREATE TABLE IF NOT EXISTS incidents (
  id                  TEXT PRIMARY KEY DEFAULT ('INC-' || nextval('incident_seq')),
  service             TEXT NOT NULL,
  type                TEXT NOT NULL,           -- CONTAINER_OOM_KILLED, HIGH_CPU, ...
  status              TEXT NOT NULL DEFAULT 'DETECTED',
  severity            TEXT,                    -- SEV1 | SEV2 | SEV3

  -- Filled in by the AI (Phase 4)
  category            TEXT,
  root_cause          TEXT,
  confidence          REAL,
  evidence            JSONB,
  proposed_action     TEXT,
  target              TEXT,
  risk                TEXT,
  reasoning           TEXT,

  -- Correlation (Phase 6). suppressed_by points at the incident that
  -- actually caused this one.
  suppressed_by       TEXT REFERENCES incidents(id),
  suppression_reason  TEXT,

  -- Human-in-the-loop (Phase 5). Without an expiry an unanswered approval
  -- would hang forever.
  approval_expires_at TIMESTAMPTZ,
  approved_by         TEXT,

  -- RCA (Phase 5)
  rca_report          TEXT,
  rca_recommendations JSONB,

  detected_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at         TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A typo in a status string becomes a loud error here rather than a silent
  -- row that no query ever matches again.
  CONSTRAINT valid_status CHECK (status IN (
    'DETECTED',
    'TRIAGING',
    'AWAITING_APPROVAL',
    'EXECUTING',
    'VERIFYING',
    'RESOLVED',
    'CLOSED',
    'SUPPRESSED',
    'ESCALATED',
    'REMEDIATION_FAILED',
    'AUTO_RESOLVED'
  ))
);

CREATE INDEX IF NOT EXISTS idx_incidents_status       ON incidents (status);
CREATE INDEX IF NOT EXISTS idx_incidents_service_open ON incidents (service, status);
CREATE INDEX IF NOT EXISTS idx_incidents_detected     ON incidents (detected_at DESC);


-- -----------------------------------------------------------------------------
-- incident_events — the timeline. THE MOST IMPORTANT TABLE IN THE PROJECT.
--
-- It is four things at once:
--   1. the timeline shown on screen
--   2. the audit trail of who did what and when
--   3. the exact input to the RCA prompt
--   4. how we debug a workflow that went wrong
--
-- Give an LLM a vague prompt and you get vague prose. Give it this table and
-- you get something that reads like a real postmortem.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incident_events (
  id          SERIAL PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  status      TEXT,                                  -- status after this event
  actor       TEXT NOT NULL DEFAULT 'system',        -- system | ai | operator name
  message     TEXT NOT NULL,
  detail      JSONB
);

CREATE INDEX IF NOT EXISTS idx_events_incident ON incident_events (incident_id, at);


-- -----------------------------------------------------------------------------
-- agent_runs — every call to the AI, successes and failures alike.
--
-- Storing failures with their raw output is what makes bad JSON debuggable
-- instead of guesswork. Also gives us a free token/latency panel.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_runs (
  id                SERIAL PRIMARY KEY,
  incident_id       TEXT REFERENCES incidents(id) ON DELETE CASCADE,
  agent             TEXT NOT NULL,           -- triage | investigate | mitigate | rca
  provider          TEXT,                    -- gemini | ollama | rules
  model             TEXT,
  latency_ms        INTEGER,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  output            JSONB,
  raw               TEXT,                    -- what the model actually said
  ok                BOOLEAN NOT NULL DEFAULT TRUE,
  error             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_incident ON agent_runs (incident_id, created_at);


-- -----------------------------------------------------------------------------
-- actions — every remediation attempt, including the ones we REFUSED.
--
-- Refusals matter as much as successes: "we blocked an attempt to restart
-- sre-postgres" is a security event worth having on record.
--
-- started_at_before / started_at_after hold the container's StartedAt either
-- side of the action. If they differ, the restart definitely happened — a
-- silently failed restart would otherwise look identical to a successful one.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS actions (
  id                SERIAL PRIMARY KEY,
  incident_id       TEXT REFERENCES incidents(id) ON DELETE CASCADE,
  action_type       TEXT NOT NULL,           -- from the action catalog, never free text
  target            TEXT NOT NULL,
  requested_by      TEXT,                    -- 'ai-auto' or an operator name

  policy_allowed    BOOLEAN,
  policy_reason     TEXT,

  started_at_before TIMESTAMPTZ,
  started_at_after  TIMESTAMPTZ,

  result            TEXT,                    -- success | failed | denied
  error             TEXT,
  verified          BOOLEAN,
  verification      JSONB,

  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ
);

-- Supports restartsInLastHour(), which drives the circuit breaker.
CREATE INDEX IF NOT EXISTS idx_actions_target_time ON actions (target, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_actions_incident    ON actions (incident_id);


-- -----------------------------------------------------------------------------
-- metrics — what the poller writes every 3 seconds.
--
-- Two consumers: the dashboard sparklines, and the Investigation agent, which
-- needs "memory over the last 60 seconds" to tell a LEAK (climbs steadily)
-- from a SPIKE (rises and falls).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS metrics (
  id            BIGSERIAL PRIMARY KEY,
  service       TEXT NOT NULL,
  at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  status        TEXT,                        -- running | exited | restarting
  health        TEXT,                        -- healthy | unhealthy | starting | none
  cpu_pct       REAL,
  mem_used      BIGINT,
  mem_limit     BIGINT,
  mem_pct       REAL,
  restart_count INTEGER
);

CREATE INDEX IF NOT EXISTS idx_metrics_service_time ON metrics (service, at DESC);


-- -----------------------------------------------------------------------------
-- audit_log — append-only record of everything security-relevant.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id     BIGSERIAL PRIMARY KEY,
  at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  detail JSONB
);

CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log (at DESC);


-- =============================================================================
-- SEED — the services we monitor, and the dependency graph.
--
-- ON CONFLICT DO NOTHING makes this safe to re-run: existing rows are left
-- exactly as they are, including any edits you have made to them.
-- =============================================================================
INSERT INTO services (container_name, display_name, health_url, depends_on, is_platform) VALUES
  ('demo-api',     'Demo API',    'http://localhost:3001/health', ARRAY['demo-db','demo-cache'], FALSE),
  ('demo-db',      'Demo DB',     NULL, ARRAY[]::TEXT[], FALSE),
  ('demo-cache',   'Demo Cache',  NULL, ARRAY[]::TEXT[], FALSE),
  ('sre-postgres', 'Platform DB', NULL, ARRAY[]::TEXT[], TRUE)
ON CONFLICT (container_name) DO NOTHING;
