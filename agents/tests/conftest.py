"""
Shared fixtures.

- `client`: an httpx client against the FastAPI app, secret configured.
- `inc_1024`: the OOM incident from agentsfile.md §4, as the server would send it.
- `fake_ladder`: replaces the LLM rungs with a canned answer so agents are
  tested without network; `rules_only` removes every rung so the fallback
  path is exercised deterministically.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from langchain_core.language_models import BaseChatModel
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage
from langchain_core.runnables import RunnableLambda

from app.config import get_settings
from app.schemas.enums import Provider
from app.services import llm

SECRET = "test-secret-0123456789abcdef"
FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(autouse=True)
def _settings(monkeypatch):
    """Every test runs with a known secret, no Gemini key, no Ollama."""
    monkeypatch.setenv("AGENT_SECRET", SECRET)
    monkeypatch.setenv("GEMINI_API_KEY", "")
    monkeypatch.setenv("OLLAMA_ENABLED", "false")
    get_settings.cache_clear()
    llm._rungs = None
    llm.set_rungs(None)
    yield
    get_settings.cache_clear()
    llm._rungs = None
    llm.set_rungs(None)


@pytest.fixture
async def client():
    from app.main import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture
def headers() -> dict[str, str]:
    return {"X-Agent-Secret": SECRET}


@pytest.fixture
def inc_1024() -> dict[str, Any]:
    return json.loads((FIXTURES / "inc-1024.json").read_text(encoding="utf-8"))


class CannedStructuredModel(BaseChatModel):
    """
    A chat model whose with_structured_output() returns a fixed payload — or
    raises — so the ladder can be driven through every branch offline.
    """

    payload: Any = None
    raise_exc: Exception | None = None
    calls: list[str] = []

    @property
    def _llm_type(self) -> str:
        return "canned"

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):  # pragma: no cover
        raise NotImplementedError

    def with_structured_output(self, schema, *, include_raw=False, **kwargs):
        model = self

        async def _run(prompt):
            model.calls.append(prompt if isinstance(prompt, str) else str(prompt))
            if model.raise_exc is not None:
                raise model.raise_exc
            parsed = schema.model_validate(model.payload) if isinstance(model.payload, dict) else model.payload
            raw = AIMessage(
                content=json.dumps(model.payload) if isinstance(model.payload, dict) else "",
                usage_metadata={"input_tokens": 120, "output_tokens": 40, "total_tokens": 160},
            )
            return {"raw": raw, "parsed": parsed, "parsing_error": None}

        return RunnableLambda(_run)


def make_rung(provider: Provider, payload: Any = None, raise_exc: Exception | None = None, model="fake-model") -> llm.Rung:
    chat = CannedStructuredModel(payload=payload, raise_exc=raise_exc, calls=[])
    return llm.Rung(provider=provider, model_name=model, chat=chat, timeout=5)


@pytest.fixture
def fake_ladder():
    """Install a ladder built from (provider, payload | exception) pairs."""

    def _install(*rungs: llm.Rung):
        llm.set_rungs(list(rungs))
        return rungs

    yield _install
    llm.set_rungs(None)


@pytest.fixture
def rules_only():
    llm.set_rungs([])
    yield
    llm.set_rungs(None)
