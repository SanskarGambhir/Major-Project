"""
The closed vocabularies. These are the security model (plan.md §6): the model
can only ever return one of these strings, so no AI text can become a command.
"""

from enum import Enum


class Severity(str, Enum):
    SEV1 = "SEV1"  # completely down, users affected now
    SEV2 = "SEV2"  # degraded but still serving
    SEV3 = "SEV3"  # warning, no user impact yet


class ActionType(str, Enum):
    # MUST match server/src/actions/catalog.js exactly. The server also sends
    # its live list as `allowed_actions` on every request, and the Mitigation
    # agent narrows to that — so a catalog change never widens what we return.
    RESTART_CONTAINER = "RESTART_CONTAINER"
    START_CONTAINER = "START_CONTAINER"
    CLEAR_DEMO_CACHE = "CLEAR_DEMO_CACHE"
    ESCALATE_TO_HUMAN = "ESCALATE_TO_HUMAN"


class Risk(str, Enum):
    NONE = "NONE"
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"


class Provider(str, Enum):
    GEMINI = "gemini"
    OLLAMA = "ollama"
    RULES = "rules"


# Mirror of catalog.js risk per action — used only by the rules fallback so it
# can label its own proposal. The server re-derives risk from its catalog anyway.
ACTION_RISK: dict[ActionType, Risk] = {
    ActionType.RESTART_CONTAINER: Risk.LOW,
    ActionType.START_CONTAINER: Risk.LOW,
    ActionType.CLEAR_DEMO_CACHE: Risk.MEDIUM,
    ActionType.ESCALATE_TO_HUMAN: Risk.NONE,
}
