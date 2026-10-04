"""
AGENT 1 — TRIAGE: "how bad is this?"

Sees the basic facts only — no logs (agentsfile.md §7). The server already
worked out a severity with fixed rules and passes it as
`rule_suggested_severity`; our job is to confirm or override it with a reason.

    Deterministic where determinism matters, LLM where judgment matters.

Adds to the state:  severity, category, triage_reasoning  (+ one AgentRun)
"""

from __future__ import annotations

from app.schemas.enums import Severity
from app.schemas.outputs import TriageOutput
from app.schemas.state import IncidentState
from app.services import evidence
from app.services.llm import think
from app.services.prompts import render

NAME = "triage"

DOWN_STATES = ("exited", "dead")


def build_prompt(state: IncidentState) -> str:
    info = state.get("container_info", {}) or {}
    last = evidence.latest_reading(state.get("metrics_history", []) or [])
    status = info.get("status") or last.get("status") or "unknown"
    exit_code = state.get("exit_code", info.get("exit_code", -1))
    oom = state.get("oom_killed", info.get("oom_killed", False))

    return render(
        NAME,
        service=state.get("service", ""),
        incident_type=state.get("incident_type", ""),
        container_status=status,
        exit_code=exit_code if exit_code is not None and exit_code != -1 else "n/a",
        oom_killed="yes" if oom else "no",
        health=last.get("health", "none"),
        memory_now=evidence.memory_at_death(state.get("metrics_history", []) or [], info),
        cpu_now=evidence.fmt_pct(last.get("cpu_pct", 0)) if last else "unknown",
        rule_suggested_severity=state.get("rule_suggested_severity") or "none",
    )


def rules(state: IncidentState) -> TriageOutput:
    """
    Rung 3. Not a stub — a real working path. Unplug the internet and this
    still triages every incident type the server can detect.
    """
    info = state.get("container_info", {}) or {}
    last = evidence.latest_reading(state.get("metrics_history", []) or [])
    itype = state.get("incident_type", "")
    status = info.get("status") or last.get("status") or ""
    oom = bool(state.get("oom_killed") or info.get("oom_killed"))

    if itype == "CONTAINER_OOM_KILLED" or oom:
        return TriageOutput(severity=Severity.SEV1, category="RESOURCE_EXHAUSTION",
                            reasoning="Rule: container was killed by the kernel OOM-killer; it is serving nothing.")
    if itype == "CONTAINER_EXITED" or status in DOWN_STATES:
        code = state.get("exit_code", info.get("exit_code", -1))
        sev = Severity.SEV2 if code == 0 else Severity.SEV1
        return TriageOutput(severity=sev, category="SERVICE_DOWN",
                            reasoning=f"Rule: container is not running (exit code {code}).")
    if itype == "CONTAINER_UNHEALTHY" or last.get("health") == "unhealthy":
        return TriageOutput(severity=Severity.SEV2, category="HEALTH_CHECK_FAILING",
                            reasoning="Rule: container is running but its health check is failing.")
    if itype == "HIGH_MEMORY" or float(last.get("mem_pct", 0) or 0) > 90:
        return TriageOutput(severity=Severity.SEV2, category="RESOURCE_EXHAUSTION",
                            reasoning="Rule: memory above 90% of the container limit.")
    if itype == "HIGH_CPU" or float(last.get("cpu_pct", 0) or 0) > 90:
        return TriageOutput(severity=Severity.SEV2, category="CPU_SATURATION",
                            reasoning="Rule: CPU above 90% for the sustained window.")

    suggested = state.get("rule_suggested_severity", "")
    sev = Severity(suggested) if suggested in Severity.__members__ else Severity.SEV3
    return TriageOutput(severity=sev, category="UNKNOWN",
                        reasoning="Rule: default classification; no specific condition matched.")


async def run(state: IncidentState) -> dict:
    """The LangGraph node. Returns only the keys it adds."""
    out, run_record = await think(TriageOutput, build_prompt(state), NAME, lambda: rules(state))
    return {
        "severity": out.severity.value,
        "category": out.category,
        "triage_reasoning": out.reasoning,
        "runs": [run_record],
    }
