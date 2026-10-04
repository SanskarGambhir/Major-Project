"""
The LangGraph state. Lives for exactly one /agent/analyze call, then is gone.

Everything under "given by the server" arrives in the request. Each agent node
returns ONLY the keys it adds; LangGraph merges them in. `runs` is a reducer
(operator.add) so every node can append its AgentRun without clobbering the
others.
"""

import operator
from typing import Annotated, TypedDict

from pydantic import BaseModel

from app.schemas.enums import Provider


class AgentRun(BaseModel):
    """
    One agent's attempt, in exactly the shape of the server's agent_runs table
    (server/src/db/schema.sql). The server writes these rows verbatim.
    """

    agent: str  # triage | investigate | mitigate | rca
    provider: Provider
    model: str = ""
    latency_ms: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    output: dict = {}
    raw: str = ""  # what the model actually said
    ok: bool = True
    error: str = ""  # why the higher rungs failed, if they did


class IncidentState(TypedDict, total=False):
    # --- given by the server -------------------------------------------------
    incident_id: str
    service: str
    incident_type: str
    exit_code: int
    oom_killed: bool
    metrics_history: list[dict]
    logs: list[str]
    container_info: dict
    allowed_actions: list[str]
    rule_suggested_severity: str
    similar_past_incidents: list[str]

    # --- added by triage -----------------------------------------------------
    severity: str
    category: str
    triage_reasoning: str

    # --- added by investigate ------------------------------------------------
    root_cause: str
    confidence: float
    evidence: list[str]

    # --- added by mitigate ---------------------------------------------------
    action: str
    target: str
    risk: str
    action_confidence: float
    reasoning: str

    # --- bookkeeping, appended by every node ---------------------------------
    runs: Annotated[list[AgentRun], operator.add]
