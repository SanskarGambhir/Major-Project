"""
AGENT 4 — RCA: "what happened, for the record?"

Runs AFTER the server has executed and verified the fix — a separate call
(POST /agent/rca), not a node in the analyze graph (agentsfile.md §3). Its
input is the exact `incident_events` timeline plus the `actions` rows. Give an
LLM a vague prompt and you get vague prose; give it real timestamps and it
writes something that reads like a postmortem. Report quality is set by input
quality, not prompt cleverness.

Output: RcaOutput{report, recommendations[]}  (+ one AgentRun)
"""

from __future__ import annotations

from app.schemas.outputs import RcaOutput
from app.schemas.state import AgentRun
from app.services import evidence
from app.services.llm import think
from app.services.prompts import render

NAME = "rca"


def build_prompt(incident: dict, timeline: list[dict], actions: list[dict], similar: list[str]) -> str:
    ev = incident.get("evidence") or []
    return render(
        NAME,
        incident_id=incident.get("id", ""),
        service=incident.get("service", ""),
        incident_type=incident.get("type", ""),
        severity=incident.get("severity", "") or "unknown",
        final_status=_final_status(timeline) or incident.get("status", "") or "unknown",
        recovery_time=evidence.duration_text(evidence.recovery_seconds(incident, timeline)),
        confidence=f"{float(incident.get('confidence', 0) or 0):.2f}",
        root_cause=incident.get("root_cause", "") or "(none recorded)",
        evidence_block="\n".join(f"    - {e}" for e in ev) if ev else "    (none recorded)",
        proposed_action=incident.get("proposed_action", "") or "(none)",
        target=incident.get("target", "") or incident.get("service", ""),
        risk=incident.get("risk", "") or "unknown",
        timeline_block=evidence.timeline_block(timeline),
        actions_block=evidence.actions_block(actions),
        similar_block=evidence.similar_block(similar),
    )


def _final_status(timeline: list[dict]) -> str:
    for e in reversed(timeline):
        if e.get("status"):
            return str(e["status"])
    return ""


def rules(incident: dict, timeline: list[dict], actions: list[dict]) -> RcaOutput:
    """
    Rung 3: a templated report assembled from the record. Less prose, same
    facts. It says on its face that no model wrote it.
    """
    service = incident.get("service", "the service")
    itype = incident.get("type", "")
    recovery = evidence.duration_text(evidence.recovery_seconds(incident, timeline))
    root_cause = incident.get("root_cause") or f"{service} raised a {itype or 'unknown'} incident; no root-cause analysis was recorded."
    ev = incident.get("evidence") or []
    action = incident.get("proposed_action") or ""
    target = incident.get("target") or service

    executed = [a for a in actions if a.get("result") == "success"]
    denied = [a for a in actions if a.get("result") == "denied"]
    approved_by = next((e.get("actor") for e in timeline if e.get("status") == "EXECUTING" and e.get("actor") not in ("ai-auto", "ai", "system", None)), None)
    verified = next((e for e in timeline if e.get("status") == "RESOLVED"), None)
    final = _final_status(timeline) or incident.get("status", "")

    remediation = []
    if executed:
        a = executed[-1]
        who = f"approved by {approved_by}" if approved_by else "run automatically"
        remediation.append(f"{a.get('action_type', action)} on {a.get('target', target)} — {who}.")
    elif action:
        remediation.append(f"{action} on {target} was proposed" + (f"; refused: {denied[-1].get('policy_reason')}" if denied else " but no successful execution is recorded") + ".")
    else:
        remediation.append("No automated action was proposed.")
    if final == "AUTO_RESOLVED":
        remediation.append("The service recovered on its own before any action ran.")

    verification = verified.get("message", "") if verified else f"No verification recorded; final status {final or 'unknown'}."

    recs = []
    if action in ("RESTART_CONTAINER", "START_CONTAINER") and final in ("RESOLVED", "CLOSED"):
        recs.append(f"The restart restored {service} but did not change the code that failed; treat this as a symptom fix and investigate the underlying cause ({itype}).")
    if itype == "CONTAINER_OOM_KILLED":
        recs.append(f"Profile {service}'s memory growth and either fix the leak or raise the container limit with a justification.")
        recs.append(f"Set restart_policy to 'unless-stopped' on {service} so it self-recovers while the leak remains unfixed.")
    elif itype == "HIGH_CPU":
        recs.append(f"Identify the code path that saturates CPU in {service} and add a bound or a timeout to it.")
    elif itype in ("CONTAINER_EXITED", "CONTAINER_UNHEALTHY"):
        recs.append(f"Read {service}'s logs from just before the exit and add a health check that fails earlier.")
    if denied:
        recs.append("A proposed action was refused by policy; review whether the policy or the proposal was wrong.")
    if not recs:
        recs.append(f"Review the timeline for {service} and record the root cause once it is known.")

    report = "\n".join([
        f"INCIDENT REPORT — {incident.get('id', '')}",
        "",
        f"Service: {service}     Severity: {incident.get('severity', '') or 'unknown'}     Recovery time: {recovery}",
        "",
        "ROOT CAUSE",
        root_cause,
        "",
        "EVIDENCE",
        *([f"· {e}" for e in ev] or ["· (no evidence recorded)"]),
        "",
        "REMEDIATION",
        *remediation,
        "",
        "VERIFICATION",
        verification,
        "",
        "RECOMMENDATIONS",
        *[f"{i}. {r}" for i, r in enumerate(recs, 1)],
        "",
        "(Generated from the incident record by fixed rules — no language model was available.)",
    ])
    return RcaOutput(report=report, recommendations=recs)


async def run(incident: dict, timeline: list[dict], actions: list[dict], similar: list[str]) -> tuple[RcaOutput, AgentRun]:
    prompt = build_prompt(incident, timeline, actions, similar)
    out, run_record = await think(RcaOutput, prompt, NAME, lambda: rules(incident, timeline, actions))
    return out, run_record
