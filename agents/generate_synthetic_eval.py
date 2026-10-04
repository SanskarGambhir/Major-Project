import asyncio
import random
import time
import httpx

AGENT_URL = "http://localhost:8000"
AGENT_SECRET = "d5697fe4e9f6117afc0defd8854f344e"

# Templates for synthetic incident generation
SERVICES = ["payment-gateway", "auth-service", "order-api", "inventory-worker", "search-indexer", "notification-hub"]

FAULT_PATTERNS = [
    {
        "type": "CONTAINER_OOM_KILLED",
        "category": "RESOURCE_EXHAUSTION",
        "expected_sev": "SEV1",
        "expected_action": "RESTART_CONTAINER",
        "exit_code": 137,
        "oom_killed": True,
        "status": "exited",
        "log_templates": [
            "FATAL ERROR: JavaScript heap out of memory",
            "Mark-sweep allocation failure: memory limit reached",
            "Allocation of size {size} bytes failed during GC"
        ]
    },
    {
        "type": "HIGH_CPU",
        "category": "CPU_SATURATION",
        "expected_sev": "SEV2",
        "expected_action": "RESTART_CONTAINER",
        "exit_code": -1,
        "oom_killed": False,
        "status": "running",
        "log_templates": [
            "WARN  Event loop blocked for {duration}ms",
            "WARN  High CPU utilization: {cpu}% sustained in thread worker",
            "Slow request processing on route /v1/compute"
        ]
    },
    {
        "type": "CONTAINER_UNHEALTHY",
        "category": "HEALTH_CHECK_FAILING",
        "expected_sev": "SEV2",
        "expected_action": "RESTART_CONTAINER",
        "exit_code": -1,
        "oom_killed": False,
        "status": "running",
        "log_templates": [
            "ERROR Health check failed: HTTP 500 from /healthz",
            "ERROR Connection timeout to upstream database pool (max limit reached)",
            "Unhealthy state reported by Docker daemon"
        ]
    },
    {
        "type": "CONTAINER_EXITED",
        "category": "SERVICE_DOWN",
        "expected_sev": "SEV1",
        "expected_action": "RESTART_CONTAINER",
        "exit_code": 1,
        "oom_killed": False,
        "status": "exited",
        "log_templates": [
            "Uncaught TypeError: Cannot read properties of undefined (reading '{prop}')",
            "Process exited with non-zero status code 1",
            "Fatal application crash during bootstrap"
        ]
    }
]

def generate_synthetic_incident(incident_num: int) -> dict:
    pattern = random.choice(FAULT_PATTERNS)
    service = random.choice(SERVICES)
    mem_limit = random.choice([268435456, 536870912, 1073741824])
    
    # Generate realistic telemetry time series
    history = []
    base_time = int(time.time() * 1000) - 120000
    for i in range(5):
        t = base_time + i * 20000
        cpu = random.uniform(90.0, 99.5) if pattern["type"] == "HIGH_CPU" else random.uniform(2.0, 15.0)
        mem_pct = min(99.0, 40.0 + (i * 14.0)) if pattern["type"] == "CONTAINER_OOM_KILLED" else random.uniform(15.0, 45.0)
        mem_used = int(mem_limit * (mem_pct / 100.0))
        history.append({
            "at": t,
            "status": "running" if i < 4 or pattern["status"] == "running" else "exited",
            "health": "unhealthy" if pattern["type"] == "CONTAINER_UNHEALTHY" else "healthy",
            "cpu_pct": round(cpu, 1),
            "mem_used": mem_used,
            "mem_limit": mem_limit,
            "mem_pct": round(mem_pct, 1),
            "exit_code": pattern["exit_code"] if i == 4 and pattern["status"] == "exited" else -1,
            "oom_killed": pattern["oom_killed"] if i == 4 and pattern["status"] == "exited" else False
        })

    # Generate log messages
    logs = [
        f"INFO  [{service}] Worker initialized successfully",
        pattern["log_templates"][0].format(size=random.randint(1000000, 5000000), duration=random.randint(5000, 30000), cpu=random.randint(90, 99), prop=random.choice(["user_id", "session", "token"])),
        pattern["log_templates"][1].format(size=random.randint(1000000, 5000000), duration=random.randint(5000, 30000), cpu=random.randint(90, 99), prop=random.choice(["user_id", "session", "token"]))
    ]

    return {
        "incident_id": f"SYNTH-{incident_num:03d}",
        "service": service,
        "type": pattern["type"],
        "exit_code": pattern["exit_code"],
        "oom_killed": pattern["oom_killed"],
        "rule_suggested_severity": pattern["expected_sev"],
        "metrics_history": history,
        "logs": logs,
        "container_info": {
            "status": pattern["status"],
            "memory_limit": mem_limit,
            "restart_policy": "unless-stopped",
            "exit_code": pattern["exit_code"],
            "oom_killed": pattern["oom_killed"]
        },
        "allowed_actions": ["RESTART_CONTAINER", "START_CONTAINER", "CLEAR_DEMO_CACHE", "ESCALATE_TO_HUMAN"],
        "similar_past_incidents": [],
        "_meta_expected": pattern
    }

async def benchmark_synthetic_stream(total_incidents: int = 10):
    print("\n" + "=" * 80)
    print(f"GENERATING AND BENCHMARKING {total_incidents} SYNTHETIC REAL-TIME INCIDENTS")
    print("=" * 80 + "\n")

    incidents = [generate_synthetic_incident(i + 1) for i in range(total_incidents)]
    results = []

    async with httpx.AsyncClient(timeout=60.0) as client:
        for idx, inc in enumerate(incidents, 1):
            expected = inc.pop("_meta_expected")
            t0 = time.perf_counter()
            resp = await client.post(
                f"{AGENT_URL}/agent/analyze",
                headers={"X-Agent-Secret": AGENT_SECRET},
                json=inc
            )
            lat_ms = int((time.perf_counter() - t0) * 1000)

            if resp.status_code == 200:
                data = resp.json()
                sev_ok = data.get("severity") == expected["expected_sev"]
                act_ok = data.get("action") == expected["expected_action"]
                results.append({
                    "id": inc["incident_id"],
                    "service": inc["service"],
                    "type": inc["type"],
                    "latency_ms": lat_ms,
                    "provider": data.get("provider"),
                    "severity": data.get("severity"),
                    "action": data.get("action"),
                    "accuracy": "PASS" if sev_ok and act_ok else "FAIL"
                })
                print(f"[{idx:02d}/{total_incidents:02d}] {inc['incident_id']} ({inc['service']}) -> {data.get('severity')} | Action: {data.get('action')} | Latency: {lat_ms}ms [{results[-1]['accuracy']}]")
            else:
                print(f"[{idx:02d}/{total_incidents:02d}] Failed: HTTP {resp.status_code}")

    # Summary Statistics
    latencies = [r["latency_ms"] for r in results]
    pass_count = sum(1 for r in results if r["accuracy"] == "PASS")
    avg_latency = sum(latencies) / len(latencies) if latencies else 0
    p95_latency = sorted(latencies)[int(len(latencies) * 0.95)] if latencies else 0

    print("\n" + "=" * 30 + " BENCHMARK SCORECARD " + "=" * 30)
    print(f"Total Incidents Processed: {len(results)}")
    print(f"Accuracy Rate:             {pass_count}/{len(results)} ({pass_count/len(results)*100:.1f}%)")
    print(f"Average Pipeline Latency:  {avg_latency:.1f} ms")
    print(f"P95 Pipeline Latency:      {p95_latency} ms")
    print("=" * 81 + "\n")

if __name__ == "__main__":
    asyncio.run(benchmark_synthetic_stream(10))
