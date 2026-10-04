"""
Settings — every knob comes from agents/.env (template: .env.example).

Nothing here is required for the service to START. With no GEMINI_API_KEY and
no Ollama, every agent still answers from its rule-based fallback. That is the
whole point of the ladder: the service degrades, it never refuses to run.
"""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # --- Gemini (primary) ----------------------------------------------------
    gemini_api_key: str = ""
    gemini_model: str = "gemini-2.0-flash"
    gemini_timeout_seconds: float = 15
    gemini_temperature: float = 0.1

    # --- Ollama (local fallback) ---------------------------------------------
    ollama_url: str = "http://localhost:11434"
    ollama_model: str = "qwen3:8b"
    ollama_num_ctx: int = 8192
    ollama_timeout_seconds: float = 30
    ollama_enabled: bool = True

    # --- This service --------------------------------------------------------
    agent_port: int = 8000
    # Must be IDENTICAL to AGENT_SECRET in server/.env. Empty = fail closed.
    agent_secret: str = ""

    # --- ChromaDB (Phase 6) --------------------------------------------------
    chroma_path: str = "./chroma_data"
    chroma_collection: str = "incident_memory"
    memory_top_k: int = 3

    # --- Behaviour -----------------------------------------------------------
    repair_retries: int = 1
    log_prompts: bool = False
    # A rung that fails is skipped for this long, so one outage costs one
    # timeout per minute instead of one per agent. 0 disables.
    provider_cooldown_seconds: float = 60
    # Wall-clock budget for ONE request (all agents together). think() skips
    # an LLM rung when the time left can't fit it and answers from rules
    # instead, so the reply always arrives before the server's AGENT_TIMEOUT_MS
    # (default 120 s) gives up on us. Must be smaller than that.
    request_budget_seconds: float = 90


@lru_cache
def get_settings() -> Settings:
    return Settings()
