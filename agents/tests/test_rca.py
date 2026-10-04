"""
Agent 4 — RCA, in isolation.

The report is only as good as the timeline it's given, so the tests are mostly
about the record reaching the prompt intact, the recovery-time arithmetic, and
the rules rung producing a readable, honest report from the same record.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.agents import rca
from app.schemas.enums import Provider
from app.schemas.requests import RcaRequest
from app.services import evidence
from tests.conftest import make_rung

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def rca_1024() -> dict:
    return json.loads((FIXTURES / "rca-1024.json").read_text(encoding="utf-8"))


def parts(fixture: dict):
    req = RcaRequest(**fixture)
    return req.incident.model_dump(), [e.model_dump() for e in req.timeline], list(req.actions), list(req.similar_past_incidents)


# --- evidence helpers ------------------------------------------------------------

def test_recovery_time_from_incident_row(rca_1024):
    inc, tl, _, _ = parts(rca_1024)
    assert evidence.recovery_seconds(inc, tl) == 40.0
    assert evidence.duration_text(40.0) == "40 seconds"


def test_recovery_time_falls_back_to_timeline(rca_1024):
    inc, tl, _, _ = parts(rca_1024)
    inc["detected_at"] = inc["resolved_at"] = ""
    assert evidence.recovery_seconds(inc, tl) == 40.0
    assert evidence.recovery_seconds(inc, []) is None
    assert evidence.duration_text(None) == "unknown"
    assert evidence.duration_text(125) == "2m 05s"


def test_timeline_block_keeps_every_line_in_order(rca_1024):
    _, tl, _, _ = parts(rca_1024)
    block = evidence.timeline_block(tl)
    lines = block.splitlines()
    assert len(lines) == 6
    assert lines[0].startswith("  10:32:16  DETECTED")
    assert "priya" in lines[3] and "EXECUTING" in lines[3]
    assert lines[-1].startswith("  10:32:56  RESOLVED")


def test_actions_block_shows_proof_and_refusals():
    ok = [{"action_type": "RESTART_CONTAINER", "target": "demo-api", "result": "success",
           "started_at_before": "A", "started_at_after": "B"}]
    assert "StartedAt A → B" in evidence.actions_block(ok)
    denied = [{"action_type": "RESTART_CONTAINER", "target": "sre-postgres", "result": "denied",
               "policy_reason": "sre-postgres is a platform container"}]
    assert "denied — sre-postgres is a platform container" in evidence.actions_block(denied)
    assert "(no actions recorded)" in evidence.actions_block([])


# --- prompt ----------------------------------------------------------------------

def test_prompt_is_built_from_the_record(rca_1024):
    prompt = rca.build_prompt(*parts(rca_1024))
    assert "INC-1024" in prompt
    assert "Recovery time:    40 seconds" in prompt
    assert "Final status:     RESOLVED" in prompt
    assert "confidence 0.94" in prompt
    assert "kernel OOM-killer" in prompt
    assert "- Exit code 137 = SIGKILL" in prompt
    # the timeline, verbatim
    assert "10:32:40  EXECUTING           priya      RESTART_CONTAINER on demo-api requested by priya" in prompt
    assert "confidence 0.94 < 0.95" in prompt
    # the action with its StartedAt proof
    assert "RESTART_CONTAINER on demo-api: success (StartedAt 2026-09-19T10:28:31.114Z → 2026-09-19T10:32:42.902Z)" in prompt
    assert "SIMILAR PAST INCIDENTS" not in prompt
    for heading in ("ROOT CAUSE", "EVIDENCE", "REMEDIATION", "VERIFICATION", "RECOMMENDATIONS"):
        assert heading in prompt


def test_prompt_survives_an_empty_record():
    prompt = rca.build_prompt({"id": "INC-1", "service": "demo-api"}, [], [], [])
    assert "(no timeline supplied)" in prompt
    assert "(no actions recorded)" in prompt
    assert "Recovery time:    unknown" in prompt


# --- rules rung --------------------------------------------------------------------

def test_rules_report_is_specific_and_honest(rca_1024):
    inc, tl, acts, _ = parts(rca_1024)
    out = rca.rules(inc, tl, acts)
    r = out.report
    assert r.startswith("INCIDENT REPORT — INC-1024")
    assert "Service: demo-api     Severity: SEV1     Recovery time: 40 seconds" in r
    assert "kernel OOM-killer" in r
    assert "· Exit code 137 = SIGKILL" in r
    assert "RESTART_CONTAINER on demo-api — approved by priya." in r
    assert "Verified: demo-api healthy 7.0s after RESTART_CONTAINER" in r
    assert "no language model was available" in r
    # the bandage is named as a bandage
    assert any("symptom" in rec for rec in out.recommendations)
    assert any("unless-stopped" in rec for rec in out.recommendations)
    assert 2 <= len(out.recommendations) <= 4
    for i, rec in enumerate(out.recommendations, 1):
        assert f"{i}. {rec}" in r


def test_rules_report_for_an_auto_approved_and_denied_incident(rca_1024):
    inc, tl, _, _ = parts(rca_1024)
    tl[3] = {**tl[3], "actor": "ai-auto", "message": "RESTART_CONTAINER on demo-api requested by ai-auto"}
    denied = [{"action_type": "RESTART_CONTAINER", "target": "demo-api", "result": "denied",
               "policy_reason": "demo-api has already been restarted 3 times this hour"}]
    out = rca.rules(inc, tl, denied)
    assert "refused: demo-api has already been restarted 3 times" in out.report
    assert any("refused by policy" in rec for rec in out.recommendations)


def test_rules_report_for_auto_resolved():
    inc = {"id": "INC-7", "service": "demo-api", "type": "HIGH_CPU", "severity": "SEV2"}
    tl = [{"at": "2026-09-19T11:00:00Z", "status": "DETECTED", "actor": "monitor", "message": "CPU above 90%"},
          {"at": "2026-09-19T11:01:10Z", "status": "AUTO_RESOLVED", "actor": "monitor", "message": "CPU back to 12%"}]
    out = rca.rules(inc, tl, [])
    assert "recovered on its own" in out.report
    assert "Recovery time: 1m 10s" in out.report
    assert any("saturates CPU" in rec for rec in out.recommendations)


async def test_no_rungs_means_rules_answer(rca_1024, rules_only):
    out, run = await rca.run(*parts(rca_1024))
    assert run.agent == "rca" and run.provider == Provider.RULES
    assert "INCIDENT REPORT — INC-1024" in out.report


# --- LLM rungs ---------------------------------------------------------------------

CANNED = {
    "report": "INCIDENT REPORT — INC-1024\n\nROOT CAUSE\nThe demo-api container exhausted its 256 MB memory limit …",
    "recommendations": [
        "The underlying leak is NOT fixed; restarting treats the symptom only.",
        "Profile heap growth in the batch-processing path.",
        "Set restart_policy to unless-stopped so the service self-recovers while the leak remains unfixed.",
    ],
}


async def test_model_report_is_used_and_attributed(rca_1024, fake_ladder):
    rung = make_rung(Provider.GEMINI, payload=CANNED, model="gemini-test")
    fake_ladder(rung)
    out, run = await rca.run(*parts(rca_1024))
    assert out.report == CANNED["report"]
    assert out.recommendations == CANNED["recommendations"]
    assert run.provider == Provider.GEMINI and run.model == "gemini-test"
    assert run.prompt_tokens == 120
    # the model saw the real timeline
    assert "requested by priya" in rung.chat.calls[0]


async def test_bad_shape_falls_through_the_ladder(rca_1024, fake_ladder):
    fake_ladder(
        make_rung(Provider.GEMINI, payload={"report": "text only"}),           # missing recommendations
        make_rung(Provider.OLLAMA, raise_exc=ConnectionError("refused")),
    )
    out, run = await rca.run(*parts(rca_1024))
    assert run.provider == Provider.RULES
    assert "gemini: ValidationError" in run.error and "ollama: ConnectionError" in run.error
    assert "INCIDENT REPORT" in out.report


# --- HTTP ------------------------------------------------------------------------------

async def test_rca_route(client, headers, rca_1024, rules_only):
    r = await client.post("/agent/rca", json=rca_1024, headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["incident_id"] == "INC-1024"
    assert body["report"].startswith("INCIDENT REPORT — INC-1024")
    assert len(body["recommendations"]) >= 2
    assert body["provider"] == "rules"
    assert [run["agent"] for run in body["runs"]] == ["rca"]


async def test_rca_route_requires_the_secret(client, rca_1024):
    assert (await client.post("/agent/rca", json=rca_1024)).status_code == 401


async def test_rca_route_rejects_a_bodiless_request(client, headers):
    assert (await client.post("/agent/rca", json={}, headers=headers)).status_code == 422
