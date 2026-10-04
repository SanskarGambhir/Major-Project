"""The shared-secret gate. There is no other auth in this service."""

import pytest

from app.config import get_settings

pytestmark = pytest.mark.asyncio


async def test_health_is_open(client):
    r = await client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["provider"] in ("gemini", "ollama", "rules")


async def test_missing_secret_is_401(client):
    r = await client.post("/agent/analyze", json={})
    assert r.status_code == 401


async def test_wrong_secret_is_401(client):
    r = await client.post("/agent/analyze", json={}, headers={"X-Agent-Secret": "nope"})
    assert r.status_code == 401


async def test_right_secret_passes_the_gate(client, headers):
    # An empty body is a validation error (422), NOT an auth error — proof the
    # gate opened and the request reached the route.
    r = await client.post("/agent/analyze", json={}, headers=headers)
    assert r.status_code == 422


async def test_unconfigured_secret_fails_closed(client, monkeypatch, headers):
    monkeypatch.setenv("AGENT_SECRET", "")
    get_settings.cache_clear()
    r = await client.post("/agent/analyze", json={}, headers=headers)
    assert r.status_code == 503
