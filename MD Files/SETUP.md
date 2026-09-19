# Setup Guide — Getting this running on a new machine

> For a teammate setting up the project from scratch. Written for **Windows 11 + PowerShell**; notes for macOS/Linux are included where they differ.
>
> Total time: about 20 minutes, most of it waiting for Docker image downloads.

---

## 1. What you're installing

Three programs will run **directly on your laptop**, and four containers will run **inside Docker**:

```
   ON YOUR LAPTOP                          IN DOCKER
   ├── Node.js backend      :3000          ├── sre-postgres   :5434   our database (protected)
   ├── React dashboard      :5173          ├── demo-api       :3001   crash-test dummy
   └── Python AI service    :8000          ├── demo-db        :5433   a dependency
       (Phase 4 onwards)                   └── demo-cache     :6379   a dependency
```

The three demo containers exist **only to be broken**. `sre-postgres` holds all our real data and is deliberately kept separate — see [Phase0.md](Phases/Phase0.md) for why that separation matters.

---

## 2. Prerequisites

| Tool | Version | Check with |
|---|---|---|
| Docker Desktop | any recent | `docker --version` |
| Node.js | 20 or 22 | `node --version` |
| Python | 3.11+ *(only needed from Phase 4)* | `python --version` |

### Installing Docker Desktop on Windows

1. Download from [docker.com](https://www.docker.com/products/docker-desktop/) and install with the **WSL2 backend** (the default).
2. **Add yourself to the `docker-users` group, then sign out and back in.**

   Skipping the sign-out is the single most common setup failure. It produces:
   ```
   connect EACCES //./pipe/docker_engine
   ```
   which looks like a code bug and isn't. Windows only applies new group membership at login.

3. Confirm it works:
   ```powershell
   docker run --rm hello-world
   ```

### Optional but recommended: cap WSL's memory

Docker's Linux VM will otherwise claim up to half your RAM and not reliably give it back. Create `C:\Users\<you>\.wslconfig`:

```ini
[wsl2]
memory=6GB
processors=4
swap=2GB
autoMemoryReclaim=gradual
```

Apply it with `wsl --shutdown` (this stops Docker, so do it before you start working, not mid-session).

---

## 3. Get the project files

```powershell
# If it's in git:
git clone <repo-url> "Major Project"
cd "Major Project"
```

**If someone sent you a zip instead:** unzip it, then **delete any `node_modules` folders** before continuing. They contain compiled binaries built for the sender's machine and will cause confusing errors:

```powershell
Remove-Item -Recurse -Force server\node_modules, client\node_modules -ErrorAction SilentlyContinue
```

---

## 4. Check for port conflicts — do this before anything else

We need seven ports. Run this to see if any are already taken:

```powershell
foreach ($p in 3000,3001,5173,5433,5434,6379,8000) {
  $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
  if ($c) {
    $proc = (Get-Process -Id $c[0].OwningProcess -ErrorAction SilentlyContinue).ProcessName
    Write-Host "PORT $p IN USE by $proc (PID $($c[0].OwningProcess))" -ForegroundColor Red
  } else {
    Write-Host "port $p free" -ForegroundColor Green
  }
}
```

**Common clashes:**

| Port | Often taken by | What to do |
|---|---|---|
| 6379 | A native Redis install | Change `"6379:6379"` to `"6380:6379"` in `docker/demo.compose.yml` |
| 5433 / 5434 | Another Postgres container | Change the **left** number only |
| 3000 | Another dev server | Change `PORT` in `server/.env` |

**Note on port 5432:** we deliberately don't use it. On the original development machine a native PostgreSQL 17 was already there, and publishing our container to 5432 caused connections to silently reach the *wrong* database. Our platform DB lives on **5434** to sidestep that entirely.

If you change a port, change it in **both** the compose file and `server/.env`.

---

## 5. Create the environment files

`.env` files hold credentials and are **not** committed to git. Each folder ships a `.env.example` template instead — copy each one:

```powershell
Copy-Item server\.env.example  server\.env
Copy-Item client\.env.example  client\.env
Copy-Item agents\.env.example  agents\.env
```

```bash
# macOS / Linux
cp server/.env.example server/.env
cp client/.env.example client/.env
cp agents/.env.example agents/.env
```

Then edit two things:

**1. `server/.env` and `agents/.env` — generate matching secrets.**

`AGENT_SECRET` must be **identical** in both files; it's how the Python service knows a request really came from our backend. Generate one:

```powershell
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

While you're there, generate a `JWT_SECRET` for `server/.env` too:

```powershell
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

**2. `agents/.env` — add your Gemini API key** (only needed from Phase 4).

Get a free one at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). Leave it blank for now if you're only setting up Phases 0–3 — the service falls back to rule-based decisions without it.

> **On macOS/Linux**, also change `DOCKER_SOCKET` in `server/.env` to `/var/run/docker.sock`.

### A warning about `client/.env`

**Everything in it is public.** Vite bakes `VITE_*` variables into the JavaScript bundle at build time, so they ship to the browser and anyone can read them with devtools.

It's gitignored to keep local URLs local, **not** because it can hold secrets. Never put an API key or password there. If the browser needs something secret, it asks our server, and the server holds the secret.

---

## 6. Start the containers

Make sure Docker Desktop is actually running first (the whale icon in your system tray should be steady, not animating).

```powershell
# Our protected database
docker compose -f docker/platform.compose.yml up -d

# The three crash-test dummies (--build compiles demo-api the first time)
docker compose -f docker/demo.compose.yml up -d --build
```

First run downloads a few hundred MB of images — expect 3–5 minutes. After that it's seconds.

Check all four are healthy:

```powershell
docker ps --format "table {{.Names}}\t{{.Status}}"
```

You want to see:
```
NAMES          STATUS
demo-api       Up 30 seconds (healthy)
demo-db        Up 32 seconds (healthy)
demo-cache     Up 32 seconds (healthy)
sre-postgres   Up 1 minute (healthy)
```

If something says `unhealthy` or `restarting`, check its logs: `docker logs demo-api`.

---

## 7. Install dependencies and create the database

```powershell
# Backend
cd server
npm install
npm run db:init        # creates the 7 tables and seeds the service list
npm run verify:phase1  # should report "36 passed, 0 failed"

# Frontend
cd ..\client
npm install
```

`db:init` is **safe to run at any time** — it only creates what's missing and never deletes anything. The server also calls it automatically on startup, so this step is really just to confirm the database is reachable before you go further.

If it fails with `password authentication failed`, jump to §10.

> **To wipe and start over**, the command is `npm run db:reset` — a separate,
> deliberately-named command that lists what you're about to lose and makes you
> type "yes" first. See §12.

---

## 8. Check it actually works

```powershell
# The demo app responds
curl http://localhost:3001/health
# {"ok":true,"uptime":42,"rssMb":54}

# Break it on purpose — this triggers a REAL out-of-memory kill
curl "http://localhost:3001/debug/leak?mb=400"

# Wait ~10 seconds, then look at the forensics
docker inspect demo-api --format 'ExitCode={{.State.ExitCode}} OOMKilled={{.State.OOMKilled}}'
# ExitCode=137 OOMKilled=true      <- this is what you want to see

# Put it back
docker start demo-api
```

If `OOMKilled` comes back `false`, see §10.

---

## 9. Daily routine

**Starting work:**
```powershell
# 1. Launch Docker Desktop (or set it to start at login)
# 2. Bring the stacks up
docker compose -f docker/platform.compose.yml up -d
docker compose -f docker/demo.compose.yml up -d

# 3. Reset the demo services to a clean state
curl http://localhost:3001/debug/reset

# 4. Run the apps (each in its own terminal)
cd server ; npm run dev
cd client ; npm run dev
```

**Finishing:**
```powershell
docker compose -f docker/demo.compose.yml stop
docker compose -f docker/platform.compose.yml stop
```

Use `stop`, not `down`. `stop` pauses the containers; `down` deletes them and you'd need to rebuild.

**Breaking things on purpose:**
```powershell
curl "http://localhost:3001/debug/cpu?seconds=30"     # CPU spike
curl "http://localhost:3001/debug/leak?mb=400"        # memory leak -> OOM kill
curl "http://localhost:3001/debug/error?seconds=60"   # error storm
docker stop demo-db                                    # dependency failure
```

**Putting them back:**
```powershell
curl http://localhost:3001/debug/reset
docker start demo-api demo-db demo-cache
```

---

## 10. Troubleshooting

### `listen EADDRINUSE: address already in use :::3000`
Another copy of the server is already running — usually one left behind in a different terminal, or a crashed nodemon that didn't release the port. Find and stop it:

```powershell
Stop-Process -Id (Get-NetTCPConnection -LocalPort 3000 -State Listen).OwningProcess -Force
```

Then `npm run dev` again. Same command with `5173` if Vite complains.

### `connect EACCES //./pipe/docker_engine`
You're not in the `docker-users` group, **or** you added yourself and didn't sign out. Adding the group alone isn't enough — Windows applies it at login.

### `password authentication failed for user "sre"`
Something other than our container is answering on the port in `DB_PORT`.

The giveaway: this works…
```powershell
docker exec -it sre-postgres psql -U sre -d sre_platform     # works
```
…but Node fails. That's because `docker exec` runs *inside* the container and never touches the host port.

Find the culprit:
```powershell
Get-NetTCPConnection -LocalPort 5434 -State Listen | ForEach-Object {
  (Get-Process -Id $_.OwningProcess).ProcessName
}
```
Then pick a free port and update both `docker/platform.compose.yml` and `server/.env`.

### `Bind for 0.0.0.0:XXXX failed: port is already allocated`
Something else already owns that port. Change the **left-hand** number in the compose file — `"6380:6379"` means "reachable at 6380 on my laptop, still 6379 inside the container."

### The memory leak doesn't kill the container
Check `docker/demo.compose.yml` has **both** lines:
```yaml
mem_limit: 256m
memswap_limit: 256m     # without this it swaps to disk instead of dying
```
With only `mem_limit`, the container gets slow but never gets killed. This is the single most common reason the demo appears not to work.

### `docker: command not found` but Docker Desktop is installed
Docker Desktop isn't running. Launch it and wait for the tray icon to settle.

### Containers keep restarting
Read the logs — `docker logs demo-api --tail 50`. A common cause is a corrupted volume; `docker compose -f docker/demo.compose.yml down -v` deletes the demo volumes and lets you start fresh. **Don't use `-v` on the platform stack** unless you intend to delete all incident data.

---

## 11. Do you need the original developer's data?

**Almost certainly not.** Here's why.

The database holds three kinds of data:

| Data | Where it comes from |
|---|---|
| Services + dependency graph | Seeded by `npm run db:init` — you get this automatically |
| Incidents, timelines, AI runs | **Generated by running the system.** You make your own by breaking things. |
| Metrics | Written every 3 seconds while the backend runs; deleted after a couple of hours |

The whole point of the project is that it produces this data itself. `npm run db:init` gives you a clean, working database, and one `curl` to `/debug/leak` gives you your first real incident.

**So the normal answer is: run `npm run db:init` and you're done.**

---

## 12. If you *do* want to copy the data across

Reasonable cases: reviewing a specific incident someone hit, or copying a set of nicely-worded RCA reports for a report or slide deck.

### On the machine that has the data

```powershell
# --clean --if-exists is ESSENTIAL. Without it the dump contains no DROP
# statements, and restoring into a database that already has tables fails with
# "relation already exists" while silently leaving the old data in place.
docker exec sre-postgres pg_dump -U sre -d sre_platform --clean --if-exists -f /tmp/backup.sql

# Copy the file out. Doing it via docker cp (rather than piping through
# PowerShell) avoids any file-encoding problems.
docker cp sre-postgres:/tmp/backup.sql .\sre_backup.sql
```

Send `sre_backup.sql` however you like — it's plain text, around 15 KB plus your incidents.

### On the receiving machine

```powershell
docker cp .\sre_backup.sql sre-postgres:/tmp/backup.sql
docker exec sre-postgres psql -U sre -d sre_platform -f /tmp/backup.sql
```

Confirm it worked:
```powershell
docker exec sre-postgres psql -U sre -d sre_platform -c "SELECT count(*) FROM incidents;"
```

> **This replaces everything you currently have.** Because of `--clean`, the
> dump drops every table before recreating it, so any incidents on your own
> machine are lost. Back yours up first if you care about them.

> **A note on `\restrict`:** dumps from PostgreSQL 17+ start with a `\restrict`
> line. It's a psql safety feature and restores fine with a matching version.
> If you ever see `\restrict: command not found`, the receiving Postgres is
> older than the one the dump came from — both ends use `postgres:16-alpine`
> here, so this shouldn't arise.

### Data only, keeping your existing schema

If the schema has changed since the dump was taken, a full restore can fail. This copies just the rows:

```powershell
# Sender
docker exec sre-postgres pg_dump -U sre -d sre_platform --data-only -f /tmp/data.sql
docker cp sre-postgres:/tmp/data.sql .\sre_data.sql

# Receiver — reset to a clean schema first, then load the rows
cd server ; npm run db:reset -- --force ; cd ..
docker cp .\sre_data.sql sre-postgres:/tmp/data.sql
docker exec sre-postgres psql -U sre -d sre_platform -f /tmp/data.sql
```

You'll see a few duplicate-key errors on the `services` table, because
`db:reset` already seeded those four rows. That's harmless — everything else
loads normally.

### Exporting one incident for a report

Often all you actually want is the story of a single incident:

```powershell
docker exec sre-postgres psql -U sre -d sre_platform -c `
  "SELECT at, status, actor, message FROM incident_events WHERE incident_id='INC-1024' ORDER BY at;"
```

Or the finished RCA text:

```powershell
docker exec sre-postgres psql -U sre -d sre_platform -t -c `
  "SELECT rca_report FROM incidents WHERE id='INC-1024';"
```

### Regular backups

Worth doing once you have RCA reports you'd want in your report:

```powershell
docker exec sre-postgres pg_dump -U sre -d sre_platform --clean --if-exists -f /tmp/b.sql
docker cp sre-postgres:/tmp/b.sql ".\backups\sre_$(Get-Date -Format 'yyyy-MM-dd_HHmm').sql"
```

---

## 13. Where the data physically lives

Not inside the container — in a Docker **named volume**:

```powershell
docker volume ls --filter name=sre
# sre-platform_sre_pgdata
```

This means your data survives:

| Action | Data survives? |
|---|---|
| `docker restart sre-postgres` | Yes |
| `docker compose ... stop` / `up` | Yes |
| `docker compose ... down` | Yes |
| Deleting and recreating the container | Yes |
| `npm run db:init` | Yes — it can only add tables, never remove them |
| `docker compose ... down -v` | **No — deleted** |
| `docker volume rm sre-platform_sre_pgdata` | **No — deleted** |
| `npm run db:reset` | **No — deleted** (asks for confirmation first) |

The two to be careful with are `down -v` and `db:reset`.

---

## 14. Files you should never commit

The root `.gitignore` already handles this. The rule it uses:

```gitignore
.env
.env.*
!.env.example        # templates ARE committed
!.env.*.example
```

So `server/.env` stays private while `server/.env.example` gets shared — which is how a new teammate knows what to create.

**What's in those files and why it matters:**

| File | Holds | If leaked |
|---|---|---|
| `agents/.env` | **Gemini API key** | Anyone can use it, billed to you, until revoked |
| `server/.env` | DB password, `JWT_SECRET`, `AGENT_SECRET` | Anyone can forge an operator login and approve remediation |
| `client/.env` | Only URLs | Nothing — it's public anyway (see §5) |

Also ignored: `node_modules/`, `.venv/`, `dist/`, `chroma_data/`, `backups/`, and any `sre_backup*.sql` — database dumps can contain real incident data.

**If you accidentally commit a secret**, don't just delete it in the next commit — it stays in git history. Revoke the key at the provider and generate a new one.

---

## 15. Quick reference

```powershell
# Start everything
docker compose -f docker/platform.compose.yml up -d
docker compose -f docker/demo.compose.yml up -d

# Status
docker ps --format "table {{.Names}}\t{{.Status}}"

# Create any missing tables (SAFE — never deletes)
cd server ; npm run db:init

# Wipe and start clean (DESTRUCTIVE — asks first)
cd server ; npm run db:reset

# Verify the setup
cd server ; npm run verify:phase1

# Look inside the database
docker exec -it sre-postgres psql -U sre -d sre_platform
#   \dt                     list tables
#   \d incidents            describe a table
#   \q                      quit

# Break something
curl "http://localhost:3001/debug/leak?mb=400"

# Fix it
docker start demo-api
curl http://localhost:3001/debug/reset

# Stop for the day
docker compose -f docker/demo.compose.yml stop
docker compose -f docker/platform.compose.yml stop
```
