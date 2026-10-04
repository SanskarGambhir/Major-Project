# `client.md` — The Dashboard (React)

> The easiest of the three parts to build, and the easiest to get subtly wrong. The client holds no truth of its own — everything it shows was decided elsewhere. Its whole job is to receive updates and render them without duplicating or losing anything.

---

## The 3 parts in 60 seconds

| Part | Language | Port | Its job in five words |
|---|---|---|---|
| **client** | React | 5173 | Show humans what's happening |
| **server** | Node.js | 3000 | Watch Docker, decide, act |
| **agents** | Python | 8000 | Think about what went wrong |

```
   client (React) ──── REST: "do this" ─────►  server (Node)
                  ◄─── WebSocket: "this happened" ───
```

---

## 1. What the client is

**Analogy: the monitor beside a hospital bed.**

It shows heart rate, oxygen, blood pressure. It beeps when something crosses a threshold. It displays the doctor's notes. When a decision is needed, it shows a prompt and waits for a human to press a button.

What it does **not** do is decide anything. It doesn't diagnose, it doesn't administer drugs, and it doesn't decide what counts as an emergency. Unplug the monitor and the patient is in exactly the same state — you just can't see it.

Same here. Every number was measured by the server. Every severity was decided by the server and the agents. Delete the client entirely and the system still detects, investigates, and remediates — silently.

---

## 2. Its one job — and what it must never do

### ✅ Owns

- **Displaying state** it received from the server.
- **Asking for actions** — approve, reject, restart, simulate a fault.
- **Local view preferences** — open tab, active filter, collapsed panel.

### ❌ Must never

- **Never calculate anything that matters.** If the dashboard computes "healthy vs critical" itself, it can disagree with the server — and now you have two sources of truth and no way to know which is right. The server sends `status: "CRITICAL"`; the client picks a colour for it.
- **Never talk to Docker or to Python.** Everything goes through the server.
- **Never be the enforcement point for permissions.** Hiding the Approve button from a viewer is *politeness*, not security. The server checks the role again on every request, because anyone can open devtools.

---

## 3. The mental model

```
   ┌────────────────────────────────────────────────────────┐
   │  App                                                    │
   │                                                         │
   │   ┌─────────────────────────────────────────────────┐   │
   │   │ socket.js  (ONE connection, module-level)       │   │
   │   └──────────────────┬──────────────────────────────┘   │
   │                      ▼                                   │
   │   ┌─────────────────────────────────────────────────┐   │
   │   │ useIncidents()  ·  useMetrics()                 │   │
   │   │ server sends the FULL list — just replace state │   │
   │   └──────────────────┬──────────────────────────────┘   │
   │                      │                                   │
   │      ┌───────────────┼───────────────┐                  │
   │      ▼               ▼               ▼                  │
   │ ServiceGrid    IncidentList    AgentTimeline             │
   │ ApprovalCard   RcaReport       CorrelationPanel          │
   │ ScenarioRunner ProviderPill                              │
   └──────────────┬─────────────────────────▲────────────────┘
        REST POST │                         │ WebSocket
      (do things) ▼                         │ (learn things)
              ┌────────────────────────────────┐
              │        server (Node)           │
              └────────────────────────────────┘
```

**Two channels, two purposes.** This split is deliberate:

- **WebSocket = "tell me what's happening."** One-way, constant, read-only.
- **REST = "please do this."** Request/response, with status codes and an audit record.

§7 explains why we don't just do everything over the socket.

---

## 4. How it works — the same incident, from the user's side

`INC-1024` again. What a person actually sees, second by second. Compare with `server.md` (what was measured) and `agents.md` (what was concluded).

---

### Before anything happens

Three service cards, all green:

```
┌─ demo-api ────────┐  ┌─ demo-db ─────────┐  ┌─ demo-cache ──────┐
│ 🟢 Healthy        │  │ 🟢 Healthy        │  │ 🟢 Healthy        │
│ CPU     12%       │  │ CPU      4%       │  │ CPU      2%       │
│ Memory  44% ▁▂▂▁  │  │ Memory  31% ▁▁▁▁  │  │ Memory  18% ▁▁▁▁  │
│ Up      4m 12s    │  │ Up      4m 12s    │  │ Up      4m 12s    │
└───────────────────┘  └───────────────────┘  └───────────────────┘
```

Sparklines update every 3 seconds from the `metrics` event.

Below, a protected section — greyed out, with a lock icon:

```
┌─ 🔒 Platform Infrastructure (protected) ──────────────────┐
│  sre-postgres  🟢                                          │
│  Cannot be modified by automated remediation.              │
└────────────────────────────────────────────────────────────┘
```

> **Show this, don't hide it.** Someone who can see the protected container understands the safety model instantly. A hidden one just looks absent.

### `10:32:00` — Trigger the fault

```
┌─ Fault Injection ─────────────────────────────────┐
│  [ CPU Spike ]  [ Memory Leak ]  [ Error Storm ]  │
│  [ Stop Container ]  [ Database Down ]            │
│                                                    │
│  [ ⟲ Reset all services to clean state ]           │
└────────────────────────────────────────────────────┘
```

Clicking **Memory Leak** sends `POST /api/simulate/leak`. That's all the client does — everything after happens because the server *observed* it, not because the client told it to.

### `10:32:02 → 10:32:14` — Memory climbs, visibly

The `demo-api` sparkline rises. At 90% the card turns amber:

```
┌─ demo-api ────────┐
│ 🟡 Warning        │
│ Memory  93% ▂▄▆█  │
└───────────────────┘
```

No incident yet — the server is waiting to see whether it sustains. **Showing the amber state during that wait** makes the delay read as deliberate rather than broken.

### `10:32:16` — The incident appears

```
┌─ INC-1024 ──────────────────────────── SEV1 ─┐
│  demo-api · CONTAINER_OOM_KILLED              │
│  Detected 10:32:16                            │
│                                               │
│  ● Detect   ○ Analyse   ○ Approve             │
│  ○ Execute  ○ Verify    ○ Report              │
│                                               │
│  Status: DETECTED                             │
└───────────────────────────────────────────────┘
```

Those six dots fill in as `incidents` updates arrive — the clearest way to show this is a *multi-step process*, not a single AI call.

### `10:32:17 → 10:32:28` — The agent timeline fills in

The most important panel in the demo, because it's the only place the AI workflow is visible:

```
┌─ Agent Activity ──────────────────────────────────────────┐
│  10:32:16  🚨  Incident detected — exit 137, OOMKilled     │
│  10:32:17  🤖  AI analysis started                         │
│  10:32:20  🤖  Triage: SEV1 · RESOURCE_EXHAUSTION          │
│  10:32:24  🔍  Root cause: application memory exhaustion   │
│                confidence 94%                              │
│  10:32:28  🛠  Proposes: RESTART_CONTAINER (risk LOW)      │
│                gemini-2.0-flash · 2,140 tok · 11.2s        │
│  10:32:28  ⏸  Awaiting human approval                      │
│                (confidence 94% < auto-approve 95%)         │
└────────────────────────────────────────────────────────────┘
```

Showing the model name, token count, and latency costs nothing and makes the AI's work concrete rather than magical. The last line matters — it doesn't just say "waiting," it says *why*, in numbers.

### `10:32:28` — The approval card

```
┌─ ⏸ Approval Required — INC-1024 ─────────────────────────┐
│  Proposed action    RESTART_CONTAINER                     │
│  Target             demo-api                              │
│  Risk               LOW          Confidence      94%      │
│                                                           │
│  A restart clears the leaked heap and restores service.   │
│  It treats the symptom rather than the cause — the leak   │
│  will recur — but restoring availability takes priority.  │
│                                                           │
│  ⚠ Similar to INC-0917 (3 days ago), which recurred twice │
│                                                           │
│  Expires in 4:31                                          │
│                                                           │
│  [ ✓ Approve ]   [ ✗ Reject ]                             │
└───────────────────────────────────────────────────────────┘
```

The countdown is real — the server stored `approval_expires_at`. If it runs out, the incident escalates rather than hanging forever.

Logged in as a **viewer** rather than an **operator**? The buttons are replaced with *"Operator role required to approve."*

### `10:32:40` — Approve

```js
await api.post(`/api/incidents/INC-1024/approve`);
```

The button shows a spinner and disables. The card does **not** vanish yet — it waits for the server to confirm over the socket.

### `10:32:41 → 10:32:56` — Execution and verification, live

```
│  10:32:40  👤  Approved by priya (operator)                │
│  10:32:40  ⚙  Policy check passed — demo-api is a managed  │
│                demo service                                │
│  10:32:41  ⚙  Executing RESTART_CONTAINER…                 │
│  10:32:43  ✅  Container restarted (start time changed)     │
│  10:32:45  ⏳  Health check: connection refused (booting)   │
│  10:32:50  ✅  Health check: 200 OK                        │
│  10:32:56  ✅  Memory 30%, stable — verification passed     │
│  10:32:56  ✅  RESOLVED · recovery time 42s                 │
```

**Show the failed health check at 10:32:45.** It's tempting to hide it, but it's evidence that verification is real and patient rather than a rubber stamp.

### `10:33:01` — The report

```
┌─ Root Cause Analysis — INC-1024 ─────────── [Copy] [PDF] ─┐
│  Service  demo-api     Severity  SEV1     Recovery  42s    │
│                                                            │
│  ROOT CAUSE                                                │
│  The demo-api container exhausted its 256 MB memory limit… │
│                                                            │
│  RECOMMENDATIONS                                           │
│  1. The underlying leak is NOT fixed. Second occurrence     │
│     in 3 days (see INC-0917).                              │
└────────────────────────────────────────────────────────────┘
```

---

## 5. Implementation

### 5.0 Folder layout

```
client/src/
├── main.jsx
├── App.jsx
│
├── lib/
│   ├── socket.js         ← ONE socket, created once. Read §5.1 carefully.
│   ├── api.js            ← axios wrapper, attaches the auth token
│   └── format.js         ← bytes → MB, durations, colours
│
├── hooks/
│   ├── useSocketEvent.js
│   ├── useIncidents.js
│   ├── useMetrics.js
│   └── useAuth.js
│
├── components/
│   ├── ServiceGrid.jsx      ServiceCard.jsx      WorkflowStages.jsx
│   ├── IncidentList.jsx     IncidentCard.jsx
│   ├── AgentTimeline.jsx    ApprovalCard.jsx
│   ├── RcaReport.jsx        CorrelationPanel.jsx
│   ├── ScenarioRunner.jsx   ProviderPill.jsx
│   └── ui/                  ← shadcn components (already present)
│
└── pages/{Dashboard,IncidentDetail,Login}.jsx
```

> **Before writing any UI, install the missing packages.** Five shadcn files already in `components/ui/` import libraries that aren't in `package.json` — `@radix-ui/react-*`, `recharts`, `react-day-picker`. Nothing imports them yet, which is the only reason the dev server currently starts. The moment you import `Button`, it breaks.

### 5.1 The socket — one connection, created once

The most important file in the client, and the one that causes the most confusing bugs.

```js
// src/lib/socket.js
import { io } from 'socket.io-client';

// Created at MODULE level — when this file is first imported, and never again.
// NOT inside a component, and NOT inside useEffect.
export const socket = io('http://localhost:3000', {
  autoConnect: false,
  auth: { token: localStorage.getItem('token') },
});

export function connectSocket() {
  if (!socket.connected) socket.connect();
}
```

> **Why this matters so much.** React 19's StrictMode deliberately runs every `useEffect` **twice** in development to help you find bugs. A socket created inside an effect gives you **two connections**, both receiving every message — so every incident appears twice and you'll spend an evening convinced the server is broken.
>
> Hot Module Reload makes it worse: each file save adds more listeners to the existing connection.
>
> A module-level singleton is created exactly once, no matter how many times components mount.

### 5.2 Subscribing safely

```js
// src/hooks/useSocketEvent.js
export function useSocketEvent(event, handler) {
  useEffect(() => {
    socket.on(event, handler);
    // Remove THIS handler only. socket.removeAllListeners() would tear off
    // every other component's subscriptions — a classic bug where unmounting
    // one panel silently breaks three others.
    return () => socket.off(event, handler);
  }, [event, handler]);
}
```

### 5.3 State — deliberately boring

**The server sends the full incident list on every change.** So the hook is three lines:

```js
// src/hooks/useIncidents.js

export function useIncidents() {
  const [incidents, setIncidents] = useState([]);
  useSocketEvent('incidents', setIncidents);      // just replace it
  return incidents;
}
```

> **An earlier design sent only the changed incident**, which meant handling out-of-order delivery — a delayed "updated" landing after "resolved" would show a resolved incident as active. Fixing that properly needs sequence numbers, a snapshot mechanism, and reconciliation logic on both sides.
>
> With a handful of incidents, re-sending everything costs nothing and makes the whole problem **impossible rather than merely unlikely**. This is a good trade and worth mentioning in your report as a deliberate engineering decision.

Only three kinds of state exist, and none need Redux:

| Kind | Example | Where it lives |
|---|---|---|
| **Server state** | incidents, metrics | Hooks fed by the socket |
| **Session state** | who's logged in, their role | One `AuthContext` |
| **View state** | open tab, active filter | Local `useState` |

### 5.4 The metrics hook

```js
// src/hooks/useMetrics.js

export function useMetrics() {
  const [current, setCurrent] = useState([]);
  const [history, setHistory] = useState({});     // for the sparklines

  // ONE message carrying ALL services — not one message per service.
  useSocketEvent('metrics', (all) => {
    setCurrent(all);
    setHistory(prev => {
      const next = { ...prev };
      for (const m of all) {
        // Keep only the last 40 points. Without a cap, a tab left open for an
        // hour holds 1,200 points per service and the charts crawl.
        next[m.service] = [...(prev[m.service] ?? []), m].slice(-40);
      }
      return next;
    });
  });

  return { current, history };
}
```

### 5.5 The approval card

```jsx
export function ApprovalCard({ incident }) {
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);

  if (user.role !== 'operator')
    return <Notice>Operator role required to approve this action.</Notice>;

  async function decide(decision) {
    setBusy(true);
    try {
      await api.post(`/api/incidents/${incident.id}/${decision}`);
      // Deliberately do NOT clear the card here. Wait for the server to confirm
      // over the socket — a rejected or failed approval would otherwise leave
      // the UI showing something that never happened.
    } catch (err) {
      toast.error(err.response?.data?.reason ?? 'Request failed');
      setBusy(false);
    }
  }

  return (
    <Card>
      <Row label="Proposed action" value={incident.proposedAction} />
      <Row label="Target"          value={incident.target} />
      <Row label="Risk"            value={incident.risk} />
      <Row label="Confidence"      value={`${(incident.confidence * 100).toFixed(0)}%`} />
      <p>{incident.reasoning}</p>
      <Countdown until={incident.approvalExpiresAt} />
      <Button disabled={busy} onClick={() => decide('approve')}>Approve</Button>
      <Button disabled={busy} onClick={() => decide('reject')} variant="outline">Reject</Button>
    </Card>
  );
}
```

### 5.6 Showing refusals — one of your best demo moments

```js
useSocketEvent('policy.denied', (msg) => {
  toast.error(`Action blocked: ${msg.reason}`, { duration: 8000 });
});
```

Try to restart `sre-postgres` and a red banner appears:

> **Action blocked:** `sre-postgres` is protected platform infrastructure.

Do this deliberately during your demo. Three seconds, and it proves the entire safety model better than any explanation.

### 5.7 The correlation panel

Correlation is invisible without this. Build the logic and skip the panel, and anyone watching assumes you didn't build it.

```
┌─ Alert Correlation ────────────────────────────────┐
│  INC-1031 · demo-db is down          ← root cause   │
│                                                     │
│  2 related alerts suppressed:                       │
│    · demo-api  error rate high    (depends on ↑)   │
│    · demo-api  health check fail  (depends on ↑)   │
│                                                     │
│  One incident created instead of three.             │
└─────────────────────────────────────────────────────┘
```

That last line is the whole point. Say it explicitly.

### 5.8 The provider pill

A small badge in the header showing which brain is answering:

```
   ● gemini-2.0-flash   (green)   — cloud, normal operation
   ● qwen2.5 local      (amber)   — offline fallback
   ● rules only         (grey)    — no AI available
```

Turn off wifi during the demo and watch it go green → grey while the system keeps working. That demonstrates more engineering maturity than any feature you could add.

### 5.9 Connecting to the server

```js
// vite.config.js — do NOT proxy the WebSocket.
// A Vite proxy without `ws: true` silently downgrades Socket.IO to long-polling:
// everything still "works" but feels laggy, and you can lose an evening to it.
// Connecting directly is simpler and matches demo day.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173 },
});
```

The server sets `cors: { origin: 'http://localhost:5173' }`, and the client connects straight to `http://localhost:3000`.

---

## 6. How the client talks to the other two

It only ever talks to the server. No connection to Python, none to Docker.

**Sends (REST):**
```
POST /api/auth/login
GET  /api/services                GET /api/incidents      GET /api/incidents/:id
POST /api/incidents/:id/approve   ← operator only
POST /api/incidents/:id/reject    ← operator only
POST /api/actions                 ← manual action, operator only
POST /api/simulate/:scenario      POST /api/simulate/reset
```

**Receives (WebSocket):**
```
incidents        the FULL list, re-sent on every change
metrics          all services, every 3s
agent.progress   one line for the timeline panel
policy.denied    a refusal, for the red toast
provider         which LLM is currently answering
```

---

## 7. Common confusions

**Q: Why do approvals go over REST when we already have a WebSocket open?**
Because approvals *change the world*, and sockets are a poor fit for that. Over REST you get a proper 403 when a viewer tries it, retry semantics, and a clean audit record on the server. A socket emit gives you none of those — you'd rebuild each one by hand. Rule of thumb: **the socket tells you something happened; REST makes something happen.**

**Q: Why does React StrictMode cause duplicate incidents?**
StrictMode intentionally runs every `useEffect` twice in development to expose bugs. A socket created inside an effect gives you two live connections, each receiving every message. Create it once at module level, outside React entirely.

**Q: Isn't re-sending the whole incident list wasteful?**
At this scale, no — it's a few kilobytes on a change that happens every few seconds at most. And it buys something valuable: no sequence numbers, no snapshot mechanism, no out-of-order handling, no reconciliation logic. An entire category of bugs simply cannot occur. That's a good trade, and worth saying out loud in your report.

**Q: Why not compute service health colours in the browser? It's just a threshold.**
Because then you have two definitions of "critical" — the server's and the client's — and they will drift. Someone changes a threshold in one place, forgets the other, and now the dashboard disagrees with the incident list about the same container. The server sends `status: "CRITICAL"`; the client picks a colour for that word.

**Q: If viewers can't approve, why check the role on the server too?**
Because hiding the button is a courtesy for honest users. Anyone can open devtools and fire the request by hand. **The client's check is cosmetic; the server's is the real one.** This is true of every frontend permission check ever written.

**Q: Why doesn't the approval card disappear the moment I click Approve?**
Because the click is a *request*, not a result. The server might refuse — the restart limit could have been hit, the TTL might have just expired. We show a spinner and remove the card when the server confirms. Optimistic UI is fine for a "like" button; it's wrong for an action that restarts infrastructure.

**Q: Why show suppressed alerts at all? Isn't the point that they're noise?**
Because a suppressed alert you can't see is indistinguishable from a bug. Kill `demo-db`, see only one incident, and the natural reaction is "did it miss the other two?" The correlation panel answers that: it saw them and deliberately folded them into one. **Silent cleverness reads as failure.**

**Q: Why cap the sparkline history at 40 points?**
Metrics arrive every 3 seconds. A tab left open for an hour accumulates 1,200 points per service and the charts start to stutter. Forty points is two minutes — all a sparkline can meaningfully show anyway.

**Q: What does the dashboard do if the server goes down?**
Socket.IO reconnects automatically, and since the server sends the full list on every change, the next update brings the dashboard fully up to date on its own. Show a "reconnecting…" banner while it's disconnected, so a stale screen never masquerades as a calm one.
