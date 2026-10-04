"""
AGENT 2 — INVESTIGATE: "what actually went wrong?"

The only agent that sees the full evidence: the metrics history rendered as a
table, the compacted container logs, the container state, the triage verdict
and (Phase 6) similar past incidents from ChromaDB.

The logs are the one untrusted input in the whole system — they are written by
application code. The prompt labels them as data, but that is decoration; the
real defence is that Agent 3 can only answer with an enum, and the server
checks the target's Docker labels itself (agentsfile.md §7).

Adds to the state:  root_cause, confidence, evidence  (+ one AgentRun)
"""

from __future__ import annotations

from app.schemas.outputs import InvestigationOutput
from app.schemas.state import IncidentState
from app.services import evidence
from app.services.llm import think
from app.services.prompts import render

NAME = "investigate"

# Rules-rung confidence is deliberately LOW. The server auto-approves at 0.95;
# fixed if-statements must never clear that bar — a human should look.
RULES_CONFIDENCE_STRONG = 0.6   # the evidence is unambiguous (OOMKilled flag)
RULES_CONFIDENCE_WEAK = 0.5


def build_prompt(state: IncidentState) -> str:
    history = state.get("metrics_history", []) or []
    info = state.get("container_info", {}) or {}
    return render(
        NAME,
        service=state.get("service", ""),
        incident_type=state.get("incident_type", ""),
        severity=state.get("severity", "") or "unknown",
        category=state.get("category", "") or "unknown",
        triage_reasoning=state.get("triage_reasoning", "") or "(no triage reasoning)",
        metrics_table=evidence.metrics_table(history),
        container_block=evidence.container_block(info) or "  (no container state supplied)",
        logs_block=evidence.logs_block(state.get("logs", []) or []),
        similar_block=evidence.similar_block(state.get("similar_past_incidents", []) or []),
    )


def rules(state: IncidentState) -> InvestigationOutput:
    """
    Rung 3. One templated root cause per incident type the server can detect,
    quoting the numbers it was given so the text is still specific.
    """
    itype = state.get("incident_type", "")
    info = state.get("container_info", {}) or {}
    history = state.get("metrics_history", []) or []
    last = evidence.latest_reading(history)
    service = state.get("service", "the service")
    exit_code = state.get("exit_code", info.get("exit_code", -1))
    oom = bool(state.get("oom_killed") or info.get("oom_killed"))
    limit = info.get("memory_limit") or last.get("mem_limit") or 0

    if itype == "CONTAINER_OOM_KILLED" or oom:
        peak = evidence.memory_at_death(history, info)
        return InvestigationOutput(
            root_cause=(
                f"{service} exhausted its container memory limit"
                f"{' of ' + evidence.fmt_bytes(limit) if limit else ''} and the kernel OOM-killer "
                "terminated the process. The evidence proves memory ran out, not why it grew."
            ),
            confidence=RULES_CONFIDENCE_STRONG,
            evidence=[
                f"Container exited with code {exit_code} and the OOMKilled flag set",
                f"Memory reached {peak} in the last reading before exit",
                "Rule-based analysis: no LLM was available to read the logs",
            ],
        )
    if itype == "CONTAINER_EXITED":
        return InvestigationOutput(
            root_cause=(
                f"{service}'s main process exited with code {exit_code}"
                + (" (clean exit — likely stopped deliberately or by its own logic)." if exit_code == 0
                   else " (a crash or fatal error inside the application).")
            ),
            confidence=RULES_CONFIDENCE_WEAK,
            evidence=[
                f"Container status is exited, exit code {exit_code}, OOMKilled false",
                "Rule-based analysis: logs not interpreted",
            ],
        )
    if itype == "CONTAINER_UNHEALTHY":
        return InvestigationOutput(
            root_cause=f"{service} is running but its health check is failing, so the application inside is not serving correctly.",
            confidence=RULES_CONFIDENCE_WEAK,
            evidence=["Docker health status is 'unhealthy' while the container is running",
                      "Rule-based analysis: logs not interpreted"],
        )
    if itype == "HIGH_MEMORY":
        return InvestigationOutput(
            root_cause=f"{service} is using {evidence.fmt_pct(last.get('mem_pct', 0))} of its memory limit for a sustained period — likely a leak or an oversized working set; it will be OOM-killed if it continues.",
            confidence=RULES_CONFIDENCE_WEAK,
            evidence=[f"Memory at {evidence.fmt_pct(last.get('mem_pct', 0))} of {evidence.fmt_bytes(limit) if limit else 'the limit'} in the latest reading",
                      "Above the 90% threshold for the sustained window",
                      "Rule-based analysis: logs not interpreted"],
        )
    if itype == "HIGH_CPU":
        return InvestigationOutput(
            root_cause=f"{service} has been CPU-saturated ({evidence.fmt_pct(last.get('cpu_pct', 0))}) for a sustained period — a busy loop, runaway job or overload.",
            confidence=RULES_CONFIDENCE_WEAK,
            evidence=[f"CPU at {evidence.fmt_pct(last.get('cpu_pct', 0))} in the latest reading",
                      "Above the 90% threshold for the sustained window",
                      "Rule-based analysis: logs not interpreted"],
        )
    return InvestigationOutput(
        root_cause=f"Unrecognised incident type {itype or '(none)'} on {service}; insufficient rule coverage to determine a cause.",
        confidence=0.2,
        evidence=["Rule-based analysis: no matching rule"],
    )


async def run(state: IncidentState) -> dict:
    """The LangGraph node. Returns only the keys it adds."""
    out, run_record = await think(InvestigationOutput, build_prompt(state), NAME, lambda: rules(state))
    return {
        "root_cause": out.root_cause,
        "confidence": max(0.0, min(1.0, float(out.confidence))),
        "evidence": list(out.evidence),
        "runs": [run_record],
    }
