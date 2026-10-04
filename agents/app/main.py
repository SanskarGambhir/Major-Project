"""
The agents service — a stateless brain behind the Express server.

    uv run uvicorn app.main:app --port 8000 --reload

No lifespan hooks, no connection pools, no checkpointer. A request arrives,
the graph runs start to finish, the reply goes back, everything is forgotten.
Everything durable lives in Postgres and is written by the server.
"""

import logging

from fastapi import FastAPI

from app.routers import agent, health

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")


def create_app() -> FastAPI:
    app = FastAPI(
        title="AI SRE Command Center — agents",
        version="0.1.0",
        description="Triage → Investigate → Mitigate (LangGraph) and RCA, behind a shared-secret header.",
    )

    @app.get("/")
    async def root():
        return {
            "service": "AI SRE Command Center — agents",
            "status": "running",
            "health": "/health",
            "docs": "/docs",
        }

    app.include_router(health.router)
    app.include_router(agent.router)
    return app


app = create_app()
