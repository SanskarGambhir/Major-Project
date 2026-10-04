"""
The fallback ladder — the single most important code for surviving a demo.

    Gemini (cloud)  →  Ollama (local)  →  the agent's own rules

Every agent calls `think()` once. It walks the rungs in order, times each one,
catches EVERYTHING (network errors, 429s, safety blocks, malformed JSON, a
`None` from a safety filter) and drops to the next rung. The last rung is plain
Python and cannot fail, so `think()` always returns an answer.

WHY AN EXPLICIT LOOP AND NOT `with_fallbacks()`
---------------------------------------------------------------------------
LangChain's `with_fallbacks` gives the same behaviour but hides WHICH rung
answered. The server writes every attempt to its `agent_runs` table
(provider, model, tokens, latency, raw text) and the dashboard shows a
provider pill (green gemini / amber local / grey rules). Both need
attribution, so each rung is invoked by hand and the winner is recorded in an
`AgentRun` that rides back on the state.
"""

from __future__ import annotations

import asyncio
import contextvars
import logging
import time
from dataclasses import dataclass
from typing import Callable, TypeVar

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage
from pydantic import BaseModel, ValidationError

from app.config import Settings, get_settings
from app.schemas.enums import Provider
from app.schemas.state import AgentRun

log = logging.getLogger("agents.llm")

T = TypeVar("T", bound=BaseModel)


@dataclass
class Rung:
    provider: Provider
    model_name: str
    chat: BaseChatModel
    timeout: float


# -----------------------------------------------------------------------------
# Building the rungs
# -----------------------------------------------------------------------------

def _gemini_rung(s: Settings) -> Rung | None:
    if not s.gemini_api_key:
        return None
    from langchain_google_genai import ChatGoogleGenerativeAI, HarmBlockThreshold, HarmCategory

    # Gemini's safety filters trip on ordinary SRE words — kill, fatal, abort,
    # terminate — that appear in every container log. Most permissive everywhere.
    safety = {
        HarmCategory.HARM_CATEGORY_HARASSMENT: HarmBlockThreshold.BLOCK_NONE,
        HarmCategory.HARM_CATEGORY_HATE_SPEECH: HarmBlockThreshold.BLOCK_NONE,
        HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT: HarmBlockThreshold.BLOCK_NONE,
        HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT: HarmBlockThreshold.BLOCK_NONE,
    }
    chat = ChatGoogleGenerativeAI(
        model=s.gemini_model,
        google_api_key=s.gemini_api_key,
        temperature=s.gemini_temperature,
        timeout=s.gemini_timeout_seconds,
        safety_settings=safety,
        max_retries=1,
    )
    return Rung(Provider.GEMINI, s.gemini_model, chat, s.gemini_timeout_seconds)


def _ollama_rung(s: Settings) -> Rung | None:
    if not s.ollama_enabled:
        return None
    from langchain_ollama import ChatOllama

    chat = ChatOllama(
        model=s.ollama_model,
        base_url=s.ollama_url,
        temperature=s.gemini_temperature,
        # Ollama defaults to 2048 regardless of the model's real window, which
        # truncates the prompt from the FRONT and eats the instructions.
        num_ctx=s.ollama_num_ctx,
        # qwen3 "thinks" out loud before answering; that prose breaks JSON output.
        reasoning=False,
        client_kwargs={"timeout": s.ollama_timeout_seconds},
    )
    return Rung(Provider.OLLAMA, s.ollama_model, chat, s.ollama_timeout_seconds)


_rungs: list[Rung] | None = None
_override: list[Rung] | None = None


def get_rungs() -> list[Rung]:
    """The configured ladder, built once. Tests replace it with set_rungs()."""
    global _rungs
    if _override is not None:
        return _override
    if _rungs is None:
        s = get_settings()
        _rungs = [r for r in (_gemini_rung(s), _ollama_rung(s)) if r is not None]
        log.info("LLM ladder: %s → rules", " → ".join(f"{r.provider.value}({r.model_name})" for r in _rungs) or "(none)")
    return _rungs


def set_rungs(rungs: list[Rung] | None) -> None:
    """Test hook: force a specific ladder. None restores the configured one."""
    global _override, _last_provider, _last_model
    _override = rungs
    _last_provider, _last_model = None, ""
    clear_cooldowns()


# The most recent rung that actually answered — what /health reports.
_last_provider: Provider | None = None
_last_model: str = ""

# COOLDOWN. A rung that just failed is skipped for a short while. Without this
# every agent in a request pays the same timeout again (3 agents × a 10 s
# Ollama load failure = 30 s, which is the server's whole budget). With it the
# first agent pays, the rest go straight to the next rung, and the outage is
# retried automatically a minute later.
_cooldown_until: dict[Provider, float] = {}
_cooldown_reason: dict[Provider, str] = {}


def _in_cooldown(provider: Provider) -> bool:
    return time.monotonic() < _cooldown_until.get(provider, 0.0)


def cooldowns() -> dict[str, str]:
    """Rungs currently being skipped, and why. For /health."""
    return {p.value: r for p, r in _cooldown_reason.items() if _in_cooldown(p)}


def clear_cooldowns() -> None:
    _cooldown_until.clear()
    _cooldown_reason.clear()


# REQUEST BUDGET. The route sets a deadline for the whole request; each
# think() call sizes its rung timeouts to what is left, and skips a rung that
# can't fit. Without this, three agents × (Gemini timeout + Ollama timeout)
# blows straight past the server's own timeout, and the server records
# "unreachable" while we carry on generating a reply nobody will read.
_deadline: contextvars.ContextVar[float | None] = contextvars.ContextVar("deadline", default=None)

MIN_RUNG_SECONDS = 3.0   # not worth starting an LLM call with less than this


def start_budget(seconds: float | None = None) -> None:
    """Call once at the start of a request. None = the configured default."""
    s = get_settings().request_budget_seconds if seconds is None else seconds
    _deadline.set(time.monotonic() + s if s and s > 0 else None)


def remaining_budget() -> float | None:
    d = _deadline.get()
    return None if d is None else max(0.0, d - time.monotonic())


def last_provider() -> tuple[Provider | None, str]:
    return _last_provider, _last_model


def configured_provider() -> tuple[Provider, str]:
    """Best guess before any request has run: the top rung we have keys for."""
    rungs = get_rungs()
    if rungs:
        return rungs[0].provider, rungs[0].model_name
    return Provider.RULES, "rules"


# -----------------------------------------------------------------------------
# think()
# -----------------------------------------------------------------------------

def _message_text(msg: AIMessage | None) -> str:
    if msg is None:
        return ""
    c = msg.content
    if isinstance(c, str):
        return c
    parts = []
    for p in c:
        if isinstance(p, str):
            parts.append(p)
        elif isinstance(p, dict) and "text" in p:
            parts.append(str(p["text"]))
    return "".join(parts)


async def _invoke_rung(rung: Rung, schema: type[T], prompt: str, timeout: float) -> tuple[T, AIMessage | None]:
    structured = rung.chat.with_structured_output(schema, include_raw=True)
    res = await asyncio.wait_for(structured.ainvoke(prompt), timeout=timeout)

    raw = res.get("raw") if isinstance(res, dict) else None
    parsed = res.get("parsed") if isinstance(res, dict) else res
    perr = res.get("parsing_error") if isinstance(res, dict) else None

    # On some langchain-google-genai versions a safety-filter block returns
    # None instead of raising. Without this you get a NoneType crash mid-demo.
    if parsed is None:
        raise ValueError(str(perr) if perr else "blocked or empty response")
    if isinstance(parsed, dict):
        parsed = schema.model_validate(parsed)
    return parsed, raw


async def think(
    schema: type[T],
    prompt: str,
    agent: str,
    rules: Callable[[], T],
) -> tuple[T, AgentRun]:
    """
    Ask the ladder for a `schema`-shaped answer to `prompt`.

    Returns the answer and an AgentRun describing who answered, how long it
    took and — if higher rungs failed — why. Never raises.
    """
    global _last_provider, _last_model
    errors: list[str] = []
    settings = get_settings()
    if settings.log_prompts:
        log.info("[%s] prompt:\n%s", agent, prompt)

    for rung in get_rungs():
        if _in_cooldown(rung.provider):
            errors.append(f"{rung.provider.value}: skipped, cooling down after: {_cooldown_reason.get(rung.provider, '?')}")
            continue
        # Fit this rung into what's left of the request budget, or skip it.
        left = remaining_budget()
        timeout = rung.timeout if left is None else min(rung.timeout, left - 1.0)
        if timeout < MIN_RUNG_SECONDS:
            errors.append(f"{rung.provider.value}: skipped, {left:.1f}s left of the request budget")
            continue
        t0 = time.perf_counter()
        try:
            parsed, raw = await _invoke_rung(rung, schema, prompt, timeout)
            latency = int((time.perf_counter() - t0) * 1000)
            usage = (raw.usage_metadata or {}) if raw is not None else {}
            _last_provider, _last_model = rung.provider, rung.model_name
            log.info("[%s] %s/%s answered in %dms", agent, rung.provider.value, rung.model_name, latency)
            return parsed, AgentRun(
                agent=agent,
                provider=rung.provider,
                model=rung.model_name,
                latency_ms=latency,
                prompt_tokens=int(usage.get("input_tokens", 0) or 0),
                completion_tokens=int(usage.get("output_tokens", 0) or 0),
                output=parsed.model_dump(mode="json"),
                raw=_message_text(raw),
                ok=True,
                error="; ".join(errors),
            )
        except Exception as e:  # noqa: BLE001 — every failure means "next rung"
            latency = int((time.perf_counter() - t0) * 1000)
            reason = f"{rung.provider.value}: {type(e).__name__}: {str(e)[:200]}"
            errors.append(reason)
            log.warning("[%s] %s unavailable after %dms — %s", agent, rung.provider.value, latency, reason)
            # Only an AVAILABILITY failure earns a cooldown. A model that answered
            # in the wrong shape (ValidationError) or was safety-blocked
            # (ValueError) is up and may well answer the next agent correctly.
            if settings.provider_cooldown_seconds > 0 and not isinstance(e, (ValidationError, ValueError)):
                _cooldown_until[rung.provider] = time.monotonic() + settings.provider_cooldown_seconds
                _cooldown_reason[rung.provider] = f"{type(e).__name__}: {str(e)[:120]}"

    # Rung 3: plain if-statements. Always works.
    t0 = time.perf_counter()
    out = rules()
    _last_provider, _last_model = Provider.RULES, "rules"
    return out, AgentRun(
        agent=agent,
        provider=Provider.RULES,
        model="rules",
        latency_ms=int((time.perf_counter() - t0) * 1000),
        output=out.model_dump(mode="json"),
        raw="",
        ok=True,
        error="; ".join(errors),
    )
