"""
POST /agent/analyze — one call, the whole graph, one JSON reply.
POST /agent/rca     — after the server has executed and verified: the report.

Both sit behind the shared-secret dependency. Nothing here touches Docker or
holds state between calls.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.agents import rca
from app.auth import require_agent_secret
from app.graph.incident_graph import app_graph
from app.schemas.requests import AnalyzeRequest, RcaRequest
from app.schemas.state import AgentRun, IncidentState
from app.services.llm import start_budget

router = APIRouter(prefix="/agent", tags=["agent"], dependencies=[Depends(require_agent_secret)])


class AnalyzeResponse(BaseModel):
    incident_id: str
    # triage
    severity: str = ""
    category: str = ""
    triage_reasoning: str = ""
    # investigate
    root_cause: str = ""
    confidence: float = 0.0
    evidence: list[str] = []
    # mitigate
    action: str = ""
    target: str = ""
    risk: str = ""
    # How sure Mitigate is that the action restores service. `confidence` above
    # is Investigate's certainty about the CAUSE. The server should gate
    # auto-approval on the lower of the two.
    action_confidence: float = 0.0
    reasoning: str = ""
    # bookkeeping — the LOWEST rung any agent had to fall to, and every attempt
    provider: str = ""
    runs: list[AgentRun] = []


_RANK = {"gemini": 0, "ollama": 1, "rules": 2}


def overall_provider(runs: list[AgentRun]) -> str:
    """If any agent fell to rules, the incident was (partly) rules — say so."""
    if not runs:
        return ""
    return max((r.provider.value for r in runs), key=lambda p: _RANK.get(p, 99))


def to_state(req: AnalyzeRequest) -> IncidentState:
    return IncidentState(
        incident_id=req.incident_id,
        service=req.service,
        incident_type=req.type,
        exit_code=req.exit_code,
        oom_killed=req.oom_killed,
        metrics_history=[m.model_dump() for m in req.metrics_history],
        logs=list(req.logs),
        container_info=req.container_info.model_dump(),
        allowed_actions=list(req.allowed_actions),
        rule_suggested_severity=req.rule_suggested_severity,
        similar_past_incidents=list(req.similar_past_incidents),
        runs=[],
    )


@router.post("/analyze", response_model=AnalyzeResponse)
async def analyze(req: AnalyzeRequest) -> AnalyzeResponse:
    start_budget()
    result: IncidentState = await app_graph.ainvoke(to_state(req))
    runs = result.get("runs", [])
    return AnalyzeResponse(
        incident_id=req.incident_id,
        severity=result.get("severity", ""),
        category=result.get("category", ""),
        triage_reasoning=result.get("triage_reasoning", ""),
        root_cause=result.get("root_cause", ""),
        confidence=result.get("confidence", 0.0),
        evidence=result.get("evidence", []),
        action=result.get("action", ""),
        target=result.get("target", ""),
        risk=result.get("risk", ""),
        action_confidence=result.get("action_confidence", 0.0),
        reasoning=result.get("reasoning", ""),
        provider=overall_provider(runs),
        runs=runs,
    )


class RcaResponse(BaseModel):
    incident_id: str
    report: str
    recommendations: list[str]
    provider: str
    runs: list[AgentRun]


@router.post("/rca", response_model=RcaResponse)
async def write_rca(req: RcaRequest) -> RcaResponse:
    start_budget()
    incident = req.incident.model_dump()
    timeline = [e.model_dump() for e in req.timeline]
    out, run = await rca.run(incident, timeline, list(req.actions), list(req.similar_past_incidents))
    return RcaResponse(
        incident_id=req.incident.id,
        report=out.report,
        recommendations=list(out.recommendations),
        provider=run.provider.value,
        runs=[run],
    )
