from __future__ import annotations

from collections import defaultdict

from .models import DiscoveredAttribute, VerificationResult, VerificationStatus


class ConsensusVerificationEngine:
    """Verify discovered attributes by cross-source consensus and basic consistency."""

    def verify(self, attributes: list[DiscoveredAttribute]) -> list[VerificationResult]:
        grouped: dict[tuple[str, str], list[DiscoveredAttribute]] = defaultdict(list)
        for attribute in attributes:
            grouped[(attribute.name, str(attribute.value))].append(attribute)

        results: list[VerificationResult] = []
        for (name, value), matches in grouped.items():
            evidence = [f"{item.source}:{item.confidence:.2f}" for item in matches]
            consensus_count = len({item.source for item in matches})
            average_confidence = sum(item.confidence for item in matches) / len(matches)

            if consensus_count >= 2 and average_confidence >= 0.75:
                status = VerificationStatus.VERIFIED
            elif average_confidence >= 0.60:
                status = VerificationStatus.PROBABLE
            elif average_confidence >= 0.35:
                status = VerificationStatus.UNCERTAIN
            else:
                status = VerificationStatus.REJECTED

            results.append(
                VerificationResult(
                    attribute_name=name,
                    attribute_value=value,
                    status=status,
                    evidence=evidence,
                    consensus_count=consensus_count,
                    notes=self._notes(status, consensus_count),
                )
            )
        return results

    def _notes(self, status: VerificationStatus, consensus_count: int) -> str:
        if status is VerificationStatus.VERIFIED:
            return f"Consensus verified across {consensus_count} sources."
        if status is VerificationStatus.PROBABLE:
            return "Strong single-source or partial consensus signal."
        if status is VerificationStatus.UNCERTAIN:
            return "Weak or low-diversity evidence."
        return "Rejected due to low confidence."

