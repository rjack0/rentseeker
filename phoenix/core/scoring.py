from __future__ import annotations

from datetime import datetime, timezone

from phoenix.config import ScoringConfig

from .entity import Entity
from .models import ConfidenceResult, DiscoveredAttribute, VerificationResult, VerificationStatus


class ConfidenceScorer:
    """Calculate the final A/B/C confidence tier."""

    def __init__(self, config: ScoringConfig) -> None:
        self.weights = config.confidence_weights
        self.thresholds = config.tier_thresholds

    def score(
        self,
        entity: Entity,
        attributes: list[DiscoveredAttribute],
        verifications: list[VerificationResult],
    ) -> ConfidenceResult:
        identity_component = self._identity_match(entity, attributes)
        consensus_component = self._consensus(verifications)
        diversity_component = self._diversity(attributes)
        quality_component = self._quality(attributes)
        freshness_component = self._freshness(attributes)

        breakdown = {
            "identity_match": identity_component,
            "verification_consensus": consensus_component,
            "source_diversity": diversity_component,
            "signal_quality": quality_component,
            "temporal_freshness": freshness_component,
        }
        total = max(0, min(100, int(sum(breakdown.values()))))

        if total >= self.thresholds.get("A", 80):
            tier = "A"
        elif total >= self.thresholds.get("B", 60):
            tier = "B"
        else:
            tier = "C"

        recommendations = []
        if tier == "A":
            recommendations.append("Auto-accept is safe for this entity.")
        elif tier == "B":
            recommendations.append("Manual review recommended before export to trusted sinks.")
        else:
            recommendations.append("Suppress or re-run with broader connectors and more context.")

        if not attributes:
            recommendations.append("No attributes discovered; inspect input quality and connector coverage.")

        return ConfidenceResult(
            score=total,
            tier=tier,
            breakdown=breakdown,
            recommendations=recommendations,
        )

    def _identity_match(self, entity: Entity, attributes: list[DiscoveredAttribute]) -> float:
        known_values = {str(v).lower() for v in entity.attributes.values() if v not in (None, "")}
        hits = 0
        for attribute in attributes:
            if str(attribute.value).lower() in known_values:
                hits += 1
        ratio = hits / max(1, len(attributes))
        return ratio * self.weights.get("identity_match", 35.0)

    def _consensus(self, verifications: list[VerificationResult]) -> float:
        if not verifications:
            return 0.0
        verified = sum(v.status == VerificationStatus.VERIFIED for v in verifications)
        probable = sum(v.status == VerificationStatus.PROBABLE for v in verifications)
        normalized = ((verified * 1.0) + (probable * 0.6)) / len(verifications)
        return normalized * self.weights.get("verification_consensus", 25.0)

    def _diversity(self, attributes: list[DiscoveredAttribute]) -> float:
        if not attributes:
            return 0.0
        sources = {attribute.source for attribute in attributes}
        return min(self.weights.get("source_diversity", 20.0), len(sources) * 4.0)

    def _quality(self, attributes: list[DiscoveredAttribute]) -> float:
        if not attributes:
            return 0.0
        average = sum(attribute.confidence for attribute in attributes) / len(attributes)
        return average * self.weights.get("signal_quality", 20.0)

    def _freshness(self, attributes: list[DiscoveredAttribute]) -> float:
        weight = self.weights.get("temporal_freshness", 15.0)
        if not attributes:
            return 0.0
        dated = [attribute for attribute in attributes if attribute.timestamp]
        if not dated:
            return weight * 0.5
        now = datetime.now(timezone.utc)
        fresh = 0.0
        for attribute in dated:
            parsed = datetime.fromisoformat(attribute.timestamp.replace("Z", "+00:00"))
            age_days = max(0, (now - parsed).days)
            fresh += max(0.0, 1.0 - min(age_days, 365) / 365)
        return (fresh / len(dated)) * weight

