"""Backend configuration via pydantic-settings.

Reads environment variables (and an optional .env file) to surface the
configuration values used across the backend. Secrets must never be logged.
"""
from __future__ import annotations

from typing import Optional

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    MONGO_URI: str = "mongodb://localhost:27017"
    MONGO_DB_NAME: str = "mindmap"

    GROQ_API_KEY: Optional[str] = None
    AGENTVERSE_API_KEY: Optional[str] = None

    TOPOLOGY_AGENT_PORT: int = 8001
    ENRICHMENT_AGENT_PORT: int = 8002

    # Path to addresses written by the agents subprocess.
    AGENT_ADDRESSES_PATH: str = "agents/.addresses.json"

    # Behavior tunables.
    TOPOLOGY_DEBOUNCE_SECONDS: float = 1.2
    RING_BUFFER_WORDS: int = 200
    ATTENTION_INTERVAL_SECONDS: float = 30.0
    ATTENTION_MIN_MENTIONS: int = 3
    ATTENTION_NODE_COOLDOWN_SECONDS: float = 90.0


_settings: Optional[Settings] = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings


def redact(value: Optional[str]) -> str:
    """Redact a secret for safe logging."""
    if not value:
        return "<unset>"
    if len(value) <= 8:
        return "***"
    return f"{value[:3]}...{value[-2:]}"
