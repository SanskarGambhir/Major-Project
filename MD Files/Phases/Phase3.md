# Phase 3 — Execution and Verification

**Status: ✅ Complete · Milestone 3 reached** · 19 September 2026

> Phase 2 could **see** and **notice**. Phase 3 lets it **act** — and, more importantly, lets it **refuse** to act, and **prove** that an action worked.

---

## 1. What Phase 3 was for

Until now, when a container died, the dashboard showed a red card and an incident — and then waited for a human to type `docker start` in a terminal. Phase 3 puts the fix inside the system:

1. A **policy engine** decides whether an action is allowed — checked against Docker itself, at the moment of the decision
2. An **executor** performs the action — the only file in the project that changes a container as a fix
3. A **verifier** proves the fix worked — not "Docker said OK" but "the app is answering again, and here's how many seconds it took"
4. The incident walks `EXECUTING → VERIFYING → RESOLVED` on screen, with every step on record
5. A **Restart button** on every card, including the protected one — so a refusal can be watched happen

The most important idea in this phase:

> **A refusal is a result, not an error.** It gets a database row, an audit entry, and a red toast on screen — the same treatment as a success.

---

## 2. What we built

```
server/src/
├── actions/
│   ├── policy.js            ← THE GATE. Six checks; labels read live from Docker
│   └── executor.js          ← the only file that mutates Docker as a remediation
├── verification/
│   └── verify.js            ← proof (StartedAt) → health → resources settled
├── workflow/
│   └── remediate.js         ← execute + verify + walk the incident through states
└── routes/
    ├── actions.js           ← POST /api/actions   (202 → outcome via socket)
    └── simulate.js          ← POST /api/simulate/:scenario  (fault injection)

client/src/
├── hooks/useActions.js      ← fire an action, track its stage, own the toasts
├── components/
│   ├── ServiceCard.jsx      ← + RestartButton (Restarting… → Verifying…)
│   └── ServiceGrid.jsx      ← + Restart on the PROTECTED card too, on purpose
└── pages/Dashboard.jsx      ← + <Toaster>
```

Also: `transitions.js` now allows `DETECTED → EXECUTING` and `REMEDIATION_FAILED → EXECUTING` — the **manual** paths, for an operator who clicks Restart before the AI has looked, or retries after a failure.

---

## 3. The policy engine — six checks, read from Docker, not from a list

**File: `server/src/actions/policy.js`**

Every action passes through `checkPolicy(action, target)` before anything happens. Six checks, in order; the first "no" wins:

| # | Check | Refusal code | Why it exists |
|---|---|---|---|
| 1 | Is the action in the catalog? | `UNKNOWN_ACTION` | The AI can only pick from four words |
| 2 | Does the container exist? | `NO_SUCH_CONTAINER` | Can't act on a ghost |
| 3 | **Is it labelled `sre.platform=true`?** | `PROTECTED_TARGET` | **The critical one** — our own database is never a target |
| 4 | Is it labelled `sre.demo=true`? | `NOT_A_MANAGED_TARGET` | We have no authority over anything else on the machine |
| 5 | Does this action allow this target? | `WRONG_TARGET_FOR_ACTION` | `CLEAR_DEMO_CACHE` only makes sense on `demo-cache` |
| 6 | Restarted 3+ times this hour? | `CIRCUIT_BREAKER` | A fix that keeps needing to be re-applied isn't a fix |

### 3.1 Why we ask Docker, not a list

We could keep a list of "safe names" in code. We don't. Names can be crafted: a container called `demo-api-2` isn't in our compose file; a container called `sre-postgres` could in theory be renamed. **The label on the container is set by the compose file and cannot be influenced by the AI, by logs, or by a request body.** So we `inspect` the container at the moment of the decision and read the labels off it. Nothing else counts.

### 3.2 Why the platform check comes before the demo check

A container carrying **both** labels (misconfiguration, or malice) must be refused. Checking "is it protected?" first makes that the default outcome.

### 3.3 All four refusals we tested

```
DENIED RESTART_CONTAINER on sre-postgres — sre-postgres is a platform container (sre.platform=true)
                                           and can never be a remediation target
DENIED RESTART_CONTAINER on ghost        — container "ghost" does not exist
DENIED CLEAR_DEMO_CACHE  on demo-api     — CLEAR_DEMO_CACHE is only allowed on demo-cache, not demo-api
DENIED RESTART_CONTAINER on demo-api     — demo-api has already been restarted 3 times this hour (limit 3);
                                           a human needs to look
```

Each is a row in `actions` with `result = 'denied'` and the reason in plain words. Anyone can query "every time the system refused to do something and why."

---

## 4. The executor — one file, one job

**File: `server/src/actions/executor.js`**

The only place a remediation changes a container. That's a checkable claim: every Docker mutation in this file sits behind `checkPolicy()`.

What one execution looks like:

```
1. INSERT an actions row              ← even if we end up refusing
2. checkPolicy()                      ← no? record reason, emit policy.denied, stop
3. inspect → StartedAt BEFORE
4. the Docker call                    ← restart / start / exec, from the catalog
5. inspect → StartedAt AFTER
6. UPDATE the row: success or failed
```

### 4.1 Steps 3 and 5 are the clever part

`docker restart` returning 204 tells you the request was **accepted**. It does not tell you the process was replaced. If the restart silently didn't happen, a "success" and a "failure" look identical from the outside.

`StartedAt` is the container's boot timestamp. If it changed, the restart **provably** happened. Here's a real one:

```
[executor] RESTART_CONTAINER on demo-api ok
           (StartedAt 2026-09-19T15:12:15Z → 2026-09-19T15:16:02Z)
```

Both values go into the `actions` row (`started_at_before`, `started_at_after`), where the RCA agent can quote them.

### 4.2 The command never comes from the request

For `CLEAR_DEMO_CACHE`, the executor runs `['redis-cli', 'FLUSHALL']` — an array that lives in `catalog.js`. Nothing in the HTTP body, the AI output, or the container logs can change what gets executed. The request supplies a **word**; our code supplies the **command**.

### 4.3 One action per container at a time

An in-memory set blocks a second action on a target that already has one running. A double-clicked Restart, or two operators clicking at once, gets `409 Conflict` — one restart happens, not two.

---

## 5. Verification — "did it actually work?"

**File: `server/src/verification/verify.js`**

A container reports `running` instantly. The Node app inside needs several more seconds to bind its port. Mark the incident resolved on `running` and you will regularly declare victory over a service that's still down.

Three checks, in order:

| Step | What it checks | How |
|---|---|---|
| 1. **Proof** | The restart actually happened | `StartedAt` changed (skipped for cache flush — nothing restarts) |
| 2. **Health** | The app is answering | Poll `/health` with growing gaps — 2s, 3s, 5s, 8s, 12s — ≈30s ceiling. No health URL? Use Docker's own HEALTHCHECK |
| 3. **Settled** | It's not immediately in trouble again | Wait 6s, then CPU < 90% and memory < 90% |

Every step is recorded with a timestamp. Here's the real evidence from INC-1009:

```json
[
  { "step": "started_at_changed", "ok": true, "at_ms": 7,
    "before": "2026-09-19T15:12:15.804Z", "after": "2026-09-19T15:16:02.492Z" },
  { "step": "health",             "ok": true, "at_ms": 2040,
    "via": "http", "detail": "http://localhost:3001/health → 200" },
  { "step": "resources_settled",  "ok": true, "at_ms": 9475,
    "cpu_pct": 1.6, "mem_pct": 4.5 }
]
```

**Why the growing gaps:** a fast service is confirmed in 2 seconds; a slow one gets 30. Fixed 1-second polling would hammer a service that's still booting and still cap out at the same ceiling.

**The two health paths, both tested:**

- `demo-api` has `health_url` → HTTP, confirmed in **2.0 s**
- `demo-db` has none → Docker HEALTHCHECK; first poll said `starting`, resolved at **~21 s** when Postgres reported `healthy`

---

## 6. remediate() — the glue, shared with Phase 4

**File: `server/src/workflow/remediate.js`**

The executor does Docker. The verifier checks health. The state machine records status. None of them know about each other. `remediate()` is the one function that connects them:

```
claim the incident   →  transition(EXECUTING)      ← this IS the lock
execute()            →  denied?   transition(REMEDIATION_FAILED, "Refused: reason")
                        failed?   transition(REMEDIATION_FAILED)
                        success?  transition(VERIFYING)
verify()             →  ok?       transition(RESOLVED, "healthy 2.0s after RESTART_CONTAINER")
                        not ok?   transition(REMEDIATION_FAILED, "Verification failed: reason")
```

**Phase 4's AI driver calls this same function.** A human-triggered fix and an AI-triggered fix leave identical evidence, walk the same states, and get verified the same way. The only difference is `requested_by`.

**The claim is the lock.** `transition(EXECUTING)` uses Phase 1's guarded SQL. If two operators click at once, exactly one gets the row back; the other gets `null` and stops. No mutex, no queue.

---

## 7. The two routes

### `POST /api/actions`

```json
{ "action": "RESTART_CONTAINER", "target": "demo-api" }
```

Responds **202 Accepted** the instant the request is valid, then does the work in the background. Execution takes a few seconds and verification up to 30 more — nobody should hold an HTTP request open for that. The outcome reaches the browser over the socket:

| Event | When | Carries |
|---|---|---|
| `action` | Every stage: `executing`, `executed`, `verifying`, `verified`, `failed`, `denied` | The action row + stage |
| `policy.denied` | On refusal | action, target, code, reason |
| `incidents` | Every transition (already existed) | The full list |

If there's an open incident on the target, the action links to it automatically — that's what makes the six dots move.

### `POST /api/simulate/:scenario`

Fault injection: `cpu`, `leak`, `error`, `stop`, `db-down`, `reset`. The server side of Phase 6's ScenarioRunner buttons.

**This is not remediation and does not go through the policy engine** — it makes things worse, not better. But it still refuses to touch anything not labelled `sre.demo=true`, for the same reason: "stop" must never be pointed at `sre-postgres`, even by us.

`reset` is the one that saves a demo: restarts `demo-api` (a fresh process has no leak, no burn, no error storm) and starts anything that's stopped. One call, everything green.

---

## 8. The dashboard

### 8.1 The button's spinner follows the socket, not the HTTP call

```
click  →  "Requesting…"  →  "Restarting…"  →  "Verifying…"  →  Restart
           (HTTP 202)       (action: executing)  (action: verifying)  (action: verified)
```

The server says 202 the instant it accepts the request. The restart hasn't happened yet. If the button re-enabled on 202, you'd be able to click it again mid-restart. So `useActions` keeps a stage per target, advances it on each `action` event, and only clears when the socket says finished. **The click is a request, not a result.**

### 8.2 Show the button on the protected card

The Restart button is on the `sre-postgres` card too, deliberately. Clicking it produces:

```
🔴 Action blocked: sre-postgres is a platform container (sre.platform=true)
   and can never be a remediation target
   Restart container on sre-postgres · PROTECTED_TARGET
```

Restarting the protected database on stage and watching it get blocked, in red, with the reason, proves the entire safety model in about three seconds and without a word of explanation. Hiding the button would prove nothing.

### 8.3 Red toast, not a log line

Refusals go to `toast.error()` with an 8-second duration and the code as a subtitle. Successes get a green toast with the recovery time: *"Restart container on demo-api verified — healthy after 2.0s"*. Failures name the reason.

---

## 9. What we proved — Milestone 3

**The full loop, on a real incident:**

```
15:15:56  DETECTED    monitor    Incident detected on demo-api: CONTAINER_EXITED
15:16:02  EXECUTING   priya      RESTART_CONTAINER on demo-api requested by priya
15:16:02  VERIFYING   executor   RESTART_CONTAINER on demo-api executed — checking the service actually recovered
15:16:12  RESOLVED    verifier   Verified: demo-api healthy 2.0s after RESTART_CONTAINER
```

13 seconds from click to **Resolved**, all six dots filled, every step recorded with who did it.

**Also verified:**

- All four policy refusals, each with a row in `actions` and the reason in plain words
- Circuit breaker: the 4th restart in an hour refused with `CIRCUIT_BREAKER`
- Docker-HEALTHCHECK verification path on `demo-db` (no health URL)
- `simulate/db-down` and `simulate/reset` working
- Button stages visible on screen: Restarting… → Verifying… → released
- Red refusal toast on the protected card
- Phase 1's 36 checks still pass after the transitions change

---

## 10. How this connects to the problem statement

| Problem statement asked for | Phase 3 delivers |
|---|---|
| Allowlisted remediation only | `policy.js` check 1 + the catalog; unknown actions are refused before Docker is touched |
| Never touch platform infrastructure | Check 3 — labels read live from Docker, platform checked before demo |
| No arbitrary command execution | The exec command lives in `catalog.js`; the request supplies a word |
| Verify recovery, don't assume it | `verify.js` — StartedAt proof, health polling, resource settle |
| Maximum remediation attempts | Check 6 — 3 restarts an hour, then a human |
| Action audit logging, including refusals | Every attempt is an `actions` row + an `audit_log` row, denied ones included |
| Human-visible safety | The refusal toast, and the button on the protected card that triggers it |

---

## 11. Commands

**Restart from the terminal** (same as clicking the button):

```bash
curl -X POST localhost:3000/api/actions -H "content-type: application/json" -d "{\"action\":\"RESTART_CONTAINER\",\"target\":\"demo-api\"}"
```

**Watch it get refused:**

```bash
curl -X POST localhost:3000/api/actions -H "content-type: application/json" -d "{\"action\":\"RESTART_CONTAINER\",\"target\":\"sre-postgres\"}"
```

**Break things** (same as the terminal commands from Phase 2, but one URL):

```bash
curl -X POST localhost:3000/api/simulate/cpu        # 60s CPU burn
curl -X POST localhost:3000/api/simulate/leak       # OOM in ~15s
curl -X POST localhost:3000/api/simulate/stop       # stop demo-api
curl -X POST localhost:3000/api/simulate/db-down    # stop demo-db
curl -X POST localhost:3000/api/simulate/reset      # everything back to green
```

**See the evidence:**

```bash
curl localhost:3000/api/actions                     # every attempt, newest first

docker exec -it sre-postgres psql -U sre -d sre_platform
SELECT id, action_type, target, result, policy_reason, verified,
       verification->>'recovery_ms' AS recovery_ms
  FROM actions ORDER BY id DESC LIMIT 10;
```

**If the circuit breaker is in your way while testing** — it counts successful restarts in the last hour, so after three you'll get `CIRCUIT_BREAKER` for the rest of the hour. To reset it:

```bash
docker exec sre-postgres psql -U sre -d sre_platform -c "DELETE FROM actions WHERE target='demo-api' AND result='success'"
```

Or raise `MAX_RESTARTS_PER_HOUR` in `server/.env`.

---

## 12. What Phase 4 does next

Phase 3 can act when a **human** clicks. Phase 4 lets the **AI** decide what to click — 3 days:

- The Python FastAPI service: `triage → investigate → mitigate` as a LangGraph
- Gemini → Ollama → rules fallback ladder, so the demo survives no wifi
- Pydantic output shapes generated from the catalog — the AI returns one of four words
- `workflow/driver.js` in Node: finds `DETECTED` incidents, gathers evidence, calls the AI, then calls the same `remediate()` from this phase
- `IncidentDrawer` + `AgentTimeline` on the dashboard, so the AI's reasoning is visible

**Milestone 4:** a real incident gets a real, specific root cause from Gemini — and with wifi off, still gets triaged via rules, with the provider pill showing grey.
