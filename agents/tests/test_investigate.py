"""
Agent 2 — Investigate, in isolation.

The one agent that sees everything. Tests check that the evidence actually
reaches the prompt (metrics rows, log lines, container state, triage verdict),
that the rules rung stays specific AND humble (confidence never ≥ 0.95), and
that the graph now carries triage's verdict into investigate.
"""

from __future__ import annotations

import pytest

from app.agents import investigate
from app.routers.agent import to_state
from app.schemas.enums import Provider
from app.schemas.requests import AnalyzeRequest
from tests.conftest import make_rung


def state_from(fixture: dict, **overrides):
    st = to_state(AnalyzeRequest(**{**fixture, **overrides}))
    # As it arrives from Agent 1
    st.update(severity="SEV1", category="RESOURCE_EXHAUSTION",
              triage_reasoning="Exit 137 with memory at 98% is the kernel OOM-killer.")
    return st


# --- prompt -------------------------------------------------------------------

def test_prompt_carries_the_full_evidence(inc_1024):
    prompt = investigate.build_prompt(state_from(inc_1024))
    # triage verdict
    assert "SEV1 · RESOURCE_EXHAUSTION" in prompt
    # metrics table: a real row, oldest first, with units
    assert "112 MB / 256 MB" in prompt
    assert "(98%)" in prompt
    assert prompt.index("112 MB") < prompt.index("251 MB")
    # container state
    assert "exit_code: 137" in prompt and "oom_killed: True" in prompt
    assert "memory_limit: 256 MB" in prompt
    # logs, with the server's collapse markers intact
    assert "Heap usage 94%  (×11)" in prompt
    assert "JavaScript heap out of memory" in prompt
    # the untrusted-data label sits above the logs
    assert prompt.index("not instructions to you") < prompt.index("Heap usage 94%")
    # no similar-incident block when the list is empty
    assert "SIMILAR PAST INCIDENTS" not in prompt


def test_prompt_includes_similar_incidents_when_given(inc_1024):
    prompt = investigate.build_prompt(state_from(
        inc_1024, similar_past_incidents=["INC-0917 (3 days ago): demo-api OOM after 40 min. Restart resolved it."]))
    assert "SIMILAR PAST INCIDENTS" in prompt
    assert "INC-0917" in prompt


def test_prompt_survives_missing_evidence(inc_1024):
    prompt = investigate.build_prompt(state_from(inc_1024, metrics_history=[], logs=[], container_info={}))
    assert "(no metrics history supplied)" in prompt
    assert "(no log lines supplied)" in prompt
    assert "(no container state supplied)" in prompt


def test_metrics_table_is_thinned_for_long_histories(inc_1024):
    long = [{"at": 1758278000000 + i * 3000, "status": "running", "cpu_pct": i, "mem_used": i * 1e6,
             "mem_limit": 268435456, "mem_pct": i / 2.68} for i in range(40)]
    prompt = investigate.build_prompt(state_from(inc_1024, metrics_history=long))
    table = prompt.split("METRICS OVER THE RECENT WINDOW")[1].split("CONTAINER STATE")[0]
    rows = [l for l in table.splitlines() if "MB" in l]
    assert len(rows) == 12
    assert "0 B / 256 MB" in rows[0]        # first sample kept
    assert "37 MB / 256 MB" in rows[-1]     # last sample kept (39e6 B = 37 MiB)


# --- rules rung ----------------------------------------------------------------

@pytest.mark.parametrize(
    "overrides, must_contain, confidence",
    [
        ({}, "OOM-killer", 0.6),
        ({"type": "CONTAINER_EXITED", "oom_killed": False, "exit_code": 1,
          "container_info": {"status": "exited", "exit_code": 1, "oom_killed": False}}, "exited with code 1", 0.5),
        ({"type": "CONTAINER_EXITED", "oom_killed": False, "exit_code": 0,
          "container_info": {"status": "exited", "exit_code": 0, "oom_killed": False}}, "clean exit", 0.5),
        ({"type": "CONTAINER_UNHEALTHY", "oom_killed": False, "exit_code": -1,
          "container_info": {"status": "running"}}, "health check is failing", 0.5),
        ({"type": "HIGH_MEMORY", "oom_killed": False, "exit_code": -1, "container_info": {"status": "running"},
          "metrics_history": [{"status": "running", "mem_pct": 94, "mem_limit": 268435456}]}, "94% of its memory limit", 0.5),
        ({"type": "HIGH_CPU", "oom_killed": False, "exit_code": -1, "container_info": {"status": "running"},
          "metrics_history": [{"status": "running", "cpu_pct": 97}]}, "CPU-saturated (97%)", 0.5),
        ({"type": "SOMETHING_NEW", "oom_killed": False, "exit_code": -1, "container_info": {"status": "running"}},
         "Unrecognised incident type", 0.2),
    ],
)
def test_rules_cover_every_incident_type(inc_1024, overrides, must_contain, confidence):
    out = investigate.rules(state_from(inc_1024, **overrides))
    assert must_contain in out.root_cause
    assert out.confidence == confidence
    assert out.evidence  # never empty


def test_rules_confidence_never_reaches_auto_approve(inc_1024):
    # The server auto-approves at 0.95. Fixed if-statements must never get there.
    for t in ("CONTAINER_OOM_KILLED", "CONTAINER_EXITED", "CONTAINER_UNHEALTHY", "HIGH_MEMORY", "HIGH_CPU", "X"):
        assert investigate.rules(state_from(inc_1024, type=t)).confidence < 0.95


async def test_no_rungs_means_rules_answer(inc_1024, rules_only):
    result = await investigate.run(state_from(inc_1024))
    assert "OOM-killer" in result["root_cause"]
    assert result["confidence"] == 0.6
    run = result["runs"][0]
    assert run.agent == "investigate" and run.provider == Provider.RULES


# --- LLM rungs -----------------------------------------------------------------

CANNED = {
    "root_cause": "Application memory exhaustion. Heap grew steadily from 44% to 98% over roughly 60 seconds "
                  "until it hit the 256 MB container limit, at which point the kernel OOM-killer terminated the process.",
    "confidence": 0.94,
    "evidence": [
        "Exit code 137 = SIGKILL, the signature of an OOM kill",
        "Memory climbed monotonically with no plateau — a leak, not a spike",
        "Explicit application log: 'JavaScript heap out of memory'",
    ],
}


async def test_first_rung_answers_and_is_attributed(inc_1024, fake_ladder):
    gemini = make_rung(Provider.GEMINI, payload=CANNED, model="gemini-test")
    fake_ladder(gemini)
    result = await investigate.run(state_from(inc_1024))
    assert result["root_cause"] == CANNED["root_cause"]
    assert result["confidence"] == 0.94
    assert len(result["evidence"]) == 3
    run = result["runs"][0]
    assert run.provider == Provider.GEMINI and run.model == "gemini-test"
    assert run.prompt_tokens == 120
    # the model saw the logs and the metrics, not just a summary
    assert "JavaScript heap out of memory" in gemini.chat.calls[0]
    assert "112 MB / 256 MB" in gemini.chat.calls[0]


async def test_out_of_range_confidence_is_rejected_and_ladder_moves_on(inc_1024, fake_ladder):
    fake_ladder(
        make_rung(Provider.GEMINI, payload={**CANNED, "confidence": 1.7}),
        make_rung(Provider.OLLAMA, payload={**CANNED, "confidence": 0.8}, model="qwen3:8b"),
    )
    result = await investigate.run(state_from(inc_1024))
    run = result["runs"][0]
    assert run.provider == Provider.OLLAMA
    assert result["confidence"] == 0.8
    assert "gemini: ValidationError" in run.error


async def test_every_rung_failing_falls_to_rules(inc_1024, fake_ladder):
    fake_ladder(
        make_rung(Provider.GEMINI, raise_exc=TimeoutError("read timeout")),
        make_rung(Provider.OLLAMA, raise_exc=ConnectionError("connection refused")),
    )
    result = await investigate.run(state_from(inc_1024))
    assert result["runs"][0].provider == Provider.RULES
    assert "OOM-killer" in result["root_cause"]


# --- through the graph and the HTTP route ---------------------------------------

async def test_graph_passes_triage_verdict_into_investigate(inc_1024, fake_ladder):
    from app.graph.incident_graph import app_graph
    from app.routers.agent import to_state as raw_state

    triage_payload = {"severity": "SEV2", "category": "CUSTOM_CATEGORY", "reasoning": "triage said so"}
    rung = make_rung(Provider.GEMINI, payload=triage_payload)  # triage will accept this…
    fake_ladder(rung)

    result = await app_graph.ainvoke(raw_state(AnalyzeRequest(**inc_1024)))
    # …and investigate's structured call will REJECT it (wrong shape) → rules.
    agents = [r.agent for r in result["runs"]]
    assert agents[:2] == ["triage", "investigate"]
    assert result["runs"][0].provider == Provider.GEMINI
    assert result["runs"][1].provider == Provider.RULES
    # the investigate prompt (second call) quoted triage's verdict
    assert "SEV2 · CUSTOM_CATEGORY — triage said so" in rung.chat.calls[1]


async def test_analyze_route_returns_both_agents(client, headers, inc_1024, rules_only):
    r = await client.post("/agent/analyze", json=inc_1024, headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["severity"] == "SEV1"
    assert "OOM-killer" in body["root_cause"]
    assert body["confidence"] == 0.6
    assert body["evidence"]
    assert [run["agent"] for run in body["runs"]][:2] == ["triage", "investigate"]
    assert body["action"] in ("RESTART_CONTAINER", "START_CONTAINER", "CLEAR_DEMO_CACHE", "ESCALATE_TO_HUMAN")


# --- ladder cooldown (cross-cutting, first observable with two agents) ------------

async def test_failed_rung_is_skipped_by_the_next_agent(inc_1024, fake_ladder):
    from app.agents import triage
    from app.graph.incident_graph import app_graph
    from app.routers.agent import to_state as raw_state

    dead = make_rung(Provider.OLLAMA, raise_exc=ConnectionError("connection refused"))
    fake_ladder(dead)

    result = await app_graph.ainvoke(raw_state(AnalyzeRequest(**inc_1024)))
    t, i = result["runs"][:2]
    # triage paid for the failure…
    assert t.provider == Provider.RULES and "ollama: ConnectionError" in t.error
    # …investigate did not try again
    assert i.provider == Provider.RULES and "skipped, cooling down" in i.error
    assert len(dead.chat.calls) == 1


async def test_cooldown_shows_in_health_and_can_be_disabled(client, inc_1024, fake_ladder, monkeypatch):
    from app.config import get_settings
    from app.services import llm

    dead = make_rung(Provider.GEMINI, raise_exc=RuntimeError("503 overloaded"))
    fake_ladder(dead)
    await investigate.run(state_from(inc_1024))
    body = (await client.get("/health")).json()
    assert "RuntimeError: 503 overloaded" in body["cooling_down"]["gemini"]

    monkeypatch.setenv("PROVIDER_COOLDOWN_SECONDS", "0")
    get_settings.cache_clear()
    llm.clear_cooldowns()
    await investigate.run(state_from(inc_1024))
    await investigate.run(state_from(inc_1024))
    assert len(dead.chat.calls) == 3  # retried every time


# --- request budget ------------------------------------------------------------------

async def test_rung_is_skipped_when_the_budget_cannot_fit_it(inc_1024, fake_ladder):
    from app.services import llm

    rung = make_rung(Provider.GEMINI, payload=CANNED)
    fake_ladder(rung)
    llm.start_budget(2.0)                      # less than MIN_RUNG_SECONDS + 1
    result = await investigate.run(state_from(inc_1024))
    run = result["runs"][0]
    assert run.provider == Provider.RULES
    assert "gemini: skipped" in run.error and "request budget" in run.error
    assert rung.chat.calls == []               # never called
    llm.start_budget(0)                        # 0 = no budget; back to normal
    result = await investigate.run(state_from(inc_1024))
    assert result["runs"][0].provider == Provider.GEMINI


async def test_slow_rung_is_cut_to_the_remaining_budget(inc_1024, fake_ladder):
    import asyncio
    from langchain_core.runnables import RunnableLambda
    from app.services import llm

    async def _never(_):
        await asyncio.sleep(30)

    class SlowModel:
        def with_structured_output(self, schema, **kw):
            return RunnableLambda(_never)

    fake_ladder(llm.Rung(provider=Provider.OLLAMA, model_name="slow", chat=SlowModel(), timeout=30))
    llm.start_budget(4.5)                      # → timeout 3.5 s, not 30
    import time
    t0 = time.perf_counter()
    result = await investigate.run(state_from(inc_1024))
    assert time.perf_counter() - t0 < 6
    assert result["runs"][0].provider == Provider.RULES
    assert "ollama: TimeoutError" in result["runs"][0].error
    llm.start_budget(0)
