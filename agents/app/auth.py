"""
Authentication — there isn't one, on purpose.

Users, roles, logins and JWTs are owned by the Express server (Phase 5). This
service only ever talks to that server, and the server proves it is itself with
ONE shared secret header:

    X-Agent-Secret: <AGENT_SECRET>

The value must be identical in server/.env and agents/.env. Nothing else is
accepted, and there is no way to obtain a "token" from this service.

Fail closed: if AGENT_SECRET is not configured here, every protected request is
refused with 503 rather than silently letting everything through.
"""

import hmac

from fastapi import Header, HTTPException, status

from app.config import get_settings


async def require_agent_secret(x_agent_secret: str = Header(default="")) -> None:
    expected = get_settings().agent_secret
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="AGENT_SECRET is not configured on the agents service",
        )
    # Constant-time compare: a plain == leaks how many leading bytes matched.
    if not hmac.compare_digest(x_agent_secret.encode(), expected.encode()):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid or missing X-Agent-Secret",
        )
