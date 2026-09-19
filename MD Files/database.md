# The Database — Every Table Explained

> Seven tables. Each one answers a different question about an incident. This document explains what each table is for, why it has to exist, what every column means, and how they fit together — in plain words.

---

## 1. The big picture

Think of the database as a **hospital's record system**. When a patient (a container) gets sick, a lot of different people need to write things down: who the patient is, what's wrong with them, what the doctors concluded, what treatment was given, whether it worked, and a running log of everything that happened.

If all of that went into one giant notebook, it'd be unreadable. So a hospital uses separate records for separate purposes — and so do we.

| Table | The question it answers | Hospital equivalent |
|---|---|---|
| `services` | *Who are we looking after?* | The ward list |
| `incidents` | *What's wrong, and how far along is the treatment?* | The patient's chart |
| `incident_events` | *What happened, step by step, and when?* | The nurse's running notes |
| `agent_runs` | *What did the AI conclude, and how long did it take?* | The consultant's written opinions |
| `actions` | *What did we actually do about it — including what we refused to do?* | The treatment record |
| `metrics` | *What were the vital signs, every few seconds?* | The heart monitor's trace |
| `audit_log` | *Who touched what, for security purposes?* | The security logbook |

All seven live in **`sre-postgres`** — a Postgres container on port 5434 that is labelled `sre.platform=true` and can never be touched by automated remediation. That's deliberate: one of our demo scenarios is "the database went down," and it would be absurd if fixing that deleted the record of the incident being fixed.

---

## 2. How they connect

```
                    ┌────────────┐
                    │  services  │   ← who we watch, and what depends on what
                    └────────────┘
                          │ (by name)
                          ▼
┌───────────┐       ┌────────────┐       ┌────────────────┐
│  metrics  │──────►│ incidents  │◄──────│ incident_events│   ← the timeline
└───────────┘       └─────┬──────┘       └────────────────┘
  (by service name)       │
                ┌─────────┼─────────┐
                ▼         ▼         ▼
        ┌────────────┐ ┌────────┐ ┌───────────┐
        │ agent_runs │ │actions │ │ audit_log │
        └────────────┘ └────────┘ └───────────┘
        (what the AI   (what we    (security
         concluded)     did)        events)
```

**`incidents` is the centre.** Almost everything else hangs off an incident by its ID (`INC-1024`). If you delete an incident, its timeline, AI runs, and action records go with it — that's what `ON DELETE CASCADE` means in the schema.

---

## 3. `services` — the ward list

### What it is
A short, fixed list of the containers we care about. It's the only table you'd ever edit by hand.

### Why it has to exist
Two reasons:

1. **So the monitor knows what to watch.** Docker has all sorts of containers on it. This table says which ones are ours.
2. **So we know what depends on what.** This is the important one.

When `demo-db` dies, `demo-api` starts throwing errors and failing its health checks — because it *needs* the database. A naive system would report **three separate incidents**: database down, API erroring, API unhealthy. But there's really only **one** problem.

The `depends_on` column is how we know that. When an alert fires for `demo-api`, we check: *is anything it depends on already broken?* If yes, this is a symptom, not a new disease, and we fold it into the existing incident.

That single column is what powers the alert correlation feature.

### The columns

| Column | What it means |
|---|---|
| `id` | An auto-number. Never used for anything — we refer to services by name. |
| `container_name` | The Docker container's name, e.g. `demo-api`. **This is the real key.** Unique. |
| `display_name` | A friendlier name for the dashboard, e.g. "Demo API". |
| `health_url` | Where to poke it to ask "are you alive?" — `http://localhost:3001/health`. Empty for databases, which we check by container status instead. |
| `depends_on` | A list of other container names this one needs. `demo-api` → `['demo-db', 'demo-cache']`. |
| `is_platform` | `true` = this is **our** infrastructure, protected, never a target. Only `sre-postgres` has this set. |
| `created_at` | When the row was added. |

### What's in it right now

```
container_name   display_name   depends_on               is_platform
demo-api         Demo API       {demo-db, demo-cache}    false
demo-db          Demo DB        {}                       false
demo-cache       Demo Cache     {}                       false
sre-postgres     Platform DB    {}                       true      ← protected
```

### Who writes it, who reads it
- **Written by:** `npm run db:init` (the seed). Nothing else — unless you edit it manually.
- **Read by:** the monitor (what to poll), the correlation check (dependencies), the dashboard (the protected section).

---

## 4. `incidents` — the patient's chart

### What it is
**One row per problem.** It holds the *current state* of that problem: what's wrong, how bad, what the AI thinks caused it, what fix was proposed, and where it is in the workflow.

### Why it has to exist
This is the thing the whole project is about. Every other table exists to support this one.

But there's a subtlety worth understanding: **this table holds the *current* state, not the history.** When an incident moves from `TRIAGING` to `EXECUTING`, the `status` column is overwritten. The old value is gone from this table. That's fine — the *history* lives in `incident_events`, which we'll get to.

Think of it this way: the chart at the foot of the bed shows the patient's condition *right now*. The nurse's notes show how they got there.

### The columns, grouped by who fills them in

**Set when the incident is created (by the monitor):**

| Column | What it means |
|---|---|
| `id` | `INC-1000`, `INC-1001`, and so on. Readable on purpose — you can say it out loud in a demo. |
| `service` | Which container. `demo-api`. |
| `type` | What kind of problem. `CONTAINER_OOM_KILLED`, `HIGH_CPU`, `CONTAINER_DOWN`, `UNHEALTHY`. |
| `status` | Where it is in the workflow. Starts at `DETECTED`. See §4.1. |
| `detected_at` | When we noticed. |

**Filled in by the AI (Phase 4):**

| Column | What it means |
|---|---|
| `severity` | `SEV1` (down), `SEV2` (degraded), `SEV3` (warning). |
| `category` | `RESOURCE_EXHAUSTION`, `SERVICE_DOWN`, `DEPENDENCY_FAILURE`... |
| `root_cause` | A sentence: *"Application memory exhaustion — heap grew unbounded until the 256 MB limit."* |
| `confidence` | 0 to 1. How sure the AI is. **This number decides whether a human gets asked.** |
| `evidence` | A list of the facts it based that on. Stored as JSON. |
| `proposed_action` | One of the four words from the action catalog. `RESTART_CONTAINER`. |
| `target` | Which container to do it to. |
| `risk` | `LOW`, `MEDIUM`, `NONE`. Comes from the catalog, not the AI. |
| `reasoning` | Why the AI picked that action, in a sentence. |

**Correlation (Phase 6):**

| Column | What it means |
|---|---|
| `suppressed_by` | If this incident turned out to be a symptom of another one, this points at the real one. |
| `suppression_reason` | Why. *"demo-db is down, and demo-api depends on it."* |

**Human approval (Phase 5):**

| Column | What it means |
|---|---|
| `approval_expires_at` | A deadline. If nobody clicks Approve by then, the incident escalates instead of hanging forever. |
| `approved_by` | Who clicked it. |

**The report (Phase 5):**

| Column | What it means |
|---|---|
| `rca_report` | The finished postmortem, as text. **This is the expensive thing to lose.** |
| `rca_recommendations` | A list of follow-ups. JSON. |

**Housekeeping:**

| Column | What it means |
|---|---|
| `resolved_at` | Stamped automatically when status becomes `RESOLVED` or `AUTO_RESOLVED`. `resolved_at − detected_at` = recovery time. |
| `updated_at` | Last change. |

### 4.1 The `status` column — the workflow

This is the most important column in the project. It's where the incident is in its journey:

```
DETECTED ──► TRIAGING ──┬──► AWAITING_APPROVAL ──► EXECUTING ──► VERIFYING ──► RESOLVED ──► CLOSED
    │                   └────────────────────────────► (skipped if confidence is high enough)
    │
    ├──► SUPPRESSED      "this is a symptom of another incident"
    ├──► AUTO_RESOLVED   "it fixed itself before we acted"
    └──► ESCALATED       "a human needs to look at this"
```

Plus `REMEDIATION_FAILED` for when the fix didn't work.

**Two rules protect this column:**

1. **The database refuses invalid values.** There's a `CHECK` constraint listing the eleven legal statuses. A typo like `RESLOVED` is rejected with an error rather than silently stored and never matched by any query again.

2. **Only one function in the codebase is allowed to change it.** `transition()` in `transitions.js`. It checks that the move is legal — you can't go from `DETECTED` straight to `RESOLVED` — and it does so in a way that makes double-execution impossible even if two things try at the same instant. See [Phase1.md §5](Phases/Phase1.md).

### Who writes it, who reads it
- **Written by:** the monitor (creates), the workflow driver (status), the AI results handler (analysis columns), the approval endpoint, the RCA handler.
- **Read by:** everything. The dashboard shows it. The AI is given it. The correlation check queries it.

---

## 5. `incident_events` — the nurse's running notes

### What it is
**A log of every step an incident goes through, with a timestamp.** It's append-only — rows are added, never changed or deleted.

Where `incidents` says *"the patient is currently in surgery,"* this table says *"admitted at 10:32, X-rayed at 10:35, surgeon called at 10:40, surgery began at 10:45."*

### Why it has to exist — this is the most important table to understand

It is **four things at the same time**:

**1. The timeline on the dashboard.** The "Agent Activity" panel that shows *"10:32:16 Incident detected → 10:32:17 AI analysis started → 10:32:28 Proposes RESTART_CONTAINER…"* is this table, read top to bottom.

**2. The audit trail.** Who did what and when. *"Approved by operator priya at 10:32:40."*

**3. The input to the RCA report.** This is the one people miss.

When the AI writes the postmortem, we don't give it a vague description. We give it **this table**, for that incident, as a list:

```
10:32:16  DETECTED            container exited, exit code 137, OOMKilled
10:32:17  TRIAGING            AI analysis requested
10:32:28  AWAITING_APPROVAL   RESTART_CONTAINER proposed, confidence 0.94 < 0.95
10:32:40  EXECUTING           approved by operator "priya"
10:32:43  VERIFYING           start time changed, container running
10:32:50  (check)             health endpoint returned 200
10:32:56  RESOLVED            memory 78 MB / 256 MB, stable
```

Give an LLM a vague prompt and you get vague, generic prose. Give it *that* and you get something that reads like a real postmortem — because it has real timestamps, real reasons, and real names to work with.

**Report quality is set by input quality, not by clever wording.** This table is the input.

**4. How we debug a workflow that went wrong.** If an incident gets stuck, this table tells you exactly where and why.

### The columns

| Column | What it means |
|---|---|
| `id` | Auto-number. Also used to keep events in order when two have the same timestamp. |
| `incident_id` | Which incident. Points at `incidents.id`. Delete the incident and these rows go too. |
| `at` | When. |
| `status` | The status the incident *became* at this moment. `NULL` for informational lines that didn't change status (like a health-check result). |
| `actor` | Who caused it. `monitor`, `system`, `ai`, or a person's name like `priya`. |
| `message` | What happened, in a sentence. This is the text shown on screen and given to the RCA agent. |
| `detail` | Extra structured data as JSON — exit codes, confidence numbers, whatever's useful. |

### One thing that's automatic
**Every status change writes a row here automatically.** The `transition()` function does it. You cannot change a status and forget to log it — which is exactly what makes the timeline trustworthy. If it's not in this table, it didn't happen.

### Who writes it, who reads it
- **Written by:** `transition()` (automatically on every status change), and anything else with something worth noting — the executor, the verifier, the approval endpoint.
- **Read by:** the dashboard timeline panel, the RCA agent, and you when debugging.

---

## 6. `agent_runs` — the consultant's opinions

### What it is
**One row per call to the AI.** Every time we ask Gemini (or Ollama, or fall back to rules) a question, we record: what we asked, what came back, how long it took, how many tokens it cost, and whether it worked.

### Why it has to exist

**Reason 1 — debugging bad output.** LLMs sometimes return malformed JSON, or JSON that doesn't match the shape we asked for. Without this table you'd see *"analysis failed"* and have no idea why. With it, you open the row and see exactly what the model said. The `raw` column is the whole point.

**Reason 2 — it's a free dashboard panel.** *"This incident used 2,140 tokens across 3 calls, average latency 4.2s, all via Gemini."* That costs nothing to build once this table exists, and it makes the AI's work concrete rather than magical.

**Reason 3 — proving the fallback works.** When you turn off wifi during the demo and the system keeps working, this table is where you show that the `provider` column switched from `gemini` to `rules`.

**Reason 4 — honesty in the report.** You can state real numbers: *"across 47 incidents, Gemini answered 44, the rules fallback handled 3."*

### The columns

| Column | What it means |
|---|---|
| `id` | Auto-number. |
| `incident_id` | Which incident this call was for. |
| `agent` | Which of the four: `triage`, `investigate`, `mitigate`, `rca`. |
| `provider` | Who answered: `gemini`, `ollama`, or `rules` (the no-AI fallback). |
| `model` | The specific model, e.g. `gemini-2.0-flash`. |
| `latency_ms` | How long the call took. |
| `prompt_tokens` | How much we sent. |
| `completion_tokens` | How much came back. Together these give you cost. |
| `output` | The parsed, validated result. JSON. |
| `raw` | **What the model literally said**, before parsing. This is what you read when something goes wrong. |
| `ok` | Did it succeed? |
| `error` | If not, why. |
| `created_at` | When. |

### An important design choice
**Failures are recorded too.** A row with `ok = false` and the raw text is *more* useful than a success — it's the thing you learn from. Never skip logging a failed call.

### Who writes it, who reads it
- **Written by:** the workflow driver, after every AI call, success or failure.
- **Read by:** the token/latency panel in the drawer, the provider pill, and you when debugging.

---

## 7. `actions` — the treatment record

### What it is
**One row per remediation attempt** — every time the system tried to do something to a container. Restart, start, clear cache.

### Why it has to exist

**Reason 1 — refusals are recorded, not just successes.** This is the important one.

When the AI proposes restarting `sre-postgres` — or when a confused user clicks Restart on it — the policy engine refuses. That refusal **gets a row here** with `policy_allowed = false` and the reason. *"We blocked an attempt to restart protected infrastructure"* is a security event worth having on permanent record, and it's a great thing to show during a demo.

**Reason 2 — the circuit breaker.** *"How many times have we restarted `demo-api` in the last hour?"* is a query on this table. After three, we stop trying and escalate to a human — because a service that crashes on startup would otherwise be restarted forever. There's an index (`idx_actions_target_time`) specifically to make that query fast.

**Reason 3 — proving the restart actually happened.** See the two `started_at_*` columns below.

### The columns

| Column | What it means |
|---|---|
| `id` | Auto-number. |
| `incident_id` | Which incident. Can be empty for a manual action from the dashboard. |
| `action_type` | One of the four catalog words. Never free text. |
| `target` | Which container. |
| `requested_by` | `ai-auto` if it ran automatically, or a person's name. |
| `policy_allowed` | Did the policy engine say yes? |
| `policy_reason` | If no, why. *"sre-postgres is protected platform infrastructure."* |
| `started_at_before` | The container's own start time, read from Docker, **before** we acted. |
| `started_at_after` | The same, read **after**. |
| `result` | `success`, `failed`, or `denied`. |
| `error` | If it failed, what Docker said. |
| `verified` | Did verification pass afterwards? |
| `verification` | The details as JSON — health check results, resource readings. |
| `started_at` | When we began. |
| `finished_at` | When we finished. |

### The two start-time columns — a subtle but important idea

A container reports `running` the instant it restarts. But if the restart *silently failed*, the container would still be running — because it never stopped — and it would look identical to a successful restart.

So we read the container's `StartedAt` timestamp from Docker before and after. **If it changed, the restart definitely happened.** If it didn't, something went wrong and we know not to trust the "running" status.

It's one comparison, and it turns "the restart probably worked" into "the restart provably worked."

### Who writes it, who reads it
- **Written by:** the policy engine (the `policy_*` columns, for every request), the executor (the rest).
- **Read by:** the circuit breaker, the dashboard's action history, the RCA agent.

---

## 8. `metrics` — the heart monitor's trace

### What it is
**A reading of every service, every 3 seconds.** CPU, memory, status, health. This is by far the busiest table — roughly 3 rows per second while the system runs.

### Why it has to exist

**Reason 1 — the sparklines.** Those little charts on each service card are the last 40 rows of this table for that service.

**Reason 2 — the AI needs history to diagnose properly.** This is the one that matters.

Look at these two situations:

```
Memory over 60 seconds:

  A leak:                          A spike:
  44% → 61% → 70% → 93% → 98%      44% → 89% → 91% → 52% → 45%
  (climbs, never falls)            (rises, then comes back down)
```

A single reading can't tell them apart — both hit 90%+. But the *shape* over time is unmistakable. A leak needs a restart; a spike may need nothing at all.

The Investigation agent is given the last few minutes of this table so it can see the shape. Without it, the AI is diagnosing from one number, which is guesswork.

### The columns

| Column | What it means |
|---|---|
| `id` | Auto-number. |
| `service` | Which container. |
| `at` | When the reading was taken. |
| `status` | `running`, `exited`, `restarting`. |
| `health` | `healthy`, `unhealthy`, `starting`, or `none` if the container has no healthcheck. |
| `cpu_pct` | CPU percentage. Calculated correctly — see [server.md](server.md) for why that's harder than it sounds. |
| `mem_used` | Bytes in use, **with file cache subtracted**. Without that subtraction every container sits at 90%+ forever. |
| `mem_limit` | The container's memory cap. 268,435,456 for `demo-api` (256 MB). |
| `mem_pct` | `mem_used / mem_limit`. |
| `restart_count` | Docker's count. Note: this only increments via Docker's *automatic* restart policy, not when *we* restart it — which is why `actions` tracks our restarts separately. |

### Keeping it small
At 3 rows/second, this table would hit 250,000 rows a day. We don't need that. A background job deletes anything older than a couple of hours (`METRICS_RETENTION_HOURS` in `.env`). That's a single `DELETE` statement — no partitioning or anything fancy needed at this scale.

### Who writes it, who reads it
- **Written by:** the poller, every 3 seconds, for every service.
- **Read by:** the dashboard (sparklines and current values), the Investigation agent (history), the threshold rules (is CPU sustained above 90%?).

---

## 9. `audit_log` — the security logbook

### What it is
**An append-only list of security-relevant things that happened.** Logins, approvals, rejections, manual actions, policy refusals.

### Why it has to exist
It overlaps a little with `incident_events` and `actions`, and that's intentional. Those tables are organised *per incident*. This one is organised *by time*, across everything, and answers a different question: **"what did people do?"**

*"Show me everything priya did today"* is a query on this table. *"When was the last time anyone tried to touch sre-postgres?"* — same.

It's also what lets you say in your report that the system has an audit trail, and mean it.

### The columns

| Column | What it means |
|---|---|
| `id` | Auto-number. |
| `at` | When. |
| `actor` | Who. A username, or `system`. |
| `action` | What. `LOGIN`, `APPROVE_ACTION`, `REJECT_ACTION`, `POLICY_DENIED`, `MANUAL_RESTART`... |
| `detail` | Anything else useful, as JSON. Which incident, which container, from what IP. |

### Who writes it, who reads it
- **Written by:** the auth layer, the approval endpoints, the policy engine, the manual-action endpoint.
- **Read by:** an admin view (if you build one), and you when something needs explaining.

---

## 10. The life of one incident, across all seven tables

Here's `INC-1024` — the memory leak from the other documents — and which table gets written at each moment:

| Time | What happens | Table written |
|---|---|---|
| 10:32:02 | Poller reads demo-api memory: 70% | `metrics` |
| 10:32:08 | Poller: 93% | `metrics` |
| 10:32:14 | Docker OOM-kills the container | *(nothing yet — we haven't noticed)* |
| 10:32:16 | Poller sees `exited`, inspects, sees exit 137 | `metrics` |
| 10:32:16 | Checks `services.depends_on` — nothing upstream is broken, so this is real | *(read only)* |
| 10:32:16 | **Incident created**, status `DETECTED` | `incidents` + `incident_events` |
| 10:32:17 | Driver picks it up, status → `TRIAGING` | `incidents` + `incident_events` |
| 10:32:17 | Driver reads last 5 min of memory to send to the AI | *(read `metrics`)* |
| 10:32:28 | AI replies: SEV1, memory exhaustion, 0.94, RESTART_CONTAINER | `agent_runs` + `incidents` (analysis columns) |
| 10:32:28 | 0.94 < 0.95, so status → `AWAITING_APPROVAL`, deadline set | `incidents` + `incident_events` |
| 10:32:40 | Priya logs in and clicks Approve | `audit_log` |
| 10:32:40 | Status → `EXECUTING` | `incidents` + `incident_events` |
| 10:32:40 | Policy check: is demo-api labelled `sre.demo`? Yes. Breaker closed? Yes. | `actions` (policy columns) |
| 10:32:41 | Read `StartedAt`, restart, read `StartedAt` again — different | `actions` (start times, result) |
| 10:32:43 | Status → `VERIFYING` | `incidents` + `incident_events` |
| 10:32:50 | Health check returns 200 | `incident_events` |
| 10:32:56 | Memory stable at 30%, verification passes | `actions` (verified) |
| 10:32:56 | Status → `RESOLVED`, `resolved_at` stamped | `incidents` + `incident_events` |
| 10:32:57 | Driver reads the full timeline and sends it to the RCA agent | *(read `incident_events`)* |
| 10:33:01 | Report comes back | `agent_runs` + `incidents` (rca columns) |
| 10:33:01 | Status → `CLOSED` | `incidents` + `incident_events` |

**Seven tables, one story.** Each one recorded the part it's responsible for, and nothing more.

---

## 11. Common questions

**Q: Why not just put everything in the `incidents` table?**
Because some things happen *many times* per incident. One incident has one status, but many timeline entries, several AI calls, and possibly multiple actions. You can't fit "many" into one row without either a mess of JSON or losing data. Separate tables for one-to-many relationships is the whole point of a relational database.

**Q: Why is there both `incidents.status` AND `incident_events.status`?**
`incidents.status` is the *current* value — it gets overwritten. `incident_events.status` is the *value at that moment* — it's never changed. Together they give you both "where is it now?" and "how did it get there?"

**Q: What's the difference between `incident_events`, `actions`, and `audit_log`? They all seem like logs.**
They're organised around different questions:
- `incident_events` — *"tell me the story of INC-1024"*
- `actions` — *"what did we do to containers, and did it work?"*
- `audit_log` — *"what did people do, across everything?"*

Some events land in more than one. An approval writes to `incident_events` (it's part of the incident's story), `audit_log` (a person did something), and `actions` (an action was then taken). That's fine — they serve different readers.

**Q: Why does `metrics` get deleted after two hours but nothing else does?**
Because metrics are only useful *recently*. Nobody needs to know demo-api's CPU at 3:47 last Tuesday. But an RCA report from last Tuesday is exactly what you'd want to keep. Different data, different lifespans.

**Q: Why is `confidence` a number rather than just "sure" / "not sure"?**
Because we compare it to a threshold: auto-approve at 0.95 and above, ask a human below. A model that said 0.94 is telling you something meaningfully different from one that said 0.60, and both are different from 0.99. The number also lets you tune the threshold from `.env` without touching code.

**Q: What does `ON DELETE CASCADE` mean?**
If you delete an incident, everything pointing at it — its events, AI runs, actions — is deleted too. Without it, you'd have orphaned timeline rows referring to an incident that no longer exists. In practice you rarely delete incidents; it's mostly there so `db:reset` works cleanly.

**Q: Where do the table definitions actually live?**
`server/src/db/schema.sql`. It's the single source of truth. Every `CREATE TABLE` is `IF NOT EXISTS`, so running it against an existing database changes nothing — that's what lets the server run it on every startup.

**Q: How do I look at the data directly?**
```bash
docker exec -it sre-postgres psql -U sre -d sre_platform

\dt                                         -- list all tables
\d incidents                                -- describe one table
SELECT id, service, type, status FROM incidents ORDER BY detected_at DESC LIMIT 10;
SELECT at, status, message FROM incident_events WHERE incident_id = 'INC-1000' ORDER BY at;
SELECT service, cpu_pct, mem_pct FROM metrics ORDER BY at DESC LIMIT 5;
\q
```
