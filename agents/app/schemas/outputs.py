"""
The shapes we ACCEPT from a model. We don't hope for good JSON; we define the
shape and `with_structured_output` enforces it — a bad shape raises, and the
ladder moves on.

TWO RULES, LEARNED THE HARD WAY (agentsfile.md §5.2)
---------------------------------------------------------------------------
1. Never use Optional[X]. Pydantic turns it into `anyOf`, and Gemini rejects
   `anyOf` with a 400 that doesn't explain itself. Required fields with
   sentinel values ("" / -1 / []) instead.
2. Enums are the security model. `action: ActionType` means the model CANNOT
   return anything but those four strings. Structural, not a polite request.
"""

from pydantic import BaseModel, Field

from app.schemas.enums import ActionType, Risk, Severity


class TriageOutput(BaseModel):
    """Agent 1 — how urgent is this?"""

    severity: Severity
    category: str = Field(description="Short upper-snake label, e.g. RESOURCE_EXHAUSTION, SERVICE_DOWN, DEPENDENCY_FAILURE")
    reasoning: str = Field(description="One or two sentences: why this severity, and whether the rule suggestion was confirmed or overridden")


class InvestigationOutput(BaseModel):
    """Agent 2 — what actually went wrong?"""

    root_cause: str
    confidence: float = Field(ge=0.0, le=1.0)
    evidence: list[str] = Field(description="Each item is one concrete fact from the supplied evidence")


class MitigationOutput(BaseModel):
    """Agent 3 — what should we do? `action` can ONLY be one of the catalog words."""

    action: ActionType
    target: str
    risk: Risk
    confidence: float = Field(ge=0.0, le=1.0)
    reasoning: str


class RcaOutput(BaseModel):
    """Agent 4 — the postmortem."""

    report: str
    recommendations: list[str]
