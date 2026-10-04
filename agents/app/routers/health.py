"""
GET /health — the server polls this every 10s to drive the provider pill.

Unauthenticated on purpose: it reveals only "which rung would answer", and the
server needs it BEFORE it has decided whether to trust us with an incident.
"""

from __future__ import annotations

import httpx
from fastapi import APIRouter

from app.config import get_settings
from app.schemas.enums import Provider
from app.services.llm import configured_provider, cooldowns, get_rungs, last_provider

router = APIRouter(tags=["health"])


async def _ollama_reachable(url: str) -> bool:
    try:
        async with httpx.AsyncClient(timeout=1.5) as client:
            r = await client.get(f"{url.rstrip('/')}/api/tags")
            return r.status_code == 200
    except httpx.HTTPError:
        return False


@router.get("/health")
async def health() -> dict:
    s = get_settings()
    rungs = {r.provider.value: r.model_name for r in get_rungs()}

    provider, model = last_provider()
    if provider is None:
        provider, model = configured_provider()

    return {
        "ok": True,
        "provider": provider.value,
        "model": model,
        "rungs": {
            "gemini": {"configured": Provider.GEMINI.value in rungs, "model": rungs.get("gemini", "")},
            "ollama": {
                "configured": Provider.OLLAMA.value in rungs,
                "model": rungs.get("ollama", ""),
                "reachable": await _ollama_reachable(s.ollama_url) if Provider.OLLAMA.value in rungs else False,
            },
            "rules": {"configured": True},
        },
        # Rungs being skipped right now after a failure, with the reason.
        "cooling_down": cooldowns(),
    }
