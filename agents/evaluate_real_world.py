import asyncio
import json
import time
import httpx

AGENT_URL = "http://localhost:8000"
AGENT_SECRET = "d5697fe4e9f6117afc0defd8854f344e"

# Diverse Real-World Production Incident Scenarios
SCENARIOS = [
    {
        "id": "INC-PROD-001",
        "title": "Scenario 1: Node.js V8 Memory Leak & Kernel OOM Kill",
        "service": "payment-api",
        "type": "CONTAINER_OOM_KILLED",
        "exit_code": 137,
        "oom_killed": True,
        "rule_suggested_severity": "SEV1",
        "metrics_history": [
            {"at": 1758280000000, "status": "running", "health": "healthy", "cpu_pct": 5.2, "mem_used": 128000000, "mem_limit": 536870912, "mem_pct": 23.8},
            {"at": 1758280300000, "status": "running", "health": "healthy", "cpu_pct": 8.1, "mem_used": 340000000, "mem_limit": 536870912, "mem_pct": 63.3},
            {"at": 1758280500000, "status": "running", "health": "healthy", "cpu_pct": 14.5, "mem_used": 510000000, "mem_limit": 536870912, "mem_pct": 95.0},
            {"at": 1758280530000, "status": "exited", "health": "none", "cpu_pct": 0, "mem_used": 0, "mem_limit": 536870912, "mem_pct": 0, "exit_code": 137, "oom_killed": True}
        ],
        "logs": [
            "INFO  [payments] Processed batch 8912 successfully",
            "WARN  [runtime] Memory heap used 468 MB approaching limit 512 MB",
            "FATAL <--- Last few GCs ---> [1:0x5621] 512000 ms: Mark-sweep 505.2 (512.0) -> 504.8 (512.0) MB, allocation failure",
            "FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory"
        ],
        "container_info": {
            "status": "exited",
            "memory_limit": 536870912,
            "restart_policy": "no",
            "exit_code": 137,
            "oom_killed": True
        },
        "allowed_actions": ["RESTART_CONTAINER", "START_CONTAINER", "CLEAR_DEMO_CACHE", "ESCALATE_TO_HUMAN"],
        "similar_past_incidents": []
    },
    {
        "id": "INC-PROD-002",
        "title": "Scenario 2: Database Connection Pool Starvation & Healthcheck Timeout",
        "service": "order-gateway",
        "type": "CONTAINER_UNHEALTHY",
        "exit_code": -1,
        "oom_killed": False,
        "rule_suggested_severity": "SEV2",
        "metrics_history": [
            {"at": 1758281000000, "status": "running", "health": "healthy", "cpu_pct": 4.5, "mem_used": 150000000, "mem_limit": 1073741824, "mem_pct": 14.0},
            {"at": 1758281060000, "status": "running", "health": "unhealthy", "cpu_pct": 2.1, "mem_used": 155000000, "mem_limit": 1073741824, "mem_pct": 14.4}
        ],
        "logs": [
            "ERROR [db-pool] TimeoutError: ResourceRequest timed out after 30000ms (max pool: 20/20 active)",
            "ERROR [health] GET /healthz failed: Database ping timed out after 5000ms",
            "WARN  [docker] Health check failed 3 consecutive times: container state marked UNHEALTHY"
        ],
        "container_info": {
            "status": "running",
            "memory_limit": 1073741824,
            "restart_policy": "unless-stopped",
            "exit_code": -1,
            "oom_killed": False
        },
        "allowed_actions": ["RESTART_CONTAINER", "START_CONTAINER", "CLEAR_DEMO_CACHE", "ESCALATE_TO_HUMAN"],
        "similar_past_incidents": []
    },
    {
        "id": "INC-PROD-003",
        "title": "Scenario 3: CPU Saturation / Infinite Loop in Worker",
        "service": "recommendation-worker",
        "type": "HIGH_CPU",
        "exit_code": -1,
        "oom_killed": False,
        "rule_suggested_severity": "SEV2",
        "metrics_history": [
            {"at": 1758282000000, "status": "running", "health": "healthy", "cpu_pct": 98.9, "mem_used": 210000000, "mem_limit": 1073741824, "mem_pct": 19.5},
            {"at": 1758282030000, "status": "running", "health": "healthy", "cpu_pct": 99.4, "mem_used": 212000000, "mem_limit": 1073741824, "mem_pct": 19.7}
        ],
        "logs": [
            "WARN  [compute] Matrix factorisation task batch_771 running for >120s without yielding",
            "WARN  [eventloop] Event loop blocked duration=118000ms cpu_saturation=100%"
        ],
        "container_info": {
            "status": "running",
            "memory_limit": 1073741824,
            "restart_policy": "unless-stopped",
            "exit_code": -1,
            "oom_killed": False
        },
        "allowed_actions": ["RESTART_CONTAINER", "START_CONTAINER", "CLEAR_DEMO_CACHE", "ESCALATE_TO_HUMAN"],
        "similar_past_incidents": []
    },
    {
        "id": "INC-PROD-004",
        "title": "Scenario 4: Corrupted Cache Keys Causing 500 Errors",
        "service": "demo-api",
        "type": "CONTAINER_UNHEALTHY",
        "exit_code": -1,
        "oom_killed": False,
        "rule_suggested_severity": "SEV2",
        "metrics_history": [
            {"at": 1758283000000, "status": "running", "health": "unhealthy", "cpu_pct": 6.2, "mem_used": 180000000, "mem_limit": 536870912, "mem_pct": 33.5}
        ],
        "logs": [
            "ERROR [cache] SyntaxError: Unexpected token < in JSON at position 0 from Redis key session:9912",
            "ERROR [http] 500 Internal Server Error returned to 142 clients due to malformed cache payload"
        ],
        "container_info": {
            "status": "running",
            "memory_limit": 536870912,
            "restart_policy": "unless-stopped",
            "exit_code": -1,
            "oom_killed": False
        },
        "allowed_actions": ["RESTART_CONTAINER", "START_CONTAINER", "CLEAR_DEMO_CACHE", "ESCALATE_TO_HUMAN"],
        "similar_past_incidents": []
    }
]

async def run_live_tests():
    print("\n" + "=" * 80)
    print("RUNNING REAL-WORLD INCIDENT EVALUATION ACROSS THE AGENT PIPELINE")
    print("=" * 80 + "\n")

    async with httpx.AsyncClient(timeout=120.0) as client:
        for idx, s in enumerate(SCENARIOS, 1):
            print(f"[{idx}/{len(SCENARIOS)}] Testing: {s['title']}")
            print(f"    Target Service: {s['service']} | Incident Type: {s['type']}")
            
            payload = {
                "incident_id": s["id"],
                "service": s["service"],
                "type": s["type"],
                "exit_code": s["exit_code"],
                "oom_killed": s["oom_killed"],
                "rule_suggested_severity": s["rule_suggested_severity"],
                "metrics_history": s["metrics_history"],
                "logs": s["logs"],
                "container_info": s["container_info"],
                "allowed_actions": s["allowed_actions"],
                "similar_past_incidents": s["similar_past_incidents"]
            }

            t0 = time.perf_counter()
            resp = await client.post(
                f"{AGENT_URL}/agent/analyze",
                headers={"X-Agent-Secret": AGENT_SECRET},
                json=payload
            )
            duration_ms = int((time.perf_counter() - t0) * 1000)

            if resp.status_code != 200:
                print(f"[X] Error {resp.status_code}: {resp.text}\n")
                continue

            data = resp.json()
            print(f"    >> Pipeline Response Time: {duration_ms} ms | Provider: {data.get('provider')}")
            print(f"    |-- Severity: {data.get('severity')} | Category: {data.get('category')}")
            print(f"    |-- Triage Reasoning: {data.get('triage_reasoning')}")
            print(f"    |-- Root Cause: {data.get('root_cause')}")
            print(f"    |-- Confidence: {data.get('confidence'):.2f}")
            print(f"    |-- Evidence Found ({len(data.get('evidence', []))} items):")
            for ev in data.get("evidence", []):
                print(f"    |    * {ev}")
            print(f"    |-- Proposed Action: {data.get('action')} (Target: {data.get('target')}, Risk: {data.get('risk')})")
            print(f"    `-- Action Reasoning: {data.get('reasoning')}")
            print("-" * 80 + "\n")

        # Now test Agent 4: RCA (Postmortem Generator)
        print("[Postmortem Evaluation] Testing Agent 4 (RCA) on Incident 1 Resolution...")
        rca_payload = {
            "incident": {
                "id": "INC-PROD-001",
                "service": "payment-api",
                "type": "CONTAINER_OOM_KILLED",
                "severity": "SEV1",
                "root_cause": "payment-api exhausted container memory limit of 512 MB due to memory leak in batch processing",
                "confidence": 0.95,
                "evidence": [
                    "Container exited with code 137 (OOMKilled)",
                    "Heap usage reached 95% of 512 MB before exit",
                    "Logs show allocation failure during mark-sweep garbage collection"
                ],
                "proposed_action": "RESTART_CONTAINER",
                "target": "payment-api",
                "risk": "LOW",
                "detected_at": "2026-10-04T12:00:00Z",
                "resolved_at": "2026-10-04T12:02:15Z"
            },
            "timeline": [
                {"at": "2026-10-04T12:00:00Z", "status": "DETECTED", "actor": "system", "message": "payment-api exited (137)"},
                {"at": "2026-10-04T12:00:05Z", "status": "ANALYZING", "actor": "ai", "message": "LangGraph pipeline executed"},
                {"at": "2026-10-04T12:00:10Z", "status": "AWAITING_APPROVAL", "actor": "ai", "message": "Proposed RESTART_CONTAINER"},
                {"at": "2026-10-04T12:00:45Z", "status": "EXECUTING", "actor": "priya (on-call SRE)", "message": "Manual approval granted"},
                {"at": "2026-10-04T12:02:15Z", "status": "RESOLVED", "actor": "system", "message": "Health check returning 200 OK"}
            ],
            "actions": [
                {
                    "action_type": "RESTART_CONTAINER",
                    "target": "payment-api",
                    "result": "success",
                    "executed_at": "2026-10-04T12:01:00Z"
                }
            ],
            "similar_past_incidents": []
        }

        t0 = time.perf_counter()
        rca_resp = await client.post(
            f"{AGENT_URL}/agent/rca",
            headers={"X-Agent-Secret": AGENT_SECRET},
            json=rca_payload
        )
        rca_ms = int((time.perf_counter() - t0) * 1000)
        rca_data = rca_resp.json()

        print(f"    >> RCA Response Time: {rca_ms} ms | Provider: {rca_data.get('provider')}")
        print("\n" + "=" * 30 + " GENERATED RCA REPORT " + "=" * 30)
        print(rca_data.get("report"))
        print("=" * 80)
        print("\nActionable Recommendations:")
        for idx, rec in enumerate(rca_data.get("recommendations", []), 1):
            print(f"  {idx}. {rec}")
        print("\n")

    print("Real-world evaluation complete!\n")

if __name__ == "__main__":
    asyncio.run(run_live_tests())
