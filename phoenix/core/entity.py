from __future__ import annotations

from datetime import datetime, timezone
from hashlib import sha256
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Entity(BaseModel):
    """Canonical normalized entity for the platform."""

    model_config = ConfigDict(extra="allow")

    entity_id: str | None = Field(default=None, description="Deterministic entity hash.")
    entity_type: str = Field(..., description="Configurable entity type.")
    primary_key: str = Field(..., description="Source-defined unique identifier.")
    attributes: dict[str, Any] = Field(default_factory=dict)
    identifiers: list[str] = Field(default_factory=list)
    relationships: list[dict[str, Any]] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def ensure_entity_id(self) -> "Entity":
        if not self.entity_id:
            self.entity_id = self.compute_id()
        if "ingested_at" not in self.metadata:
            self.metadata["ingested_at"] = datetime.now(timezone.utc).isoformat()
        return self

    def compute_id(self) -> str:
        payload = f"{self.entity_type}:{self.primary_key}"
        return sha256(payload.encode("utf-8")).hexdigest()[:16]

