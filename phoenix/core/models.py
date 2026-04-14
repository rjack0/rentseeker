from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class VerificationStatus(str, Enum):
    VERIFIED = "verified"
    PROBABLE = "probable"
    UNCERTAIN = "uncertain"
    REJECTED = "rejected"


class DiscoveryNode(BaseModel):
    node_id: str
    entity_id: str
    node_type: str
    attributes: dict[str, Any] = Field(default_factory=dict)
    identifiers: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


class DiscoveredAttribute(BaseModel):
    name: str
    value: Any
    source: str
    confidence: float = Field(ge=0.0, le=1.0)
    timestamp: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class VerificationResult(BaseModel):
    attribute_name: str
    attribute_value: Any
    status: VerificationStatus
    evidence: list[str] = Field(default_factory=list)
    consensus_count: int = 0
    notes: str = ""


class ConfidenceResult(BaseModel):
    score: int = Field(ge=0, le=100)
    tier: str
    breakdown: dict[str, float] = Field(default_factory=dict)
    recommendations: list[str] = Field(default_factory=list)


class DiscoveryRunResult(BaseModel):
    entity_id: str
    signal_score: int
    route: str
    nodes: list[DiscoveryNode] = Field(default_factory=list)
    attributes: list[DiscoveredAttribute] = Field(default_factory=list)
    verifications: list[VerificationResult] = Field(default_factory=list)
    confidence: ConfidenceResult | None = None
    exported_to: list[str] = Field(default_factory=list)
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    errors: list[dict[str, str]] = Field(default_factory=list)
