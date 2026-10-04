"""
Agent 3 — Mitigate, in isolation.

This is the agent the security model rests on, so most of the tests are about
what it CANNOT do: return a word outside the enum, return an action the
server didn't offer, or point an action at a container other than the
incident's own.
"""

from __future__ import annotations

import pytest

from app.agents import mitigate
from app.routers.agent import to_state
from app.schemas.enums import ActionType, Provider, Risk
from app.schemas.outputs import MitigationOutput
from app.schemas.requests import AnalyzeRequest
from tests.conftest import make_rung

ALL = ["RESTART_CONTAINER", "START_CONTAINER", "CLEAR_DEMO_CACHE", "ESCALATE_TO_HUMAN"]


def state_from(fixture: dict, **overrides):
    st = to_state(AnalyzeRequest(**{**fixture, **overrides}))
    # As it arrives from Agents 1 and 2
    st.update(
        severity="SEV1", category="RESOURCE_EXHAUSTION", triage_reasoning="…",
        root_cause="Application memory exhaustion; heap grew to the 256 MB limit and the kernel OOM-killed it.",
        confidence=0.94,
        evidence=["Exit code 137", "Monotonic memory growth", "'JavaScript heap out of memory' in logs"],
    )
    return st


# --- prompt -------------------------------------------------------------------

def test_prompt_lists_only_the_allowed_actions(inc_1024):
    prompt = mitigate.build_prompt(state_from(inc_1024, allowed_actions=["RESTART_CONTAINER", "ESCALATE_TO_HUMAN"]))
    block = prompt.split("ALLOWED ACTIONS")[1].split("Guidance:")[0]
    offered = [line.split()[0] for line in block.splitlines() if line.startswith("  ")]
    assert offered == ["RESTART_CONTAINER", "ESCALATE_TO_HUMAN"]
    assert "Application memory exhaustion" in prompt
    assert "confidence 0.94" in prompt
    assert "select EXACTLY ONE" in prompt


def test_prompt_always_offers_escalation(inc_1024):
    prompt = mitigate.build_prompt(state_from(inc_1024, allowed_actions=["RESTART_CONTAINER"]))
    assert "ESCALATE_TO_HUMAN" in prompt
    # unknown names from the server are dropped, not echoed into the prompt
    prompt = mitigate.build_prompt(state_from(inc_1024, allowed_actions=["DELETE_EVERYTHING", "RESTART_CONTAINER"]))
    assert "DELETE_EVERYTHING" not in prompt


# --- rules rung ----------------------------------------------------------------

@pytest.mark.parametrize(
    "overrides, action",
    [
        ({}, ActionType.RESTART_CONTAINER),                                               # OOM
        ({"type": "CONTAINER_EXITED", "exit_code": 1, "oom_killed": False,
          "container_info": {"status": "exited", "exit_code": 1}}, ActionType.RESTART_CONTAINER),
        ({"type": "CONTAINER_EXITED", "exit_code": 0, "oom_killed": False,
          "container_info": {"status": "exited", "exit_code": 0}}, ActionType.START_CONTAINER),
        ({"type": "CONTAINER_UNHEALTHY", "container_info": {"status": "running"}}, ActionType.RESTART_CONTAINER),
        ({"type": "HIGH_MEMORY", "container_info": {"status": "running"}}, ActionType.RESTART_CONTAINER),
        ({"type": "HIGH_CPU", "container_info": {"status": "running"}}, ActionType.RESTART_CONTAINER),
        ({"type": "SOMETHING_NEW", "container_info": {"status": "running"}}, ActionType.ESCALATE_TO_HUMAN),
    ],
)
def test_rules_cover_every_incident_type(inc_1024, overrides, action):
    out = mitigate.rules(state_from(inc_1024, **overrides))
    assert out.action == action
    assert out.target == "demo-api"
    assert out.risk == {ActionType.ESCALATE_TO_HUMAN: Risk.NONE}.get(action, Risk.LOW)
    assert out.confidence == 0.5
    assert out.reasoning.startswith("Rule:")


async def test_no_rungs_means_rules_answer(inc_1024, rules_only):
    result = await mitigate.run(state_from(inc_1024))
    assert result["action"] == "RESTART_CONTAINER"
    assert result["target"] == "demo-api"
    assert result["risk"] == "LOW"
    assert result["action_confidence"] == 0.5
    assert result["runs"][0].agent == "mitigate" and result["runs"][0].provider == Provider.RULES


# --- the structural guards ---------------------------------------------------------

CANNED = {
    "action": "RESTART_CONTAINER", "target": "demo-api", "risk": "LOW", "confidence": 0.94,
    "reasoning": "A restart clears the leaked heap and restores service immediately. It treats the symptom, not the cause.",
}


async def test_model_answer_is_used_when_legal(inc_1024, fake_ladder):
    fake_ladder(make_rung(Provider.GEMINI, payload=CANNED, model="gemini-test"))
    result = await mitigate.run(state_from(inc_1024))
    assert result["action"] == "RESTART_CONTAINER"
    assert result["target"] == "demo-api"
    assert result["action_confidence"] == 0.94
    assert result["reasoning"] == CANNED["reasoning"]
    run = result["runs"][0]
    assert run.provider == Provider.GEMINI
    assert run.output["action"] == "RESTART_CONTAINER"


async def test_word_outside_the_enum_never_gets_through(inc_1024, fake_ladder):
    # "docker stop sre-postgres" is not an ActionType. Pydantic refuses it
    # before enforce() even runs; the ladder falls to rules.
    fake_ladder(make_rung(Provider.GEMINI, payload={**CANNED, "action": "docker stop sre-postgres"}))
    result = await mitigate.run(state_from(inc_1024))
    assert result["action"] == "RESTART_CONTAINER"
    assert result["runs"][0].provider == Provider.RULES
    assert "ValidationError" in result["runs"][0].error


async def test_action_not_offered_by_the_server_becomes_escalation(inc_1024, fake_ladder):
    fake_ladder(make_rung(Provider.GEMINI, payload={**CANNED, "action": "CLEAR_DEMO_CACHE", "target": "demo-cache"}))
    result = await mitigate.run(state_from(inc_1024, allowed_actions=["RESTART_CONTAINER", "ESCALATE_TO_HUMAN"]))
    assert result["action"] == "ESCALATE_TO_HUMAN"
    assert result["risk"] == "NONE"
    assert result["action_confidence"] == 0.0
    assert "not in this request's allowed actions" in result["reasoning"]
    run = result["runs"][0]
    # what we RETURNED is in output; what the model SAID is still in raw
    assert run.output["action"] == "ESCALATE_TO_HUMAN"
    assert "CLEAR_DEMO_CACHE" in run.raw


async def test_target_is_pinned_to_the_incidents_service(inc_1024, fake_ladder):
    # A poisoned log line talks the model into naming the platform database.
    fake_ladder(make_rung(Provider.GEMINI, payload={**CANNED, "target": "sre-postgres"}))
    result = await mitigate.run(state_from(inc_1024))
    assert result["action"] == "RESTART_CONTAINER"
    assert result["target"] == "demo-api"
    assert "pinned to the incident's own service" in result["reasoning"]


async def test_cache_flush_always_targets_the_cache(inc_1024, fake_ladder):
    fake_ladder(make_rung(Provider.GEMINI, payload={**CANNED, "action": "CLEAR_DEMO_CACHE", "target": "demo-api"}))
    result = await mitigate.run(state_from(inc_1024))
    assert result["action"] == "CLEAR_DEMO_CACHE"
    assert result["target"] == "demo-cache"
    assert result["risk"] == "MEDIUM"


async def test_risk_comes_from_the_catalog_not_the_model(inc_1024, fake_ladder):
    fake_ladder(make_rung(Provider.GEMINI, payload={**CANNED, "risk": "NONE"}))
    result = await mitigate.run(state_from(inc_1024))
    assert result["risk"] == "LOW"  # RESTART_CONTAINER is LOW in catalog.js


async def test_empty_allowed_list_can_only_escalate(inc_1024, fake_ladder):
    fake_ladder(make_rung(Provider.GEMINI, payload=CANNED))
    result = await mitigate.run(state_from(inc_1024, allowed_actions=[]))
    assert result["action"] == "ESCALATE_TO_HUMAN"


def test_enforce_is_a_pure_function(inc_1024):
    st = state_from(inc_1024)
    out = MitigationOutput(**CANNED)
    assert mitigate.enforce(out, st) == out
    assert mitigate.enforce(out.model_copy(update={"confidence": 3.0}), st).confidence == 1.0


# --- the whole graph and the HTTP route -----------------------------------------------

async def test_graph_runs_all_three_agents_in_order(inc_1024, fake_ladder):
    from app.graph.incident_graph import app_graph
    from app.routers.agent import to_state as raw_state

    rung = make_rung(Provider.GEMINI, payload=CANNED)  # only mitigate can parse this
    fake_ladder(rung)
    result = await app_graph.ainvoke(raw_state(AnalyzeRequest(**inc_1024)))
    assert [r.agent for r in result["runs"]] == ["triage", "investigate", "mitigate"]
    assert [r.provider for r in result["runs"]] == [Provider.RULES, Provider.RULES, Provider.GEMINI]
    # mitigate's prompt quoted investigate's (rules) root cause
    assert "OOM-killer" in rung.chat.calls[2]
    assert result["action"] == "RESTART_CONTAINER" and result["target"] == "demo-api"


async def test_analyze_route_is_complete(client, headers, inc_1024, rules_only):
    r = await client.post("/agent/analyze", json=inc_1024, headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    for key in ("severity", "category", "root_cause", "confidence", "evidence",
                "action", "target", "risk", "action_confidence", "reasoning", "provider", "runs"):
        assert key in body, key
    assert body["severity"] == "SEV1"
    assert body["confidence"] == 0.6
    assert body["action"] == "RESTART_CONTAINER"
    assert body["target"] == "demo-api"
    assert body["risk"] == "LOW"
    assert body["provider"] == "rules"
    assert [run["agent"] for run in body["runs"]] == ["triage", "investigate", "mitigate"]


async def test_validation_failure_does_not_cool_the_rung_down(inc_1024, fake_ladder):
    # A model that answers in the wrong shape is UP. The next agent must still try it.
    from app.services import llm
    fake_ladder(make_rung(Provider.GEMINI, payload={"severity": "SEV1", "category": "X", "reasoning": "triage shape"}))
    await mitigate.run(state_from(inc_1024))   # ValidationError → rules, no cooldown
    assert llm.cooldowns() == {}
