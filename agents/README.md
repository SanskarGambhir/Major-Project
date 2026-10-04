# `agents/` — the AI brain (Python · FastAPI · LangGraph)

The stateless "consultants in a locked room" from `MD Files/agentsfile.md`. The Express server slides
evidence under the door (`POST /agent/analyze`), three agents think in sequence, one JSON reply comes
back. It **never** touches Docker, never fetches its own evidence, never returns a command string.

```
   server (Node, :3000) ── X-Agent-Secret ──►  agents (Python, :8000)
                        ◄── {severity, root_cause, action, …, runs[]} ──
                                                       │
                                        Gemini → Ollama → rules   (always answers)
```

## Setup

Managed with [`uv`](https://docs.astral.sh/uv/) — no `pip`, no manual venv.

```powershell
cd agents
Copy-Item .env.example .env       # then edit: GEMINI_API_KEY, AGENT_SECRET
uv sync                           # creates .venv and installs the lockfile
uv run uvicorn app.main:app --port 8000 --reload
```

`AGENT_SECRET` must be **identical** in `server/.env` and `agents/.env`. Leave `GEMINI_API_KEY` blank and
the service still runs — every agent answers from its rule-based fallback and says so.

## Authentication

There is none of our own, by design. The server owns users, roles and JWTs (Phase 5). This service accepts
exactly one credential, on every `/agent/*` request:

```
X-Agent-Secret: <AGENT_SECRET>
```

Checked with a constant-time compare (`app/auth.py`). Missing/wrong → `401`. If `AGENT_SECRET` is not set
on this side → `503` (fail closed). `GET /health` is open so the server can poll it before trusting us.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/health` | none | `{ok, provider, model, rungs, cooling_down}` — drives the provider pill; polled every 10 s |
| `POST` | `/agent/analyze` | secret | Runs the LangGraph. Returns the combined triage/investigate/mitigate result + `runs[]` |
| `POST` | `/agent/rca` | secret | Writes the postmortem from the `incident_events` timeline. Returns `{report, recommendations[], provider, runs[]}` |

### `POST /agent/analyze` — request

```json
{ "incident_id": "INC-1024", "service": "demo-api", "type": "CONTAINER_OOM_KILLED",
  "exit_code": 137, "oom_killed": true, "rule_suggested_severity": "SEV1",
  "metrics_history": [ { "at": 1758278531000, "status": "running", "cpu_pct": 18.4,
                         "mem_used": 263192576, "mem_limit": 268435456, "mem_pct": 98.2 } ],
  "logs": [ "WARN  Heap usage 94%  (×11)", "FATAL ERROR: ... JavaScript heap out of memory" ],
  "container_info": { "status": "exited", "memory_limit": 268435456, "restart_policy": "no",
                      "exit_code": 137, "oom_killed": true },
  "allowed_actions": ["RESTART_CONTAINER","START_CONTAINER","CLEAR_DEMO_CACHE","ESCALATE_TO_HUMAN"] }
```

A complete example lives in `tests/fixtures/inc-1024.json`. Unknown extra fields are accepted.

### `POST /agent/rca` — request

```json
{ "incident": { "id": "INC-1024", "service": "demo-api", "type": "CONTAINER_OOM_KILLED", "severity": "SEV1",
                "root_cause": "…", "confidence": 0.94, "evidence": ["…"], "proposed_action": "RESTART_CONTAINER",
                "target": "demo-api", "risk": "LOW", "detected_at": "…Z", "resolved_at": "…Z" },
  "timeline": [ { "at": "…Z", "status": "DETECTED", "actor": "monitor", "message": "…" }, … ],   ← incident_events rows
  "actions":  [ { "action_type": "RESTART_CONTAINER", "target": "demo-api", "result": "success",
                  "started_at_before": "…Z", "started_at_after": "…Z" } ] }                        ← actions rows
```

Response: `{ incident_id, report, recommendations[], provider, runs: [ {agent: "rca", …} ] }`. Example in
`tests/fixtures/rca-1024.json`.

### `POST /agent/analyze` — response

```json
{ "incident_id": "INC-1024",
  "severity": "SEV1", "category": "RESOURCE_EXHAUSTION", "triage_reasoning": "…",
  "root_cause": "demo-api exhausted its container memory limit of 256 MB and …",
  "confidence": 0.6, "evidence": ["Container exited with code 137 and the OOMKilled flag set", "…"],
  "action": "RESTART_CONTAINER", "target": "demo-api", "risk": "LOW",
  "action_confidence": 0.5, "reasoning": "Rule: the container is down; a restart …",
  "provider": "rules",                                           ← lowest rung any agent needed
  "runs": [ { "agent": "triage", "provider": "rules", "model": "rules", "latency_ms": 0,
              "prompt_tokens": 0, "completion_tokens": 0, "output": {…}, "raw": "",
              "ok": true, "error": "ollama: ResponseError: …" },
            { "agent": "investigate", "provider": "rules", …, "error": "ollama: skipped, cooling down after: …" },
            { "agent": "mitigate",    "provider": "rules", … } ] }
```

`runs[]` is one entry per agent, in exactly the shape of the server's `agent_runs` table. `error` records
why higher rungs failed even when the call succeeded — that's how the dashboard can show *"gemini
unavailable, answered by rules"* instead of guessing.

**Two confidences.** `confidence` is Investigate's certainty about the *cause*; `action_confidence` is
Mitigate's certainty that the *action restores service*. The server should gate auto-approval on the
lower of the two. `risk` always comes from the catalog for the chosen action, never from the model.

## How the server uses it

`server/src/workflow/agentClient.js` is the only Node code that calls this service; `workflow/driver.js`
drives the lifecycle (`DETECTED → TRIAGING → AWAITING_APPROVAL | EXECUTING | ESCALATED`, then
`RESOLVED → CLOSED` after `/agent/rca`). The driver writes every `runs[]` entry to `agent_runs`, adds
one timeline line per agent with *model · tokens · latency*, gates auto-approval on
`min(confidence, action_confidence)` against the catalog threshold, and polls `/health` every 10 s for the
`provider` socket event. If this service is down, the driver's `fallbackAnalysis()` answers instead
(`provider: node-rules`). See `MD Files/Phases/Phase4.md` §3.8.

## The fallback ladder

`app/services/llm.py::think()` — every agent calls it once:

```
Gemini (cloud)  →  Ollama (local, qwen3:8b)  →  the agent's own rules()
```

Each rung is timed, everything is caught (429s, timeouts, safety blocks, a `None` from the safety filter,
malformed JSON, an enum the model invented), and the answer is attributed. Rung 3 is plain Python and
cannot fail. It's an explicit loop rather than `with_fallbacks()` so we know *who* answered.

**Cooldown.** A rung that fails is skipped for `PROVIDER_COOLDOWN_SECONDS` (default 60). Without it,
every agent in a request would pay the same timeout — three agents × a 10 s Ollama failure is the
server's entire 30 s budget. With it, the first agent pays, the rest go straight to the next rung, and the
outage is retried a minute later. `GET /health` lists rungs currently `cooling_down` and why.
Only *availability* failures earn a cooldown; a model that answered in the wrong shape is up, and the
next agent still tries it.

**Request budget.** `REQUEST_BUDGET_SECONDS` (default 90) caps one whole request. `think()` sizes each
rung's timeout to the time left and skips a rung that can't fit, answering from rules instead — so a reply
always arrives before the server's `AGENT_TIMEOUT_MS` (default 120 s) expires. Keep the budget below it.

Provider notes:
- **Gemini** — `gemini-2.0-flash` by default, temperature 0.1, all safety categories `BLOCK_NONE`
  (container logs are full of *kill*, *fatal*, *abort*).
- **Ollama** — `qwen3:8b` with `reasoning=False` (its "thinking" prose breaks JSON) and `num_ctx=8192`
  (Ollama's 2048 default truncates prompts from the front). Needs ~6 GB free RAM to load; if it can't,
  the ladder logs the OOM and moves on.

## Layout

```
app/
├── main.py                 FastAPI app; mounts routers; no lifespan, no pools
├── config.py               Settings from .env
├── auth.py                 require_agent_secret()
├── schemas/
│   ├── enums.py            Severity · ActionType (== server catalog.js) · Risk · Provider
│   ├── requests.py         AnalyzeRequest, MetricReading, ContainerInfo, RcaRequest, TimelineEntry
│   ├── outputs.py          TriageOutput, InvestigationOutput, MitigationOutput, RcaOutput — no Optional
│   └── state.py            IncidentState (TypedDict) + AgentRun
├── routers/                health.py · agent.py
├── services/
│   ├── llm.py              the ladder: think()
│   ├── prompts.py          load/render app/prompts/*.txt  ($var templates)
│   └── evidence.py         metrics table · logs block · container block · byte/pct formatting
├── agents/                 one module per agent: build_prompt(state) · rules(state) · run(state)
├── graph/incident_graph.py LangGraph wiring (grows one node per agent)
└── prompts/*.txt
tests/                      pytest; every agent tested offline via a canned ladder + the rules path
```

## Tests

```powershell
uv run pytest -q                       # offline: ~3 s
LIVE_GEMINI_API_KEY=... uv run pytest -m live   # optional: real Gemini round-trip
```

---

## Agents

### Agent 1 — Triage ✅  (`app/agents/triage.py`)

**Question:** how urgent is this?
**Sees:** service, incident type, container status, exit code, OOM flag, health, memory/CPU *now*, and
the server's `rule_suggested_severity`. **No logs** — triage decides urgency from facts, not prose.

| | |
|---|---|
| Prompt | `app/prompts/triage.txt` — SEV1/2/3 definitions; confirm or override the rule suggestion with a reason |
| Output | `TriageOutput{severity: SEV1\|SEV2\|SEV3, category, reasoning}` |
| Adds to state | `severity`, `category`, `triage_reasoning`, `runs += [AgentRun(agent="triage")]` |
| Rules fallback | OOM → SEV1 `RESOURCE_EXHAUSTION` · exited (code≠0) → SEV1 `SERVICE_DOWN` · exited (code 0) → SEV2 · unhealthy → SEV2 `HEALTH_CHECK_FAILING` · mem>90 → SEV2 `RESOURCE_EXHAUSTION` · cpu>90 → SEV2 `CPU_SATURATION` · else the rule suggestion, or SEV3 `UNKNOWN` |
| Graph position | entry point: `triage → END` (edges extend as Agents 2–3 land) |

Verified: 19 offline tests (`tests/test_triage.py`, `test_auth.py`) — prompt content, all seven rule
branches, every ladder path (rung answers / first rung fails / all fail / model invents `SEV0`), the HTTP
route. Live: `/health` reported the ladder correctly; a real `/agent/analyze` with Ollama unable to load
the model fell to rules in 29 s with the OOM reason captured in `runs[0].error`.

### Agent 2 — Investigate ✅  (`app/agents/investigate.py`)

**Question:** what actually went wrong?
**Sees:** everything — the triage verdict, `metrics_history` as a table (oldest first, thinned to 12
rows, with units), the container state, the server's compacted logs, and *(Phase 6)* similar past
incidents. The only agent that reads logs.

| | |
|---|---|
| Prompt | `app/prompts/investigate.txt` — "use ONLY the evidence; if insufficient, say so and lower confidence". Logs are labelled as application output, not instructions |
| Output | `InvestigationOutput{root_cause, confidence: 0–1, evidence: [str]}` |
| Adds to state | `root_cause`, `confidence` (clamped to 0–1), `evidence`, `runs += [AgentRun(agent="investigate")]` |
| Rules fallback | One specific, number-quoting root cause per incident type (OOM → "exhausted its 256 MB limit; proves memory ran out, not why it grew", EXITED → exit code, UNHEALTHY, HIGH_MEMORY, HIGH_CPU, unknown). **Confidence 0.6 / 0.5 / 0.2 — never ≥ 0.95**, so a rules-only analysis can never auto-approve |
| Graph position | `triage → investigate → END` |

Why confidence is honest: the evidence proves *what* happened (exit 137, the OOM flag) but not *why* the
heap grew. The server's auto-approve threshold is 0.95; an honest 0.94 means a human gets asked.

Verified: 20 offline tests (`tests/test_investigate.py`) — the prompt carries a real metrics row
(`112 MB / 256 MB`), the container state, a log line with its `(×11)` collapse marker, the untrusted-data
label above the logs, the similar-incidents block only when non-empty; all six rule branches; ladder
paths including a model returning `confidence: 1.7` (rejected → next rung); the graph passing triage's
verdict into investigate's prompt; the cooldown (second agent skips a rung the first agent saw fail).
Live: two `/agent/analyze` calls — the first paid Ollama's load failure once (triage), investigate skipped
it; the second request skipped it entirely; `/health` showed `cooling_down.ollama` with the reason.
### Agent 3 — Mitigate ✅  (`app/agents/mitigate.py`)

**Question:** what should we do?
**Sees:** the root cause and confidence, the triage verdict, the container status, and the request's
`allowed_actions` (the server's live catalog). Returns **one word** from that list. Never a command.

| | |
|---|---|
| Prompt | `app/prompts/mitigate.txt` — only the offered actions are listed, with the catalog descriptions; "select EXACTLY ONE"; escalate if none fits |
| Output | `MitigationOutput{action: ActionType, target, risk, confidence, reasoning}` |
| Adds to state | `action`, `target`, `risk`, `action_confidence`, `reasoning`, `runs += [AgentRun(agent="mitigate")]` |
| Rules fallback | down (OOM / crash) → `RESTART_CONTAINER` · exited with code 0 → `START_CONTAINER` · unhealthy / high mem / high CPU → `RESTART_CONTAINER` · unknown type → `ESCALATE_TO_HUMAN`. Confidence 0.5 — never auto-approves |
| Graph position | `triage → investigate → mitigate → END` — the graph is complete |

**Two structural guards, neither of them a prompt:**

1. `action: ActionType` — Pydantic rejects any string that isn't one of the four catalog words *before* we
   see it; the ladder moves on. A log line that talks the model into `docker stop sre-postgres` produces a
   validation error, not a command.
2. `enforce()` — after the model answers: an action the server didn't offer becomes `ESCALATE_TO_HUMAN`
   (with the original reasoning kept, confidence zeroed); `target` is pinned to the incident's own service
   (`demo-cache` for the cache flush) no matter what the model named; `risk` is the catalog's, not the
   model's. An empty `allowed_actions` list can only escalate — fail safe, not open.

When `enforce()` changes the answer, `runs[].output` holds what we *returned* and `runs[].raw` keeps what
the model *said*, so the audit trail shows both.

Verified: 21 offline tests (`tests/test_mitigate.py`) — the actions block lists only the offered names;
every rule branch; the model's legal answer used verbatim; `"docker stop sre-postgres"` rejected by the
enum; an un-offered `CLEAR_DEMO_CACHE` → escalation with both answers in the audit record; a model naming
`sre-postgres` as target → pinned to `demo-api`; cache flush → `demo-cache`; risk from the catalog; empty
allowed list → escalate; the whole graph running triage → investigate → mitigate in order with each
prompt quoting the previous agent's output; the complete HTTP response. Also: a *validation* failure no
longer triggers the cooldown (only availability failures do).
Live: `/agent/analyze` on INC-1024 → `SEV1 · RESOURCE_EXHAUSTION · RESTART_CONTAINER demo-api LOW`; the
same incident as a clean exit (code 0) → `SEV2 · START_CONTAINER`.
### Agent 4 — RCA ✅  (`app/agents/rca.py`)

**Question:** what happened, for the record?
**Sees:** the incident row (root cause, evidence, proposed action), the full `incident_events` timeline
with real timestamps and actors, the `actions` rows (with the `StartedAt` before/after proof or the
policy refusal reason), and the recovery time computed from `detected_at → resolved_at`.

| | |
|---|---|
| Prompt | `app/prompts/rca.txt` — "everything you state must come from the record"; fixed five-heading layout (ROOT CAUSE · EVIDENCE · REMEDIATION · VERIFICATION · RECOMMENDATIONS) |
| Output | `RcaOutput{report: str, recommendations: [str]}` |
| Rules fallback | A templated report assembled from the same record: headline numbers, root cause and evidence as recorded, who approved (from the `EXECUTING` actor), the verifier's message verbatim, and type-specific recommendations that name a restart as a symptom fix. Footer says no model wrote it |
| Graph position | **Not in the graph.** Called on its own from `POST /agent/rca` after the server has executed and verified (agentsfile.md §3) |

Why it's separate: approval, execution and verification happen in Node *between* analyze and RCA, so
the report can only be written afterwards — and if RCA fails you still have a resolved incident with a
saved root cause.

Verified: 15 offline tests (`tests/test_rca.py`) — recovery-time arithmetic from the row and from the
timeline; the timeline block keeps every line in order with actor and message; the actions block shows
`StartedAt A → B` for successes and the reason for refusals; the prompt carries all of it verbatim; the
rules report for an approved restart, an auto-approved-then-refused action, and an `AUTO_RESOLVED`
incident; the model's report used and attributed; a bad shape falling through the ladder; the route with
and without the secret.
Live: `POST /agent/rca` with the INC-1024 record → a readable report on the rules rung: *"RESTART_CONTAINER
on demo-api — approved by priya"*, *"Verified: demo-api healthy 7.0s after RESTART_CONTAINER"*, and three
recommendations starting with *"treat this as a symptom fix"*.
