# Phase 0 — Environment Setup

**Status: ✅ Complete** · 10 September 2026

> This document explains everything built in Phase 0, why each piece exists, and how it connects to the project's problem statement. Written to be read by someone who wasn't there when it was built.

---

## 1. What Phase 0 was for

Our project claims to be an **autonomous SRE platform**: it watches real services, notices real failures, and fixes them. Before we can write a single line of that platform, we need something for it to *watch* and *fix*.

Phase 0 builds the world that our system will operate on.

Think of it like this: before you can build a hospital, you need patients. Phase 0 creates the patients — small services that we can make genuinely sick, in realistic ways, on demand.

**The one question Phase 0 had to answer:**

> Can we make a container fail *for real* — and can we prove it wasn't faked?

The answer is yes, and section 6 shows the proof.

---

## 2. The physical picture

After Phase 0, this is what exists on the machine:

```
   WINDOWS (your laptop)
   ├── Docker Desktop            ← the thing that runs containers
   ├── Node.js 22                ← for our backend (Phase 2)
   └── Python 3.12               ← for our AI service (Phase 4)

   INSIDE DOCKER
   ├── PLATFORM STACK  (label: sre.platform=true)
   │   └── sre-postgres     :5434    our own database — PROTECTED
   │
   └── DEMO STACK      (label: sre.demo=true)
       ├── demo-api        :3001    the thing we break
       ├── demo-db         :5433    a database it depends on
       └── demo-cache      :6379    a cache it depends on
```

**Four containers, in two groups that must never mix.**

---

## 3. Why two groups? (The most important idea in Phase 0)

Think of a **hospital**:

- `demo-api`, `demo-db`, `demo-cache` are the **patients**. They get sick. We diagnose them. We treat them.
- `sre-postgres` is the **hospital's records room**. Every patient file lives in it.

Now imagine a doctor treating a patient by setting fire to the filing cabinet. That's what happens if we mix the groups.

Here's the concrete danger. One of our demo scenarios is **"the database went down"**, which we test by stopping a database container. But our own incident records also live in a database. If they were the same container:

```
1. AI detects "database is down"
2. AI decides: restart the database
3. Restarting it wipes the record of the incident being handled
4. The system loses its own memory, mid-repair
```

So we separate them by **label**, and in Phase 3 the Action Executor will refuse to touch anything labelled `sre.platform=true`.

### Why labels and not names?

A rule like *"reject any container whose name contains `sre-postgres`"* sounds fine until someone creates a container called `demo-api-backup-sre-postgres`. Names are just text, and text can be crafted.

Labels are different: **we** set them in our own compose files, and the Action Executor reads them live from Docker at the moment it's about to act. Nothing the AI says can change a container's label.

Verified working:

```
docker ps --filter "label=sre.platform=true"   →  sre-postgres
docker ps --filter "label=sre.demo=true"       →  demo-api, demo-db, demo-cache
```

---

## 4. Every file we created, and why

```
Major Project/
└── docker/
    ├── platform.compose.yml      our protected database
    ├── demo.compose.yml          the three crash-test dummies
    └── demo-api/
        ├── Dockerfile            how to build the dummy
        ├── package.json          its dependencies
        └── index.js              the dummy itself, with "break me" buttons
```

---

### 4.1 `docker/platform.compose.yml`

**What it is:** instructions for running our own Postgres database.

**Why it exists separately:** so it can carry the `sre.platform=true` label and live on its own network, completely apart from anything the AI is allowed to touch.

The lines that matter:

```yaml
labels:
  sre.platform: "true"        # ← the Action Executor's hard-stop signal
ports:
  - "5434:5432"               # host 5434 — see the port note below
volumes:
  - sre_pgdata:/var/lib/postgresql/data
```

> **Why 5434 and not 5432?** This machine already runs a **native Windows
> PostgreSQL 17** service on 5432, unrelated to this project. We originally
> published to 5432 as well, and Windows quietly routed our Node connections to
> the *other* Postgres — producing `password authentication failed for user
> "sre"` while `docker exec ... psql` kept working perfectly, because that runs
> inside the container and never touches the host port. Moving to 5434 avoids
> the clash without disturbing the existing install. Full story in Phase1.md §6.

**Why the volume matters:** without it, every `docker compose down` would erase all your incidents and RCA reports. A named volume keeps the data on disk, independent of the container's life.

---

### 4.2 `docker/demo.compose.yml`

**What it is:** instructions for the three services we're going to break.

Two settings in this file look trivial and are absolutely not. **These are the two that make or break the entire project.**

#### Setting 1: `restart: "no"`

```yaml
demo-api:
  restart: "no"
```

By default, Docker restarts crashed containers automatically. That sounds helpful. For us it is fatal, because:

1. The container would never **stay** dead, so our monitoring might never see it fail.
2. The `OOMKilled` flag — our key evidence — **is erased when a container restarts.**
3. If Docker fixes the problem itself, **our AI has nothing left to fix.** The whole demo evaporates.

We want the patient to stay ill until our doctor arrives.

#### Setting 2: `memswap_limit` must equal `mem_limit`

```yaml
mem_limit: 256m
memswap_limit: 256m
```

`mem_limit` caps RAM. But if you set only that, Linux is allowed to move the excess to **swap** (disk). The container then just gets slower and slower — and never dies.

Setting `memswap_limit` to the same value means *"total memory including swap is 256 MB"*, which leaves nowhere to overflow to. The container must die.

> **This one line is the single most common reason memory-leak demos silently fail.** People set `mem_limit`, watch nothing happen, and assume their code is wrong.

#### A smaller detail: why `demo-db` uses port 5433

```yaml
demo-db:
  ports:
    - "5433:5432"    # host 5433 → container 5432
```

Port 5432 on this machine is already taken (by a native Windows PostgreSQL install), and `sre-postgres` uses 5434. Two things cannot publish the same host port. So `demo-db` is 5432 *inside* its container but reachable at **5433** from Windows.

The full port map for this project:

| Host port | What |
|---|---|
| 5432 | Native Windows PostgreSQL 17 — **not ours**, left alone |
| 5433 | `demo-db` — a remediation target |
| 5434 | `sre-postgres` — our platform database, protected |

---

### 4.3 `docker/demo-api/Dockerfile`

**What it is:** the recipe for building our crash-test dummy into a container image.

```dockerfile
FROM node:20-alpine          # small Linux + Node.js
RUN apk add --no-cache curl  # needed by the healthcheck below

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:3001/health || exit 1
```

**Why `HEALTHCHECK` matters more than it looks:** our plan repeatedly reads `State.Health.Status` from Docker. Without a `HEALTHCHECK` instruction, **that field does not exist at all.** Docker only tracks health if you tell it how to check.

This gives us a genuinely useful distinction:

| Situation | Container status | Health status |
|---|---|---|
| Everything fine | running | healthy |
| App frozen but process alive | **running** | **unhealthy** ← only visible with a healthcheck |
| Crashed | exited | — |

That middle row is a real class of failure, and we'd be blind to it otherwise.

---

### 4.4 `docker/demo-api/index.js` — the crash-test dummy

**What it is:** a small web service that does no useful work whatsoever. Its entire purpose is to be broken in realistic ways.

It has two kinds of endpoints:

| Endpoint | Purpose |
|---|---|
| `GET /health` | Says "I'm alive". Used by Docker's healthcheck and, later, by our verification step |
| `GET /debug/leak` | 💥 Memory leak |
| `GET /debug/cpu` | 💥 CPU spike |
| `GET /debug/error` | 💥 Error storm |
| `GET /debug/reset` | Clears all faults |

---

## 5. How the errors are actually generated

**This is the heart of the project, and the part most likely to be questioned by an examiner.**

The critical principle:

> **We create real causes. We let the operating system produce the real consequences.**
>
> We never write "status = crashed" anywhere.

### 5.1 The memory leak

```js
leaked.push(Buffer.alloc(10 * 1024 * 1024, 1));   // 10 MB, every 200 ms
```

We add 10 MB to an array every fifth of a second and never free it. That's a textbook memory leak — the same bug that happens accidentally in real production systems.

**Why `Buffer.alloc` and not a normal JavaScript array?**

This choice is deliberate and it changes the outcome:

- A JavaScript array lives in Node's **internal heap**. Node has its own heap limit and would fail *gracefully* with a JavaScript error. The container would keep running.
- A `Buffer` lives in **external memory**, which counts directly against the container's 256 MB limit. So the **Linux kernel** kills the process instead.

We want the kernel kill, because that's what produces exit code **137** and `OOMKilled: true` — real forensic evidence that we did not invent.

**Why `Buffer.alloc(size, 1)` and not just `Buffer.alloc(size)`?**
Filling it with 1s forces the operating system to genuinely commit the memory pages. An empty buffer might only be reserved, not actually used.

**The full chain:**

```
we call /debug/leak
   ↓
demo-api allocates 10 MB every 200 ms and never frees it
   ↓
memory climbs: 54 MB → 184 MB → 244 MB → 294 MB
   ↓
it crosses the 256 MB container limit
   ↓
the LINUX KERNEL's OOM-killer terminates the process   ← not us
   ↓
container exits, code 137, OOMKilled: true
   ↓
because restart: "no", it STAYS dead, waiting for our AI
```

### 5.2 The CPU spike

```js
const sliceEnd = Date.now() + 40;
while (Date.now() < sliceEnd) Math.sqrt(Math.random());
setImmediate(burnCpu);      // yield, then burn again
```

We do pointless maths in a loop. Real CPU, really busy.

**Why burn in 40-millisecond slices instead of one long loop?**

A single unbroken loop would block Node's event loop completely, so `/health` would stop responding. Docker's healthcheck would then fail and we'd get a **"container unhealthy"** incident — when what we're trying to demonstrate is a **"high CPU"** incident.

By yielding with `setImmediate` between slices, the CPU still reads ~100% but health checks still get answered. We get the failure we actually intended.

*This is the kind of detail worth mentioning in a viva — it shows you thought about what you were simulating.*

### 5.3 The error storm

```js
console.error('ERROR Request timeout after 30000ms');
```

Realistic error messages written to the log at speed. This one *is* the simplest — we're producing log noise for the Investigation agent to read and interpret.

### 5.4 Real dependency failures — no fault injection needed

This is the most elegant one, because it requires no "break me" button at all.

Every 5 seconds, `demo-api` genuinely tries to open a TCP connection to its database and cache:

```js
const db = await checkPort(DB_HOST, DB_PORT);
if (!db.ok) console.error(`ERROR Database connection failed: ${db.err} ${DB_HOST}:${DB_PORT}`);
```

So when you run `docker stop demo-db`, the connection **actually fails**, and a genuine error appears:

```
ERROR Database connection failed: ETIMEDOUT demo-db:5432
```

We didn't print that message because we decided to. We printed it because the connection really timed out.

This also gives us the **alert correlation** scenario for Phase 6: stopping one database causes `demo-api` to start erroring, so a naive system reports *three* incidents when there is really only *one* root cause.

### 5.5 Why the logs are written the way they are

During the leak, `demo-api` logs its own memory usage as it climbs:

```
WARN Heap usage high — rss 214 MB (leaked 160 MB)
WARN Heap usage high — rss 244 MB (leaked 190 MB)
WARN Heap usage high — rss 274 MB (leaked 220 MB)
```

That steady, unbroken climb is precisely what lets the Investigation agent conclude **"this is a leak, not a load spike."** A spike would rise and fall; a leak only rises.

**We designed the logs to contain the evidence that makes good diagnosis possible.** That's a deliberate engineering decision, not an accident.

---

## 6. What we proved (the actual test results)

These are real outputs from the machine, not examples.

### Test 1 — the OOM kill works

Ran `curl localhost:3001/debug/leak?mb=400`, then inspected the container:

```
Running:    false
Status:     exited
ExitCode:   137          ← 128 + 9 = killed by signal 9 (SIGKILL)
OOMKilled:  true         ← Docker confirms it was out of memory
StartedAt:  2026-09-10T17:04:08.825102259Z
FinishedAt: 2026-09-10T17:05:28.245890596Z
```

**Why this matters:** `OOMKilled: true` is set by Docker itself, based on what the Linux kernel reported. There is no way for our code to fake that field. If an examiner asks *"how do we know this isn't simulated?"*, this is the answer — show them this output live.

### Test 2 — the evidence trail is readable

```
WARN Heap usage high — rss 184 MB (leaked 130 MB)
WARN Heap usage high — rss 214 MB (leaked 160 MB)
WARN Heap usage high — rss 244 MB (leaked 190 MB)
WARN Heap usage high — rss 274 MB (leaked 220 MB)
WARN Heap usage high — rss 294 MB (leaked 240 MB)
```

Monotonic, no plateau. Exactly the pattern an AI needs to identify a leak.

### Test 3 — dependency failures are real

Stopped `demo-db`, then read `demo-api`'s logs:

```
INFO Processing batch 1007
INFO Processing batch 1008
ERROR Database connection failed: ETIMEDOUT demo-db:5432
ERROR Database connection failed: ETIMEDOUT demo-db:5432
```

Real TCP timeouts against a container that genuinely isn't there.

### Test 4 — the two groups are cleanly separated

```
PLATFORM (protected): sre-postgres
DEMO (target):        demo-api, demo-db, demo-cache
```

Phase 3's policy engine will filter on exactly this.

### Test 5 — everything recovers

After restarting `demo-api` and `demo-db`, all four containers returned to `healthy`. The environment is repeatable, which matters enormously for rehearsing a demo.

---

## 7. How this connects to the problem statement

Our problem statement says engineers waste time manually handling repetitive incidents, and proposes an AI system that detects, investigates, remediates, verifies, and documents automatically.

Phase 0 builds **the left-hand column** of that promise — the incidents themselves.

| Problem statement says | Phase 0 provides |
|---|---|
| "A Docker container unexpectedly stops" | `restart: "no"` + a real OOM kill |
| "CPU usage becomes abnormally high" | `/debug/cpu`, real CPU load |
| "Memory utilisation becomes critically high" | `/debug/leak` + `memswap_limit` |
| "A database becomes unavailable" | `docker stop demo-db`, real TCP failures |
| "An application generates many errors" | `/debug/error` + real dependency errors |
| "A service is unhealthy though the container runs" | `HEALTHCHECK` in the Dockerfile |

**Every single incident type in our problem statement can now be produced for real, on demand, from a button.**

Our problem statement also insisted on something else — section 25 said:

> *Do not create a fake system where CPU becomes 98 → database value becomes 20 → dashboard says fixed.*

Phase 0 is how we honour that. There is no code anywhere that writes a fake failure state. We allocate memory; Linux kills the process. We stop a container; TCP connections genuinely fail.

Finally, the problem statement demanded strict safety — *"the AI must never have unrestricted access."* Phase 0 lays the foundation with the label separation. The AI cannot touch `sre-postgres` because Phase 3's executor will check labels directly with Docker, and no amount of clever AI output can change what a label says.

---

## 8. Supporting changes outside `docker/`

| Change | Why |
|---|---|
| `server/package.json` — scripts now point at `src/index.js` | They pointed at `index.js`, which doesn't exist. `npm start` would have failed on day one. |
| Installed 12 client packages | Five shadcn UI files were importing `@radix-ui/*`, `recharts`, and `react-day-picker` — **none of which were installed.** The app only started because nothing imported them yet. The first `import { Button }` would have broken the dev server. |
| `~/.wslconfig` created | Caps WSL at 6 GB with `autoMemoryReclaim=gradual`. This machine has 15.6 GB with only ~3 GB free; without a cap, WSL can claim ~7.8 GB and not give it back. **Applies after `wsl --shutdown`.** |
| `client/src/App.jsx` | Temporary smoke test importing four shadcn components. Build passed with exit 0, proving every dependency resolves. Replaced by the real dashboard in Phase 2. |

---

## 9. Useful commands

```bash
# Start everything
docker compose -f docker/platform.compose.yml up -d
docker compose -f docker/demo.compose.yml up -d

# See what's running
docker ps

# Break things
curl "http://localhost:3001/debug/leak?mb=400"
curl "http://localhost:3001/debug/cpu?seconds=30"
curl "http://localhost:3001/debug/error?seconds=60"
docker stop demo-db

# Look at the evidence
docker inspect demo-api --format '{{.State.ExitCode}} {{.State.OOMKilled}}'
docker logs demo-api --tail 20

# Fix things
docker start demo-api
docker start demo-db
curl "http://localhost:3001/debug/reset"

# Stop everything
docker compose -f docker/demo.compose.yml down
docker compose -f docker/platform.compose.yml down
```

---

## 10. What Phase 1 does next

Phase 0 built the patients. Phase 1 builds the **filing system**:

- The 6 database tables (incidents, timeline, actions, agent runs, audit log, services)
- The **action catalog** — the fixed list of things the AI is ever allowed to propose
- The **guarded state machine** — one function that all status changes must go through

Nothing visible happens in Phase 1. It's the foundation everything else is checked against, and it's deliberately built *before* any AI code exists — so the AI is designed around what we can safely execute, rather than the other way round.
