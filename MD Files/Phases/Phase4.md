# Phase 4 — The AI Service

**Status: 🚧 Code complete · Milestone 4 end-to-end run pending (needs the Docker stacks up)** · 19 September 2026

> Phase 3 can act when a **human** clicks. Phase 4 lets the **AI** decide what to click — and, just as
> importantly, keeps working when the AI can't.

---

## 1. What Phase 4 is for

Until now an incident sits in `DETECTED` until an operator restarts something by hand. Phase 4 adds the
Python service that reads the evidence and proposes a fix, and the Node driver that asks it:

1. **Triage** — how urgent? Confirms or overrides the server's rule-based severity, with a reason
2. **Investigate** — what went wrong? Root cause + confidence + the evidence it rests on
3. **Mitigate** — what should we do? **One of four words** from the action catalog, nothing else
4. **RCA** *(Phase 5.4, built here)* — the postmortem, written from the real `incident_events` timeline
5. **The driver** *(Node)* — finds `DETECTED` incidents, gathers evidence, calls the AI, hands the
   proposal to Phase 3's `remediate()` or to a human

The idea that matters most in this phase:

> **The AI makes the system smarter, not functional.** Gemini → Ollama → rules. Something always answers.

## 2. Decisions taken before writing code

| Decision | Choice | Why |
|---|---|---|
| Package manager | `uv` (`pyproject.toml` + `uv.lock`), not `requirements.txt` | Locked, reproducible, one command (`uv sync`) |
| Auth between Node and Python | Shared secret header `X-Agent-Secret`, constant-time compared | Express owns JWT/roles (Phase 5). Python only needs to know "this is our server". Both `.env.example` files already declared `AGENT_SECRET` |
| Ladder implementation | Explicit loop in `think()`, not `with_fallbacks()` | `agent_runs` needs provider/model/tokens/latency per agent, and the provider pill needs to know who answered |
| Local model | `qwen3:8b` (already pulled) with `reasoning=False` | The docs' `qwen2.5:1.5b-instruct` isn't on this machine; qwen3's thinking mode must be off for JSON output |
| Layout | `routers/ · services/ · agents/ · schemas/ · graph/ · prompts/` | One module per agent, each with `build_prompt · rules · run`, so agents are built and tested one at a time |
| Build order | Triage → Investigate → Mitigate → RCA → Node driver | Each agent's output is the next one's input; the driver needs all of them |

## 3. What is built so far

```
agents/
├── pyproject.toml · uv.lock · .env(.example) · README.md
├── app/
│   ├── main.py · config.py · auth.py
│   ├── schemas/   enums.py · requests.py · outputs.py · state.py
│   ├── routers/   health.py · agent.py           ← GET /health · POST /agent/analyze · POST /agent/rca
│   ├── services/  llm.py · prompts.py · evidence.py
│   ├── agents/    triage.py · investigate.py · mitigate.py · rca.py   ← all 4 ✅
│   ├── graph/     incident_graph.py               ← triage → investigate → mitigate → END  (rca is a separate call)
│   └── prompts/   triage.txt · investigate.txt · mitigate.txt · rca.txt
└── tests/         conftest.py · test_auth.py · test_{triage,investigate,mitigate,rca}.py · fixtures/{inc,rca}-1024.json
```

### 3.1 The gate — `app/auth.py`

One dependency on the `/agent/*` router. Missing or wrong header → `401`. `AGENT_SECRET` unset on the
Python side → `503`, so a misconfigured deployment refuses everything rather than accepting everything.
`/health` is deliberately open: the server polls it every 10 s to drive the provider pill.

### 3.2 The ladder — `app/services/llm.py`

```
think(schema, prompt, agent, rules)
   for rung in [gemini, ollama]:          ← whichever are configured
       try:  parsed, raw = rung.with_structured_output(schema, include_raw=True).ainvoke(prompt)
             return parsed, AgentRun(provider=rung, model, latency, tokens, raw, error=<why earlier rungs failed>)
       except ANYTHING: record why, next rung
   return rules(), AgentRun(provider="rules", error=<everything that failed above>)
```

Every failure mode the docs warn about is one `except`: 429s, timeouts, safety blocks, the
`None`-instead-of-raising quirk, malformed JSON, and a model inventing an enum value (`SEV0`) — Pydantic
rejects it and the ladder moves on.

`AgentRun` is shaped exactly like the server's `agent_runs` table, so the driver will write it verbatim.

**Cooldown (added with Agent 2).** The first live run with two agents showed the problem: Ollama failing
to load the model cost ~10 s, and *each* agent paid it — three agents would eat the server's whole 30 s
`AGENT_TIMEOUT_MS`. Now a rung that fails is skipped for 60 s (`PROVIDER_COOLDOWN_SECONDS`), so one
outage costs one timeout, and `/health` reports `cooling_down: {ollama: "<reason>"}` so the dashboard can
say why the pill went grey. Only availability failures count — a model that answered in the wrong shape
is up, and the next agent still tries it (found by Agent 3's graph test, fixed).

### 3.3 Agent 1 — Triage ✅  `app/agents/triage.py`

Sees basic facts only (no logs). Confirms or overrides `rule_suggested_severity`.

- **Output:** `TriageOutput{severity ∈ {SEV1,SEV2,SEV3}, category, reasoning}`
- **Adds to state:** `severity`, `category`, `triage_reasoning`, one `AgentRun`
- **Rules rung:** seven branches covering every incident type `rules.js` can detect, plus "trust the
  server's suggestion" as the default. Real logic, not a stub.
- **Graph:** entry node. `triage → END` until Agent 2 lands.

**Proved:**

```
uv run pytest -q          →  19 passed, 1 skipped (live Gemini test, needs LIVE_GEMINI_API_KEY)
```

- Prompt carries service/type/exit code/"98.2% of 256 MB"/rule suggestion, and **no** log lines
- All seven rule branches return the expected severity and category
- Ladder: rung answers (attributed, token-counted, raw kept) · first rung fails → second answers, failure
  recorded · every rung fails → rules · model returns `SEV0` → rejected → rules
- HTTP: `401` without the header, `401` with a wrong one, `422` (not `401`) with the right one and an
  empty body — proof the gate opened; `200` with the INC-1024 fixture

**Live run** (no Gemini key; Ollama present but the host had 0.3 GB free RAM):

```
GET  /health          → {"provider":"ollama","model":"qwen3:8b","rungs":{…"ollama":{"reachable":true}}}
POST /agent/analyze   → severity SEV1 · RESOURCE_EXHAUSTION · provider "rules"
                        runs[0].error = "ollama: ResponseError: llama-server reported out-of-memory…"
```

The service answered correctly anyway and said why it couldn't do better — that is Milestone 4's
"turn off the wifi" property, demonstrated by accident. The Ollama rung itself gets re-verified once the
machine has ~6 GB free, or with a smaller model in `OLLAMA_MODEL`.

### 3.4 Agent 2 — Investigate ✅  `app/agents/investigate.py`

The only agent that sees the full evidence: triage's verdict, the metrics history as a table, the
container state, the server's compacted logs (labelled as data, not instructions), and — from Phase 6 —
similar past incidents.

- **Output:** `InvestigationOutput{root_cause, confidence ∈ [0,1], evidence[]}`
- **Adds to state:** `root_cause`, `confidence`, `evidence`, one `AgentRun`
- **Rules rung:** a specific root cause per incident type, quoting the numbers it was given (*"exhausted
  its container memory limit of 256 MB … proves memory ran out, not why it grew"*). Confidence is
  **deliberately 0.6 or lower** — the server auto-approves at 0.95, and fixed if-statements must never
  clear that bar. Tested explicitly.
- **Graph:** `triage → investigate → END`

**Proved:**

```
uv run pytest -q          →  39 passed, 1 skipped
```

- The prompt contains a real metrics row with units and in order (`112 MB / 256 MB` before `251 MB`),
  `exit_code: 137`, `oom_killed: True`, `memory_limit: 256 MB`, the log line with its `(×11)` marker,
  and the untrusted-data label *above* the logs; the similar-incidents block appears only when non-empty;
  missing evidence renders as "(none supplied)" rather than crashing; 40-sample histories are thinned to
  12 rows keeping first and last
- All six rule branches; confidence < 0.95 for every type
- Ladder: attributed answer · `confidence: 1.7` rejected by the schema → next rung · all fail → rules
- Graph: triage's verdict (`SEV2 · CUSTOM_CATEGORY — triage said so`) appears in investigate's prompt
- Cooldown: a rung that fails for triage is skipped by investigate (one call, not two); `/health` shows
  the reason; `PROVIDER_COOLDOWN_SECONDS=0` restores retry-every-time

**Live run** (still no Gemini key; Ollama present but the host can't load `qwen3:8b` — 0.8 GB free RAM,
GPU `cudaMalloc failed`):

```
request 1:  triage       rules   err="ollama: ResponseError: llama-server process has terminated…"
            investigate  rules   err="ollama: skipped, cooling down after: …"
request 2:  triage       rules   err="ollama: skipped, cooling down after: …"     ← fast
            investigate  rules   err="ollama: skipped, cooling down after: …"
GET /health → provider "rules", cooling_down: {ollama: "ResponseError: …cudaMalloc failed: out of memory"}
```

Response now carries `root_cause`, `confidence 0.6` and three evidence lines from the rules rung.

### 3.5 Agent 3 — Mitigate ✅  `app/agents/mitigate.py`

The agent the security model rests on. It sees the root cause and the server's `allowed_actions`, and
returns one word from that list.

- **Output:** `MitigationOutput{action: ActionType, target, risk, confidence, reasoning}`
- **Adds to state:** `action`, `target`, `risk`, `action_confidence`, `reasoning`, one `AgentRun`
- **Rules rung:** the on-call runbook — down → `RESTART_CONTAINER`, clean exit → `START_CONTAINER`,
  degraded → `RESTART_CONTAINER`, unknown → `ESCALATE_TO_HUMAN`; confidence 0.5
- **Graph:** `triage → investigate → mitigate → END`. **`/agent/analyze` is complete.**

**The guards — structural, not prompt wording (agentsfile.md §7):**

| Guard | What it stops | How |
|---|---|---|
| `action: ActionType` enum | `"docker stop sre-postgres"`, `DELETE_EVERYTHING`, anything not one of four words | Pydantic rejects it before we see it; the ladder moves to the next rung |
| `enforce()`: allowed-list narrowing | The model picking a catalog action the server didn't offer on this request | Becomes `ESCALATE_TO_HUMAN`; original reasoning kept, confidence 0 |
| `enforce()`: target pinning | A poisoned log line naming `sre-postgres` as the target | Target is the incident's own service, always (`demo-cache` for the cache flush) |
| `enforce()`: catalog risk | The model calling a restart `NONE` risk | Risk is looked up from the catalog for the chosen action |
| Empty `allowed_actions` | A server that offers nothing | Only escalation is possible — fail safe, not open |

And the server's `policy.js` still reads the container's Docker labels at execution time. Three
independent layers; the AI text never reaches a shell.

**Two confidences.** `confidence` (Investigate: how sure about the *cause*) and `action_confidence`
(Mitigate: how sure the *action restores service*). The driver gates auto-approval on the lower one.

**Proved:**

```
uv run pytest -q          →  60 passed, 1 skipped
```

- Prompt lists exactly the offered actions (always including escalate; unknown server names dropped)
- All seven rule branches
- Every guard above has a test with a hostile payload, plus the audit record keeping both the model's
  answer (`raw`) and the returned one (`output`)
- Whole graph: triage → investigate → mitigate in order, each prompt quoting the previous output
- The complete `AnalyzeResponse` shape over HTTP

**Live run** (rules rung, Ollama still can't load):

```
INC-1024 (OOM)          → SEV1 · RESOURCE_EXHAUSTION · RESTART_CONTAINER demo-api · LOW · action_confidence 0.5
same, exit code 0       → SEV2 · START_CONTAINER demo-api · LOW
runs: triage rules · investigate rules (cooling down) · mitigate rules (cooling down)
```

### 3.6 Agent 4 — RCA ✅  `app/agents/rca.py` · `POST /agent/rca`

Runs after the server has executed and verified — its own endpoint, not a graph node. Input is the
incident row, the exact `incident_events` timeline, and the `actions` rows (with the `StartedAt`
before/after proof, or the policy refusal reason). Recovery time is computed from
`detected_at → resolved_at`, falling back to the timeline's `DETECTED`/`RESOLVED` entries.

- **Output:** `RcaOutput{report, recommendations[]}`; response adds `provider` and one `AgentRun`
- **Prompt:** the record, verbatim, and a fixed five-heading layout. "Everything you state must come
  from the record" — the timeline is what stops it writing generic prose (agentsfile.md §4, 10:32:57)
- **Rules rung:** the same five headings assembled from the record — who approved (the `EXECUTING`
  actor), the verifier's message verbatim, and type-specific recommendations that call a restart a
  symptom fix. Footer says no model wrote it.

**Proved:**

```
uv run pytest -q          →  75 passed, 1 skipped
```

- Recovery arithmetic (row and timeline; `40 seconds`, `2m 05s`, `unknown`)
- Timeline block: every line, in order, with actor; actions block: `StartedAt A → B` or the refusal reason
- The prompt carries the record verbatim (`10:32:40  EXECUTING  priya  RESTART_CONTAINER on demo-api requested by priya`)
- Rules reports for: approved restart · auto-approved then refused by the circuit breaker · `AUTO_RESOLVED`
- Model report used and attributed; a wrong-shape answer falls through the ladder; 401 without the secret

**Live run** (rules rung):

```
INCIDENT REPORT — INC-1024
Service: demo-api     Severity: SEV1     Recovery time: 40 seconds
ROOT CAUSE       Application memory exhaustion. Heap grew steadily from 44% to 98% …
REMEDIATION      RESTART_CONTAINER on demo-api — approved by priya.
VERIFICATION     Verified: demo-api healthy 7.0s after RESTART_CONTAINER (memory 78 MB / 256 MB, stable)
RECOMMENDATIONS  1. …treat this as a symptom fix… 2. Profile demo-api's memory growth… 3. Set restart_policy to 'unless-stopped'…
```

### 3.7 The Python service, summarised

| Endpoint | Agents | Answers with |
|---|---|---|
| `POST /agent/analyze` | triage → investigate → mitigate (LangGraph, one call) | `severity, category, root_cause, confidence, evidence[], action, target, risk, action_confidence, reasoning, provider, runs[3]` |
| `POST /agent/rca` | rca (single call) | `report, recommendations[], provider, runs[1]` |
| `GET /health` | — | `provider, model, rungs, cooling_down` |

Every `runs[]` entry is an `agent_runs` row. Every agent has a rules rung that answers without a network.
The Ollama rung is configured and reachable but has not been exercised end-to-end on this machine (it
cannot load `qwen3:8b` with the RAM/VRAM currently free); Gemini needs a key in `agents/.env`.

### 3.8 The Node side — `server/src/workflow/` ✅ (code) · ⏳ (end-to-end run)

```
server/src/
├── workflow/
│   ├── agentClient.js       ← the ONLY code that talks to Python. fetch + X-Agent-Secret + AbortController
│   │                          timeout. analyze() / rca() / health(). Every failure → null, never a throw.
│   │                          fallbackAnalysis() = Node's own rules rung, for when Python is unreachable.
│   └── driver.js            ← the loop. DETECTED → evidence → analyze → decide → remediate() / approval /
│                              escalate; RESOLVED → rca → CLOSED; expired approvals → ESCALATED;
│                              /health every 10 s → 'provider' socket event
├── routes/incidents.js      ← POST /api/incidents/:id/approve · /reject · GET /:id/runs
├── incidents/store.js       ← + findByStatus · findIncidentsNeedingRca · listActionsFor · saveAgentRun · listAgentRuns
├── app.js                   ← mounts the router; /api/health now reports `agent: {provider, model}`
└── index.js                 ← startDriver() after the poller; stopDriver() on shutdown
```

**One incident through the driver:**

```
poller creates INC-n (DETECTED)
  │
  ├─ driver tick (2 s): claim via transition(TRIAGING)      ← lost race = someone else has it, walk away
  ├─ collectEvidence(): poller ring buffer (or metrics table if just restarted),
  │                     getCleanLogs → compactLogs, inspect → {status, memory_limit, restart_policy,
  │                     exit_code, oom_killed, started_at}, allowed_actions = actionNames(),
  │                     rule_suggested_severity = the detection rule's severity
  ├─ analyze(evidence)  ──►  Python  ──►  result            ← null? fallbackAnalysis(), noted on the timeline
  ├─ saveAgentRun() × runs[]  ·  saveAnalysis()  ·  three timeline lines "Triage: … / Root cause: … / Proposes: …"
  │                                                          each carrying "model · tokens · latency"
  └─ decide():
       ESCALATE_TO_HUMAN                              → ESCALATED
       needsApproval(action, min(confidence, action_confidence)) or risk ≠ LOW
                                                      → AWAITING_APPROVAL + approval_expires_at (5 min)
       otherwise                                      → remediate({requestedBy: 'ai-auto'})   ← Phase 3's path

POST /api/incidents/:id/approve  → approve(): setApprovedBy, remediate({requestedBy: user})   (202, outcome via socket)
POST /api/incidents/:id/reject   → ESCALATED
driver tick: approval_expires_at < now()             → ESCALATED "approval window expired"
driver tick: RESOLVED with no rca_report             → rca(timeline + actions) → saveRca → CLOSED
                                                       (Python down? close anyway with an honest placeholder)
```

**Why the driver reads the database, not memory:** a server restart mid-incident finds the row still in
`DETECTED` or `RESOLVED` and simply carries on (server.md §7). The in-memory `inFlight` set only stops one
process doing the same work twice within a tick; the `transition()` guard is the real lock.

**Why the AI is asked once, with everything:** `collectEvidence()` is the complete answer to "what can the
AI see?" — exactly what's in that object, chosen here, nothing fetched from Python's side.

**Proved without Docker** (Python service live, `server/.env` and `agents/.env` sharing the secret):

```
PASS  health: ok=true provider=ollama model=qwen3:8b
PASS  analyze: severity=SEV1 category=RESOURCE_EXHAUSTION · action=RESTART_CONTAINER target=demo-api risk=LOW
PASS  analyze: confidence=0.6 action_confidence=0.5 · runs[]=triage:rules,investigate:rules,mitigate:rules
PASS  rca: report 1144 chars, 3 recommendations
PASS  wrong secret → 401
PASS  fallbackAnalysis for all six incident types (every one confidence 0.5 → needs a human); clean exit → START_CONTAINER
PASS  needsApproval: rules result → approval · 0.96 LOW → auto-run · cache flush at 0.96 → approval (threshold 0.98)
PASS  full server module graph imports (driver ↔ routes ↔ poller — no circular-import break)
```

**Code review (post-build).** Six findings, all fixed the same day:

| # | Finding | Fix |
|---|---|---|
| 1 | `decide()` ignored `remediate()` declining to start (target busy) → incident stuck in `TRIAGING` | Parks it in `AWAITING_APPROVAL` with the deadline and a timeline line saying why |
| 2 | A throw after the `TRIAGING` claim stranded the incident; nothing re-queued `TRIAGING` | `try/catch` → `ESCALATED` with the error; plus a sweep that escalates any `TRIAGING` row older than `AGENT_TIMEOUT_MS + 60 s` (server died mid-analysis) |
| 3 | `approve()` when the target is busy: `approved_by` set, nothing ran, no explanation | Timeline line + `agent.progress` event; incident stays `AWAITING_APPROVAL` so the operator can approve again |
| 4 | Timeout budgets didn't nest: Python could spend 3 × (20 + 50) s while Node gave up at 30 s | Python now has a per-request budget (`REQUEST_BUDGET_SECONDS=90`): `think()` sizes each rung to the time left and skips rungs that can't fit (→ rules). Node `AGENT_TIMEOUT_MS` default → 120 s. Rung defaults 15 s / 30 s |
| 5 | Any null from `rca()` (even a timeout) closed the incident with a placeholder, never retried | Three attempts with 30 s / 60 s back-off before the placeholder |
| 6 | Provider pill paired the *worst* rung with *triage's* model (`rules (gemini-2.0-flash)`) | Model taken from the run whose provider matches the overall provider |

**Not yet run — Milestone 4 proper.** Needs both compose stacks up (they were not started in this session):

```powershell
docker compose -f docker/platform.compose.yml up -d
docker compose -f docker/demo.compose.yml up -d --build
cd agents ; uv run uvicorn app.main:app --port 8000        # terminal 1
cd server ; npm run dev                                    # terminal 2
curl -X POST localhost:3000/api/simulate/leak              # OOM in ~15 s
curl localhost:3000/api/incidents                          # DETECTED → TRIAGING → AWAITING_APPROVAL
curl localhost:3000/api/incidents/INC-n/runs               # three agent_runs rows
curl -X POST localhost:3000/api/incidents/INC-n/approve -H "x-user: priya"
curl localhost:3000/api/incidents/INC-n                    # … EXECUTING → VERIFYING → RESOLVED → CLOSED, rca_report set
```

Then the wifi test: stop the Python service → the next incident is analysed by `fallbackAnalysis`
(`provider: node-rules` on the pill, "AI service unreachable" on the timeline) and still reaches
`AWAITING_APPROVAL`.

## 4. Next

- **Run Milestone 4** with the stacks up (above)
- Frontend 4.10–4.11: `IncidentDrawer`, `AgentTimeline` (reads the timeline lines + `agent.progress`), `ProviderPill` (reads `provider`)
- Phase 5.1–5.3: `auth/jwt.js` and `requireRole('operator')` in front of `/approve`, `/reject`, `/api/actions`
- Phase 6.3–6.5: ChromaDB memory (`similar_past_incidents` is already plumbed end to end), Ollama rung verified with a model that fits

## 5. Commands

```powershell
cd agents
uv sync
uv run uvicorn app.main:app --port 8000 --reload
uv run pytest -q

# from another shell — $SECRET is AGENT_SECRET from agents/.env
curl localhost:8000/health
curl -X POST localhost:8000/agent/analyze -H "X-Agent-Secret: $SECRET" -H "content-type: application/json" -d @tests/fixtures/inc-1024.json
```
