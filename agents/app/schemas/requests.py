"""
What the Express server sends us. We fetch nothing ourselves (agentsfile.md §2):
the request body is the entire universe the agents can see.

`extra="allow"` everywhere: the server may add fields before we learn about
them, and rejecting a request over an unknown key would take the AI offline
for nothing.
"""

from pydantic import BaseModel, ConfigDict, Field


class MetricReading(BaseModel):
    """One poller sample — the shape from server/src/monitoring/poller.js."""

    model_config = ConfigDict(extra="allow")

    at: int | float | str = 0  # epoch ms from the poller, or ISO from the DB
    status: str = ""  # running | exited | dead | ...
    health: str = "none"  # healthy | unhealthy | starting | none
    cpu_pct: float = 0
    mem_used: float = 0  # bytes
    mem_limit: float = 0  # bytes
    mem_pct: float = 0
    exit_code: int = -1
    oom_killed: bool = False
    restart_count: int = 0


class ContainerInfo(BaseModel):
    """A trimmed `docker inspect`, chosen by the server."""

    model_config = ConfigDict(extra="allow")

    status: str = ""
    memory_limit: int = 0  # bytes; 0 = unlimited
    restart_policy: str = "no"
    exit_code: int = -1
    oom_killed: bool = False
    started_at: str = ""
    finished_at: str = ""
    image: str = ""


class AnalyzeRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    incident_id: str
    service: str
    type: str = Field(description="CONTAINER_OOM_KILLED, CONTAINER_EXITED, HIGH_CPU, ...")
    exit_code: int = -1
    oom_killed: bool = False
    metrics_history: list[MetricReading] = []
    logs: list[str] = []
    container_info: ContainerInfo = ContainerInfo()
    allowed_actions: list[str] = []
    rule_suggested_severity: str = ""
    similar_past_incidents: list[str] = []


class TimelineEntry(BaseModel):
    """One row of incident_events — the input to the RCA prompt."""

    model_config = ConfigDict(extra="allow")

    at: str = ""
    status: str = ""
    actor: str = ""
    message: str = ""


class RcaIncident(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: str
    service: str = ""
    type: str = ""
    severity: str = ""
    root_cause: str = ""
    confidence: float = 0
    evidence: list[str] = []
    proposed_action: str = ""
    target: str = ""
    risk: str = ""
    detected_at: str = ""
    resolved_at: str = ""


class RcaRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    incident: RcaIncident
    timeline: list[TimelineEntry] = []
    actions: list[dict] = []
    similar_past_incidents: list[str] = []
