"""
Agent 1 — Triage, in isolation.

Three paths through the ladder, all offline:
  · a rung answers          → its answer is used, attributed, token-counted
  · the first rung fails    → the next rung answers, the failure is recorded
  · every rung fails / none → the rules answer, deterministically
"""

from __future__ import annotations

import os

import pytest

from app.agents import triage
from app.routers.agent import to_state
from app.schemas.enums import Provider, Severity
from app.schemas.requests import AnalyzeRequest
from tests.conftest import make_rung


def state_from(fixture: dict, **overrides):
    return to_state(AnalyzeRequest(**{**fixture, **overrides}))


# --- prompt -------------------------------------------------------------------

def test_prompt_has_the_facts_and_no_logs(inc_1024):
    prompt = triage.build_prompt(state_from(inc_1024))
    assert "demo-api" in prompt
    assert "CONTAINER_OOM_KILLED" in prompt
    assert "137" in prompt
    assert "98.2% of 256 MB" in prompt
    assert "Rule suggestion:  SEV1" in prompt
    # Triage sees basic facts only — no log lines (agentsfile.md §7).
    assert "heap out of memory" not in prompt
    assert "Processing batch" not in prompt


# --- rules rung ----------------------------------------------------------------

@pytest.mark.parametrize(
    "overrides, severity, category",
    [
        ({}, Severity.SEV1, "RESOURCE_EXHAUSTION"),
        ({"type": "CONTAINER_EXITED", "oom_killed": False, "exit_code": 1,
          "container_info": {"status": "exited", "exit_code": 1, "oom_killed": False}}, Severity.SEV1, "SERVICE_DOWN"),
        ({"type": "CONTAINER_EXITED", "oom_killed": False, "exit_code": 0,
          "container_info": {"status": "exited", "exit_code": 0, "oom_killed": False}}, Severity.SEV2, "SERVICE_DOWN"),
        ({"type": "CONTAINER_UNHEALTHY", "oom_killed": False, "exit_code": -1,
          "container_info": {"status": "running"},
          "metrics_history": [{"status": "running", "health": "unhealthy"}]}, Severity.SEV2, "HEALTH_CHECK_FAILING"),
        ({"type": "HIGH_MEMORY", "oom_killed": False, "exit_code": -1, "container_info": {"status": "running"},
          "metrics_history": [{"status": "running", "mem_pct": 94}]}, Severity.SEV2, "RESOURCE_EXHAUSTION"),
        ({"type": "HIGH_CPU", "oom_killed": False, "exit_code": -1, "container_info": {"status": "running"},
          "metrics_history": [{"status": "running", "cpu_pct": 97}]}, Severity.SEV2, "CPU_SATURATION"),
        ({"type": "SOMETHING_NEW", "oom_killed": False, "exit_code": -1, "container_info": {"status": "running"},
          "metrics_history": [{"status": "running"}], "rule_suggested_severity": "SEV3"}, Severity.SEV3, "UNKNOWN"),
    ],
)
def test_rules_cover_every_incident_type(inc_1024, overrides, severity, category):
    out = triage.rules(state_from(inc_1024, **overrides))
    assert out.severity == severity
    assert out.category == category
    assert out.reasoning.startswith("Rule:")


async def test_no_rungs_means_rules_answer(inc_1024, rules_only):
    result = await triage.run(state_from(inc_1024))
    assert result["severity"] == "SEV1"
    assert result["category"] == "RESOURCE_EXHAUSTION"
    run = result["runs"][0]
    assert run.agent == "triage"
    assert run.provider == Provider.RULES
    assert run.ok is True
    assert run.error == ""  # nothing above it failed — there was nothing above it


# --- LLM rungs -----------------------------------------------------------------

CANNED = {
    "severity": "SEV1",
    "category": "RESOURCE_EXHAUSTION",
    "reasoning": "Container is fully stopped; exit 137 with memory at 98% is the kernel OOM-killer.",
}


async def test_first_rung_answers_and_is_attributed(inc_1024, fake_ladder):
    gemini = make_rung(Provider.GEMINI, payload=CANNED, model="gemini-test")
    fake_ladder(gemini)

    result = await triage.run(state_from(inc_1024))
    assert result["severity"] == "SEV1"
    assert result["triage_reasoning"] == CANNED["reasoning"]
    run = result["runs"][0]
    assert run.provider == Provider.GEMINI
    assert run.model == "gemini-test"
    assert run.prompt_tokens == 120 and run.completion_tokens == 40
    assert run.raw and "RESOURCE_EXHAUSTION" in run.raw
    assert run.error == ""
    # the model saw the rendered prompt, not the raw state
    assert "Rule suggestion:  SEV1" in gemini.chat.calls[0]


async def test_gemini_failure_falls_to_ollama(inc_1024, fake_ladder):
    fake_ladder(
        make_rung(Provider.GEMINI, raise_exc=RuntimeError("429 quota exceeded")),
        make_rung(Provider.OLLAMA, payload={**CANNED, "severity": "SEV2"}, model="qwen3:8b"),
    )
    result = await triage.run(state_from(inc_1024))
    run = result["runs"][0]
    assert result["severity"] == "SEV2"
    assert run.provider == Provider.OLLAMA and run.model == "qwen3:8b"
    assert "gemini: RuntimeError: 429" in run.error


async def test_every_rung_failing_falls_to_rules(inc_1024, fake_ladder):
    fake_ladder(
        make_rung(Provider.GEMINI, raise_exc=ValueError("blocked or empty response")),
        make_rung(Provider.OLLAMA, raise_exc=ConnectionError("connection refused")),
    )
    result = await triage.run(state_from(inc_1024))
    run = result["runs"][0]
    assert run.provider == Provider.RULES
    assert result["severity"] == "SEV1"
    assert "gemini: ValueError" in run.error and "ollama: ConnectionError" in run.error


async def test_bad_enum_from_model_is_rejected_and_ladder_moves_on(inc_1024, fake_ladder):
    fake_ladder(make_rung(Provider.GEMINI, payload={**CANNED, "severity": "SEV0"}))
    result = await triage.run(state_from(inc_1024))
    assert result["runs"][0].provider == Provider.RULES
    assert "ValidationError" in result["runs"][0].error


# --- through the graph and the HTTP route ---------------------------------------

async def test_analyze_route_runs_triage(client, headers, inc_1024, rules_only):
    r = await client.post("/agent/analyze", json=inc_1024, headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["incident_id"] == "INC-1024"
    assert body["severity"] == "SEV1"
    assert body["provider"] == "rules"
    assert body["runs"][0]["agent"] == "triage"


# --- live (optional) -------------------------------------------------------------

@pytest.mark.live
@pytest.mark.skipif(not os.environ.get("LIVE_GEMINI_API_KEY"), reason="set LIVE_GEMINI_API_KEY to run")
async def test_live_gemini_triage(inc_1024, monkeypatch):
    from app.config import get_settings
    from app.services import llm

    monkeypatch.setenv("GEMINI_API_KEY", os.environ["LIVE_GEMINI_API_KEY"])
    get_settings.cache_clear()
    llm._rungs = None
    result = await triage.run(state_from(inc_1024))
    run = result["runs"][0]
    assert run.provider == Provider.GEMINI, run.error
    assert result["severity"] in ("SEV1", "SEV2")
