# AI SRE Command Center — Comprehensive Testing & Evaluation Guide

This document is the complete reference manual for testing, benchmarking, and evaluating the **AI SRE Command Center** and its **4-Agent LangGraph Pipeline**.

---

## 🏗️ 1. Architecture Overview

The system operates across four interconnected layers:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        1. DOCKER INFRASTRUCTURE                         │
│  • demo-api (Port 3001)    : Target container to test & break          │
│  • demo-cache (Port 6379)  : Redis cache instance                      │
│  • demo-db (Port 5433)     : Target Postgres database                  │
│  • sre-postgres (Port 5434): Platform database (incidents & audit logs)│
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Metrics & State (Every 3s)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                      2. NODE.JS BACKEND (Port 3000)                    │
│  • Poller detects failures, threshold breaches, and container crashes  │
│  • Manages incident state machine, human approvals, & Docker actions   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ POST /agent/analyze (Telemetry)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   3. PYTHON AI AGENTS (Port 8000)                      │
│  • Agent 1: Triage      → Classifies severity & category               │
│  • Agent 2: Investigate → Formulates root cause & extracts evidence    │
│  • Agent 3: Mitigate    → Proposes safe remediation & enforces policy  │
│  • Agent 4: RCA         → Generates formal engineering postmortem      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Real-Time WebSocket Events
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   4. REACT SRE DASHBOARD (Port 5173)                   │
│  • Live service telemetry cards & incident timeline board              │
│  • One-click mitigation approval and full postmortem reader            │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 🤖 2. The 4 Agents: Outputs & Indicators Explained

### Agent 1: Triage (`triage.py`)
* **Core Question**: *"How critical is this incident?"*
* **Outputs**:
  * `severity`: `SEV1` (Critical outage / container down) | `SEV2` (Degraded / CPU saturation) | `SEV3` (Warning).
  * `category`: `RESOURCE_EXHAUSTION`, `SERVICE_DOWN`, `HEALTH_CHECK_FAILING`, `CPU_SATURATION`, `UNKNOWN`.
  * `triage_reasoning`: Why this severity was chosen based on container status and metrics.

### Agent 2: Investigate (`investigate.py`)
* **Core Question**: *"What actually caused the failure?"*
* **Outputs**:
  * `root_cause`: Plain-language explanation of the root cause.
  * `confidence`: Certainty score (`0.0` to `1.0`). If $\ge 0.95$, the platform allows auto-approval.
  * `evidence[]`: Array of concrete facts (log lines, peak memory readings, exit codes).

### Agent 3: Mitigate (`mitigate.py`)
* **Core Question**: *"What safe action restores service?"*
* **Outputs**:
  * `action`: One closed-vocabulary enum: `RESTART_CONTAINER`, `START_CONTAINER`, `CLEAR_DEMO_CACHE`, `ESCALATE_TO_HUMAN`.
  * `target`: Strictly pinned target container name (prevents AI from targeting the wrong system).
  * `risk`: `LOW`, `MEDIUM`, `HIGH`, or `NONE`.
  * `reasoning`: Operational explanation of why the action treats the symptom.

### Agent 4: RCA Postmortem (`rca.py`)
* **Core Question**: *"What happened from start to finish, and how do we prevent recurrence?"*
* **Outputs**:
  * `report`: Markdown document detailing timeline, duration, remediation, and verification.
  * `recommendations[]`: 3 permanent code or configuration recommendations.

---

## 🧪 3. The 4 Complete Ways to Test

---

### METHOD 1: End-to-End Real-Time Docker Fault Injection (Most Realistic)

Tests the entire platform reacting live to real hardware and Linux kernel failures.

#### Step 1: Ensure All Services are Running
1. **Docker Containers**:
   ```powershell
   docker compose -f docker/platform.compose.yml up -d
   docker compose -f docker/demo.compose.yml up -d
   ```
2. **Python Agents** (Port 8000):
   ```powershell
   cd agents
   .venv\Scripts\uvicorn app.main:app --port 8000 --reload
   ```
3. **Node.js Server** (Port 3000):
   ```powershell
   cd server
   npm run dev
   ```
4. **React Dashboard** (Port 5173):
   ```powershell
   cd client
   npm run dev
   ```

#### Step 2: Open the Dashboard
Navigate to **`http://localhost:5173`** in your browser.

#### Step 3: Trigger Live Faults in Terminal

| Failure Scenario | Command to Trigger | What Happens & What It Indicates |
| :--- | :--- | :--- |
| **Real Kernel OOM Kill** | `Invoke-RestMethod -Uri "http://localhost:3001/debug/leak?mb=350"` | `demo-api` memory leaks $\rightarrow$ Linux kills process (Exit `137`) $\rightarrow$ Dashboard displays **`SEV1` Incident Alert** $\rightarrow$ Click **"Approve"** to restart container. |
| **100% CPU Saturation** | `Invoke-RestMethod -Uri "http://localhost:3001/debug/cpu?seconds=30"` | Event loop locks up $\rightarrow$ Dashboard flags **`SEV2` CPU Saturation** $\rightarrow$ AI diagnoses runaway loop. |
| **Application Crash Loop**| `Invoke-RestMethod -Uri "http://localhost:3001/debug/crash"` | Process terminates with Exit `1` $\rightarrow$ Dashboard flags **`SEV1` Crash** $\rightarrow$ AI proposes container start. |
| **Health Check Timeout** | `Invoke-RestMethod -Uri "http://localhost:3001/debug/unhealthy"` | `/healthz` returns HTTP 500 $\rightarrow$ Docker marks container Unhealthy $\rightarrow$ AI diagnoses health check failure. |

---

### METHOD 2: Automated Real-World Incident Benchmark Suite

Runs 4 production incident scenarios (OOM leaks, DB connection pool starvation, CPU loops, and Cache corruption) plus an RCA postmortem generator.

#### How to Run:
```powershell
cd agents
.venv\Scripts\python evaluate_real_world.py
```

#### What It Indicates:
* **Pipeline Response Time**: Sub-millisecond on rules fallback, ~1.5s on cloud LLM.
* **Extraction Quality**: Confirms the agents extract exact metrics and logs without hallucinating.
* **Full RCA Output**: Prints a complete postmortem report.

---

### METHOD 3: High-Volume Synthetic Telemetry Stream Generator

Generates 10 to 100+ randomized synthetic incidents to benchmark accuracy, P95 latency, and throughput under heavy load.

#### How to Run:
```powershell
cd agents
.venv\Scripts\python generate_synthetic_eval.py
```

#### What It Indicates:
* **Accuracy Rate**: % of incidents where Severity, Category, and Action matched ground truth.
* **Average & P95 Latency**: Speed distribution under concurrent stream requests.
* **Audit Compliance**: Verifies 100% adherence to allowed action enums.

---

### METHOD 4: Direct Interactive Swagger / REST API Testing

Allows developers to test any custom incident payload directly in the browser or via cURL.

#### How to Test:
1. Open 👉 **`http://localhost:8000/docs`** in your browser.
2. Click **`POST /agent/analyze`** $\rightarrow$ **Try it out**.
3. Set Header `X-Agent-Secret`: `d5697fe4e9f6117afc0defd8854f344e`.
4. Paste custom incident JSON and click **Execute**.

---

## 📊 4. System Status & Verification Checklist

| Component | Status | Verification Check |
| :--- | :--- | :--- |
| **Docker Engine** | 🟢 Running | `docker ps` shows `demo-api`, `demo-db`, `demo-cache`, `sre-postgres` |
| **Platform DB** | 🟢 Initialized | 7 tables created in `sre-postgres` (Port 5434) |
| **Agents Microservice** | 🟢 Online | `GET http://localhost:8000/health` returns `200 OK` |
| **Backend API** | 🟢 Online | `GET http://localhost:3000/api/health` returns `200 OK` |
| **SRE Dashboard** | 🟢 Active | Accessible at `http://localhost:5173` |

---

## 🛠️ 5. Fine-Tuning & Optimization

1. **Enable Gemini Cloud LLM**:
   * Open `agents/.env` and add: `GEMINI_API_KEY=your_google_ai_studio_key`.
   * The agents will automatically upgrade from rules to **Gemini 2.0 Flash**.
2. **Customize Agent Prompts**:
   * Edit templates in `agents/app/prompts/` (`triage.txt`, `investigate.txt`, `mitigate.txt`, `rca.txt`) to add custom few-shot domain examples.
3. **Train Local Models (SFT / LoRA)**:
   * Query historical traces from the `agent_runs` table in `sre-postgres` to build a dataset for fine-tuning local models (e.g., Qwen / Llama via Ollama).
