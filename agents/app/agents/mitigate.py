"""
AGENT 3 — MITIGATE: "what should we do?"

Sees the root cause and the list of allowed actions. Returns ONE WORD from
that list — never a command. Two structural guards sit between the model and
the reply, and neither of them is a prompt:

  1. `MitigationOutput.action: ActionType` — Pydantic rejects anything that is
     not one of the four catalog strings before we ever see it.
  2. `enforce()` — the reply is narrowed to the request's `allowed_actions`
     (the server's live catalog) and the target is pinned to the incident's
     own service. A model that names sre-postgres gets overruled here, and the
     server's policy engine checks the Docker labels again anyway.

Adds to the state:  action, target, risk, reasoning  (+ one AgentRun)
"""

from __future__ import annotations

from app.schemas.enums import ACTION_RISK, ActionType, Risk
from app.schemas.outputs import MitigationOutput
from app.schemas.state import IncidentState
from app.services import evidence
from app.services.llm import think
from app.services.prompts import render

NAME = "mitigate"

# Mirror of catalog.js descriptions, for the prompt. The server's live list
# (`allowed_actions`) decides which of these are offered on a given request.
ACTION_DESCRIPTIONS: dict[str, str] = {
    ActionType.RESTART_CONTAINER.value: "restart a container that is unhealthy, stuck, or has crashed",
    ActionType.START_CONTAINER.value: "start a container that is currently stopped",
    ActionType.CLEAR_DEMO_CACHE.value: "flush the demo Redis cache to clear corrupt or stale entries",
    ActionType.ESCALATE_TO_HUMAN.value: "take no automated action and hand the incident to an engineer",
}

CACHE_TARGET = "demo-cache"
DOWN_STATES = ("exited", "dead")


def allowed(state: IncidentState) -> list[str]:
    """The request's allowed list, filtered to names we actually know. An empty
    or unknown list means only escalation is possible — fail safe, not open."""
    known = {a.value for a in ActionType}
    names = [a for a in (state.get("allowed_actions") or []) if a in known]
    if ActionType.ESCALATE_TO_HUMAN.value not in names:
        names.append(ActionType.ESCALATE_TO_HUMAN.value)
    return names


def build_prompt(state: IncidentState) -> str:
    info = state.get("container_info", {}) or {}
    last = evidence.latest_reading(state.get("metrics_history", []) or [])
    actions_block = "\n".join(f"  {name:<20} {ACTION_DESCRIPTIONS[name]}" for name in allowed(state))
    return render(
        NAME,
        service=state.get("service", ""),
        incident_type=state.get("incident_type", ""),
        container_status=info.get("status") or last.get("status") or "unknown",
        severity=state.get("severity", "") or "unknown",
        category=state.get("category", "") or "unknown",
        confidence=f"{float(state.get('confidence', 0) or 0):.2f}",
        root_cause=state.get("root_cause", "") or "(no root cause determined)",
        actions_block=actions_block,
    )


def rules(state: IncidentState) -> MitigationOutput:
    """Rung 3. The same table an on-call runbook would give you."""
    itype = state.get("incident_type", "")
    info = state.get("container_info", {}) or {}
    last = evidence.latest_reading(state.get("metrics_history", []) or [])
    status = info.get("status") or last.get("status") or ""
    exit_code = state.get("exit_code", info.get("exit_code", -1))
    service = state.get("service", "")

    if itype == "CONTAINER_OOM_KILLED" or itype == "CONTAINER_EXITED" or status in DOWN_STATES:
        if itype != "CONTAINER_OOM_KILLED" and exit_code == 0:
            action, why = ActionType.START_CONTAINER, "the container exited cleanly and only needs starting"
        else:
            action, why = ActionType.RESTART_CONTAINER, "the container is down; a restart replaces the process and restores service"
    elif itype in ("CONTAINER_UNHEALTHY", "HIGH_MEMORY", "HIGH_CPU"):
        action, why = ActionType.RESTART_CONTAINER, "the container is running but degraded; a restart resets its state"
    else:
        action, why = ActionType.ESCALATE_TO_HUMAN, "no rule covers this incident type"

    return MitigationOutput(
        action=action,
        target=CACHE_TARGET if action == ActionType.CLEAR_DEMO_CACHE else service,
        risk=ACTION_RISK[action],
        confidence=0.5,  # rules never auto-approve
        reasoning=f"Rule: {why}. This treats the symptom; the RCA should say whether the cause is fixed.",
    )


def enforce(out: MitigationOutput, state: IncidentState) -> MitigationOutput:
    """
    The structural guard. Whatever the model said:
      - the action must be in the request's allowed list, else ESCALATE
      - the target is the incident's service (demo-cache for the cache flush)
      - the risk is the catalog's risk for that action, not the model's opinion
    """
    service = state.get("service", "")
    names = allowed(state)
    action = out.action
    reasoning = out.reasoning
    confidence = out.confidence

    if action.value not in names:
        reasoning = (f"Model proposed {action.value}, which is not in this request's allowed actions "
                     f"({', '.join(names)}); escalating instead. Original reasoning: {reasoning}")
        action = ActionType.ESCALATE_TO_HUMAN
        confidence = 0.0

    if action == ActionType.CLEAR_DEMO_CACHE:
        target = CACHE_TARGET
    elif action == ActionType.ESCALATE_TO_HUMAN:
        target = service
    else:
        target = service
        if out.target and out.target != service:
            reasoning = f"Model named target '{out.target}'; pinned to the incident's own service '{service}'. {reasoning}"

    return MitigationOutput(
        action=action,
        target=target,
        risk=ACTION_RISK[action],
        confidence=max(0.0, min(1.0, float(confidence))),
        reasoning=reasoning,
    )


async def run(state: IncidentState) -> dict:
    """The LangGraph node. Returns only the keys it adds."""
    raw, run_record = await think(MitigationOutput, build_prompt(state), NAME, lambda: rules(state))
    out = enforce(raw, state)
    if out != raw:
        # The server stores `output` in agent_runs; make it the thing we
        # actually returned, and keep what the model said in `raw`.
        run_record = run_record.model_copy(update={"output": out.model_dump(mode="json")})
    return {
        "action": out.action.value,
        "target": out.target,
        "risk": out.risk.value,
        "action_confidence": out.confidence,
        "reasoning": out.reasoning,
        "runs": [run_record],
    }
