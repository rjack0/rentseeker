from phoenix.core.models import DiscoveredAttribute, VerificationStatus
from phoenix.core.verification import ConsensusVerificationEngine


def test_consensus_verifier_marks_multi_source_matches_verified() -> None:
    verifier = ConsensusVerificationEngine()
    results = verifier.verify(
        [
            DiscoveredAttribute(name="email", value="robert@example.org", source="a", confidence=0.8),
            DiscoveredAttribute(name="email", value="robert@example.org", source="b", confidence=0.9),
        ]
    )
    assert results[0].status == VerificationStatus.VERIFIED
    assert results[0].consensus_count == 2

