# Phase 2 — Monitoring and Detection

**Status: ✅ Complete · Milestone 2 reached** · 14 September 2026

> Phase 0 built the patients. Phase 1 built the filing system. Phase 2 builds the **nurse who walks the ward every 3 seconds** — and the screen on the wall that shows what she finds.

---

## 1. What Phase 2 was for

This is the first phase where something **visible** happens. Before it, we had containers that could break and a database that could store incidents, but nothing connecting the two. After it:

1. The server asks Docker "how is everyone?" every 3 seconds
2. It turns Docker's raw numbers into real CPU % and memory %
3. It decides when a reading counts as a **problem**
4. It decides whether that problem deserves a **new incident** (or is a duplicate, or a symptom of something else)
5. It pushes everything to a live dashboard in your browser

The plan called this "the biggest and most important phase" and said:

> **This alone is a passing project. Everything after this is upside.**

It is now done.

---

## 2. What we built

```
server/src/
├── docker/
│   ├── client.js            ← the ONE connection to Docker, with a timeout
│   ├── stats.js             ← raw counters → CPU % and memory %  (the two traps)
│   └── logs.js              ← container logs, cleaned of hidden binary headers
├── monitoring/
│   ├── rules.js             ← "is this reading bad?"           (5 incident types)
│   ├── shouldFire.js        ← "is it bad enough for a NEW incident?" (4 checks)
│   └── poller.js            ← the 3-second heartbeat that ties it all together
├── realtime/
│   └── socket.js            ← pushes live updates to the browser
├── app.js                   ← the REST routes
└── index.js                 ← startup: DB → Docker → HTTP → poller

client/src/
├── lib/
│   ├── socket.js            ← THE socket. Created once. Read the comment.
│   ├── api.js               ← REST calls, named
│   └── format.js            ← "238 MB", "4m 12s", severity colours — defined once
├── hooks/
│   ├── useSocketEvent.js    ← subscribe to one event, unsubscribe cleanly
│   ├── useConnection.js     ← are we connected?
│   ├── useMetrics.js        ← latest reading + 40-point history per service
│   └── useIncidents.js      ← the incident list (3 lines of logic)
├── components/
│   ├── Header.jsx           ← title, Live/Disconnected pill, dark-mode toggle
│   ├── StatsRow.jsx         ← the five big numbers
│   ├── ServiceGrid.jsx      ← left column + the locked "Protected" section
│   ├── ServiceCard.jsx      ← one container: state, CPU, memory, sparkline
│   ├── Sparkline.jsx        ← the little memory line (15 lines of Recharts)
│   ├── IncidentPanel.jsx    ← right column: active, then recent, plus empty state
│   ├── IncidentCard.jsx     ← one incident
│   └── WorkflowStages.jsx   ← the six dots. THE component that shows the workflow.
├── pages/
│   └── Dashboard.jsx        ← puts it all together
└── App.jsx                  ← just renders Dashboard (login comes in Phase 5)
```

Two new server packages: `dockerode` (talks to Docker) and `socket.io` (talks to the browser).

---

## 3. How a reading is made — and the two traps

Every 3 seconds, for every container carrying one of our labels, the poller builds one plain object called a **reading**:

```js
{
  service: 'demo-api',
  status: 'running',        // or 'exited'
  health: 'healthy',        // from the HEALTHCHECK in the Dockerfile
  cpu_pct: 1.2,
  mem_used: 19922944,       // bytes
  mem_limit: 268435456,     // 256 MB, from docker-compose
  mem_pct: 7.4,
  exit_code: 0,
  oom_killed: false,
  started_at: '2026-09-14T05:10:44Z',
  ...
}
```

That looks simple. Getting `cpu_pct` and `mem_pct` right is where most monitoring projects quietly go wrong. Docker does **not** hand you percentages — it hands you raw counters and leaves the maths to you.

### Trap 1 — CPU needs two samples

Docker reports "total nanoseconds of CPU this container has ever used." To get a percentage you compare **two** readings:

```
cpu %  =  (container CPU now − container CPU last time)
          ────────────────────────────────────────────  × number of cores × 100
          (system CPU now − system CPU last time)
```

The very first reading has no "last time". Docker fills the previous values with zeros, and dividing by zero-ish numbers gives you garbage like **4000%**. So:

```js
if (!precpu.system_cpu_usage) return 0;   // no previous sample yet → 0, not garbage
```

### Trap 2 — memory must subtract cache

Docker's `memory_stats.usage` includes **file cache** — pages Linux keeps around "just in case" and will hand back instantly if anyone asks. Count it and every container looks 90%+ full forever, and your memory alerts never stop.

```js
const cache = m.stats.inactive_file;   // WSL2 uses cgroup v2 → this field
const used  = usage - cache;
```

**Proof it works:** `demo-api` reads **19 MB / 256 MB = 7.6%** at idle. Without the subtraction it read over 90%.

### Trap 3 — logs have a hidden header

When a container runs without a terminal (ours do), Docker puts an **8-byte binary header** in front of every log line. Your terminal silently drops those bytes, so `docker logs` looks fine. But paste the raw buffer into an AI prompt and the model sees garbage between every line.

`logs.js` runs everything through `docker.modem.demuxStream()`, which knows the format and strips it. Not used yet — Phase 4's Investigation agent is the consumer — but it's built and tested now so Phase 4 doesn't stall on it.

---

## 4. From reading to incident — two questions, kept separate

This is the most important design decision in the phase. There are **two different questions**, and they live in **two different files**:

| Question | File | Answer |
|---|---|---|
| "Does this reading look bad?" | `rules.js` | A candidate: `{type, severity, message}` or nothing |
| "Should we open a NEW incident about it?" | `shouldFire.js` | `{fire: true}` or `{fire: false, reason}` |

Why separate them? Because you tune them for different reasons. Changing "90% CPU" to "85% CPU" is a threshold decision. Changing "wait 60 seconds after a restart before alerting again" is a noise decision. If they were in one function, every change to one would risk breaking the other.

### 4.1 `rules.js` — five things we can detect

| Type | Fires when | Kind |
|---|---|---|
| `CONTAINER_OOM_KILLED` | status is `exited` **and** `OOMKilled: true` | instant |
| `CONTAINER_EXITED` | status is `exited`, any other reason | instant |
| `CONTAINER_UNHEALTHY` | running but the Docker health check is failing | instant |
| `HIGH_CPU` | CPU ≥ 90% for **every reading in the last 30 s** | sustained |
| `HIGH_MEMORY` | memory ≥ 90% for **every reading in the last 30 s** | sustained |

**Instant vs sustained** is the key idea. A container that has exited is exited — there's nothing to wait for. But a CPU spike lasting two seconds is *normal* (garbage collection, a big request). One lasting thirty seconds is a problem. Without the window you'd raise an incident every time the JIT warmed up.

The sustained check also refuses to fire until it has been *watching* for most of the window. A container that's been up for 3 seconds at 95% CPU (normal at boot) doesn't count.

OOM gets its own type rather than being lumped into "exited" because **the fix and the story are different**. A container the kernel killed for eating memory needs a different root cause than one whose process simply crashed.

### 4.2 `shouldFire()` — the four checks

A rule fires on **every** 3-second poll for as long as the condition holds. An exited container stays exited. Without this file, one dead container would create a new incident every 3 seconds — hundreds in a few minutes.

Four checks, in order. The first "no" wins:

```
1. DUPLICATE    already an open incident for this service + type?      → no
2. COOLDOWN     we fixed this service in the last 60 s?                → no
3. CORRELATED   something this service DEPENDS ON is already broken?   → no (symptom)
4. BREAKER      restarted this 3+ times this hour?                     → no, escalate
                                                                       → otherwise YES
```

Each "no" comes with a **reason**. "Nothing happened" with no reason is the hardest thing to debug at 2 am.

**Check 3 is the one to understand.** When `demo-db` goes down, `demo-api` starts throwing connection errors and looking sick. Restarting `demo-api` fixes nothing. The right move is to fix `demo-db` and let `demo-api` recover on its own. `findBrokenDependency()` looks up the service's `depends_on` list (seeded in Phase 1) and checks for open incidents on those. The plan said to stub this for Phase 6; the seed data already existed so we wrote the real version. Phase 6 adds the panel that makes it *visible*.

### 4.3 What happens on each "no"

| Reason | What we do | Why |
|---|---|---|
| duplicate, cooldown | Nothing. Not even a log line. | Happens every tick; logging it would drown the console |
| correlated | Create the incident, then immediately move it to `SUPPRESSED`, pointing at the root cause | So the dashboard can later say "2 alerts suppressed" — you can't show what you didn't record |
| breaker | Create the incident, move it straight to `ESCALATED` | A human needs to look; the machine has given up |

---

## 5. The poller — one tick, step by step

```
every 3 seconds:
  1. listOurContainers()          ask Docker for everything with our labels
  2. readContainer() × 4          inspect + stats, in parallel
  3. remember()                   keep the last 40 readings per service in memory
  4. emitMetrics()                push to the browser   ← BEFORE the database
  5. persist()                    one INSERT for all readings
  6. detect()                     rules → shouldFire → maybe createIncident
  7. autoResolve()                did any open incident's condition clear?
  8. every 20th tick              delete metrics older than 2 hours
```

Three details worth knowing:

**`Promise.allSettled`, not `Promise.all`.** One container's stats call hanging must not lose the readings for the other three. `allSettled` gives us every success and an error for each failure; we log the failures and carry on.

**Inspect the moment we see `exited`.** `ExitCode` and `OOMKilled` only exist while the dead container still exists. Run `docker compose down` and the evidence is gone. So we capture it immediately and stash it inside the incident's first timeline entry, where nothing can delete it. Here's INC-1004's actual first line:

```
05:18:06  DETECTED  monitor | Incident detected on demo-api: CONTAINER_OOM_KILLED
                            | exit_code: 137, oom_killed: true
```

**Browser first, database second.** The dashboard is told about this tick's readings *before* the metrics table is written. A slow database must never delay the screen. The metrics table exists for charts-after-the-fact and for the AI's "leak or spike?" question — not for liveness.

### 5.1 Auto-resolve — being honest about what fixed it

Some incidents fix themselves before we do anything. A CPU burn ends. Someone runs `docker start` by hand. We must notice — and we must **not** count it as an AI success.

So `autoResolve()` checks every open incident that hasn't started executing yet (`DETECTED`, `TRIAGING`, `AWAITING_APPROVAL`), and if the current reading shows the condition has cleared, moves it to **`AUTO_RESOLVED`** — its own status, distinct from `RESOLVED`.

Once we've *acted* on an incident, this function leaves it alone. Verification (Phase 3) decides the outcome then.

### 5.2 Platform containers: watched, never alerted

`sre-postgres` shows up on the dashboard with its CPU and memory, but it never becomes an incident. Two reasons: it's outside remediation by design, and if it's down we couldn't write the incident row anyway.

---

## 6. Live updates — how the browser learns things

**Rule of thumb:** REST is how the browser *does* things. Socket.IO is how it *learns* things.

Three events go from server to browser:

| Event | When | Carries |
|---|---|---|
| `snapshot` | Once, on connect | The full incident list + latest readings + 40-point history |
| `metrics` | Every 3 s | This tick's readings, all services in one message |
| `incidents` | Whenever anything changes | The **full** incident list |

### 6.1 Why the full list every time

We could send "incident X moved to RESOLVED." But then a delayed "updated" message arriving *after* "resolved" would show a resolved incident as active — and the client would need sequence numbers and reconciliation logic to notice.

With fewer than a hundred incidents on screen, re-sending everything costs nothing and makes that entire class of bug **impossible**. The client's state management is literally:

```js
useSocketEvent('incidents', setIncidents);
```

### 6.2 Why `snapshot` exists

Refresh the browser mid-incident and, without it, you'd see empty panels until the next broadcast — and a sparkline with one dot. `snapshot` hands the newcomer everything the server already knows, so a refresh rebuilds the screen correctly. We tested this by killing and restarting the server: the browser reconnected on its own and the incident list came back intact.

### 6.3 How the state machine talks to the socket without knowing about it

Phase 1's `transitions.js` has a hook: `setBroadcaster(fn)`. Phase 2's `socket.js` plugs `broadcastIncidents` into it at startup. From then on, **every `transition()` call automatically re-broadcasts the list** — `transitions.js` never imports the socket layer, and you can't forget to notify the browser.

---

## 7. The dashboard

```
┌───────────────────────────────────────────────────────────────────┐
│  ⚡ AI SRE Command Center  [demo]                   ● Live   ☾    │  Header
├───────────────────────────────────────────────────────────────────┤
│   3          2          1          1            3                 │  StatsRow
│ Services  Healthy   Warning    Active      Resolved today          │
├─────────────────────────────────┬─────────────────────────────────┤
│  SERVICES                       │  ACTIVE INCIDENTS       1 open  │
│  ┌ demo-api ──── ● Critical ┐   │  ┌ INC-1007  SEV1  Detected ─┐  │
│  │ Killed by kernel · 137   │   │  │ demo-api · Container OOM  │  │
│  │ CPU ▁▁▁▁▁▁▁▁▁▁▁▁  0%     │   │  │ ●○○○○○                    │  │
│  │ Mem ▁▁▁▁▁▁▁▁▁▁▁▁  0%     │   │  │ Detect Analyse Approve... │  │
│  │      ___/\___            │   │  └───────────────────────────┘  │
│  └──────────────────────────┘   │                                 │
│  ┌ demo-cache ┐ ┌ demo-db ──┐   │  RECENT                         │
│  │ ● Healthy  │ │ ● Healthy │   │  INC-1006 · Auto-resolved       │
│  └────────────┘ └───────────┘   │  INC-1005 · Auto-resolved       │
│                                 │                                 │
│  PROTECTED                      │                                 │
│  🔒 sre-postgres  ● Healthy     │                                 │
│  Cannot be modified by          │                                 │
│  automated remediation.         │                                 │
└─────────────────────────────────┴─────────────────────────────────┘
```

### 7.1 The one thing that had to be right first

`client/src/lib/socket.js` creates the socket at **module level** — not inside a component, not inside `useEffect`:

```js
export const socket = io(URL, { ... });   // runs ONCE when the file loads
```

React 19's StrictMode runs every effect **twice** in development to surface bugs. A socket created inside an effect therefore connects twice. Both connections receive every broadcast, both call `setIncidents`, and **every incident appears twice on screen**. It looks exactly like a server bug and isn't.

Verified: the server log shows `client connected (1 total)` — one connection, StrictMode on.

### 7.2 WorkflowStages — the six dots

```
  ●───○───○───○───○───○
Detect Analyse Approve Execute Verify Report
```

Filled = done. Pulsing = where the incident is right now. Empty = not yet.

This is a small component and the most important one for the demo. It's what shows an examiner that this is a **multi-step workflow**, not one AI call. Each dot is a stage the incident genuinely passes through.

Incidents that left the happy path don't pretend. `AUTO_RESOLVED` shows *"Recovered on its own"*. `SUPPRESSED` shows *"Symptom of another incident"*. `ESCALATED` shows *"Handed to a human"*.

### 7.3 Show the protected container — don't hide it

`sre-postgres` appears in its own greyed-out "Protected" section with a lock icon and the line *"Cannot be modified by automated remediation."*

An absent container just looks absent. A **visible** protected container demonstrates the safety model without anyone having to explain it.

### 7.4 The three states people forget

| State | What you see | Why it matters |
|---|---|---|
| Nothing wrong | A tick and *"All services healthy. No active incidents."* | A blank panel in a demo reads as "broken"; a tick reads as "healthy" |
| First second | Grey skeleton cards | Better than a flash of empty layout |
| Server unreachable | Amber banner: *"Connection to the server lost — reconnecting. Numbers on screen may be stale."* | **A silent stale screen must never masquerade as a calm one.** If the server dies mid-demo, the frozen numbers would otherwise look like a perfectly healthy system. |

Also: every number has a unit (`238 MB`, not `238`), severity colours are defined once in `format.js`, dark and light mode both work, and the layout stacks to one column below ~1000 px.

---

## 8. What we proved — Milestone 2, live

### 8.1 Memory leak → real OOM → real incident

```bash
curl "localhost:3001/debug/leak?mb=400"
```

- Memory sparkline climbs; card turns amber, then red
- The Linux kernel kills the process — exit 137, `OOMKilled: true`
- Server log: `INC-1007 CONTAINER_OOM_KILLED on demo-api — Container killed by the kernel (exit 137, OOMKilled)`
- The incident appears on the dashboard **~12 seconds** after the kill, SEV1, red border, first dot pulsing
- `docker start demo-api` → 3 seconds later the card goes green and the incident moves to Recent as **Auto-resolved**

### 8.2 CPU burn → sustained rule → auto-resolve

```bash
curl "localhost:3001/debug/cpu?seconds=75"
```

- Card shows **101% CPU**, amber border, Warning
- For the first 30 seconds: nothing. That's the sustained window working.
- At ~33 s: `INC-1005 HIGH_CPU on demo-api — CPU above 90% for 30s (now 100%)`
- Burn ends at 75 s → CPU drops to 0% → `INC-1005 auto-resolved`

The whole cycle — detect, sustain, fire, recover, auto-resolve — visible on screen with no human involvement. **That is Milestone 2.**

### 8.3 Other things verified

- Exactly one socket connection under StrictMode
- Server killed → amber banner within 3 s; server restarted → reconnects on its own, incident list intact
- Metrics table filling correctly: `demo-api  running  healthy  cpu 0  mem 19 MB  7.6%`
- Light mode, narrow-screen layout

---

## 9. A bug we found and fixed

The first time we triggered an OOM with the dashboard open, the card went red but **no incident appeared** — yet `GET /api/incidents` showed it sitting there in `DETECTED`.

**The cause:** in Phase 1, only `transition()` calls the broadcaster. `createIncident()` writes the row but doesn't change a status, so it never triggered a broadcast. The browser wouldn't hear about a new incident until its first status change — which, until Phase 4's driver exists, is never.

**The fix:** a new `notifyIncidentsChanged()` in `transitions.js`, called from `createIncident()`, `saveAnalysis()` and `saveRca()` — every write that changes an incident *without* changing its status. Phase 4's "the AI's answer just landed" and Phase 5's "the RCA report just landed" would have hit the same bug, so it's fixed once for all three.

**The lesson:** "the browser updates on every status change" is not the same as "the browser updates on every change."

---

## 10. How this connects to the problem statement

| Problem statement asked for | Phase 2 delivers |
|---|---|
| Real-time container monitoring | 3-second poll of real Docker stats, real CPU/memory maths |
| Anomaly and failure detection | 5 incident types; instant rules for crashes, sustained rules for resource pressure |
| Alert de-duplication and noise reduction | `shouldFire()` — duplicate, cooldown, correlation, breaker |
| Alert correlation across dependent services | `findBrokenDependency()` using the seeded dependency graph |
| Live operator dashboard | Socket.IO push, full-list broadcasts, snapshot on connect |
| Workflow visibility | `WorkflowStages` — the six dots on every incident |
| Evidence preservation for RCA | Exit code and OOM flag captured at detection and frozen into the timeline |
| Safety boundary | Platform container shown as protected; never becomes an incident |

---

## 11. Commands

**Start everything, in this order:**

```bash
# 1. Docker Desktop must be running

# 2. Containers
cd docker
docker compose -f platform.compose.yml up -d
docker compose -f demo.compose.yml up -d

# 3. Server  (creates any missing tables on startup — no db:init needed)
cd ../server
npm run dev

# 4. Client
cd ../client
npm run dev
```

Open http://localhost:5173.

**Break things:**

```bash
curl "localhost:3001/debug/cpu?seconds=60"      # HIGH_CPU after 30 s, auto-resolves when it ends
curl "localhost:3001/debug/leak?mb=400"         # OOM kill in ~15 s → CONTAINER_OOM_KILLED
docker stop demo-api                            # CONTAINER_EXITED
docker start demo-api                           # → auto-resolves the incident
```

**Look at the data:**

```bash
curl localhost:3000/api/health                  # is DB + Docker reachable?
curl localhost:3000/api/services                # services with their latest reading
curl localhost:3000/api/incidents               # the list the dashboard shows
curl localhost:3000/api/incidents/INC-1007      # one incident with its full timeline
curl "localhost:3000/api/metrics/demo-api?minutes=5"

docker exec -it sre-postgres psql -U sre -d sre_platform
SELECT at::time, cpu_pct, mem_pct FROM metrics WHERE service='demo-api' ORDER BY at DESC LIMIT 20;
```

**Tune it** (in `server/.env`):

```
POLL_INTERVAL_MS=3000      how often we ask Docker
SUSTAIN_WINDOW_MS=30000    how long CPU/memory must stay high — drop to 8000 for a live demo
COOLDOWN_MS=60000          quiet period after we fix something
MAX_RESTARTS_PER_HOUR=3    circuit breaker
```

---

## 12. What Phase 3 does next

Phase 2 can **see** and **notice**. Phase 3 lets it **act** — 2 days:

- `policy.js` — the five checks before any action runs, including asking Docker for the target's labels *at execution time*
- `executor.js` — the only file in the project that mutates Docker; records `StartedAt` before and after
- `verify.js` — poll `/health` until it answers, prove the start time changed, confirm resources settled
- A Restart button on every service card — including the protected one, so you can watch it get refused
- A red toast when the policy engine says no

**Milestone 3:** click Restart on `demo-api` and watch it execute, verify, and report a real recovery time. Then click Restart on `sre-postgres` and watch it refused, on screen, with the reason.
