import json

from phoenix.config import RuntimeConfig, ScoringConfig
from phoenix.core.entity import Entity
from phoenix.core.models import DiscoveredAttribute, DiscoveryNode, VerificationResult, VerificationStatus
from phoenix.core.orchestrator import RecursiveDiscoveryOrchestrator
from phoenix.core.scoring import ConfidenceScorer
from phoenix.ui.app import _load_results


def test_confidence_scorer_assigns_expected_tier() -> None:
    scorer = ConfidenceScorer(
        ScoringConfig(
            confidence_weights={
                "identity_match": 35,
                "verification_consensus": 25,
                "source_diversity": 20,
                "signal_quality": 20,
                "temporal_freshness": 15,
            },
            tier_thresholds={"A": 80, "B": 60},
        )
    )
    entity = Entity(
        entity_type="contractor",
        primary_key="1",
        attributes={"name": "Alice", "email": "alice@example.com"},
    )
    attributes = [
        DiscoveredAttribute(name="email", value="alice@example.com", source="web", confidence=0.95),
        DiscoveredAttribute(name="email", value="alice@example.com", source="api", confidence=0.90),
    ]
    verifications = [
        VerificationResult(
            attribute_name="email",
            attribute_value="alice@example.com",
            status=VerificationStatus.VERIFIED,
            consensus_count=2,
        )
    ]
    result = scorer.score(entity, attributes, verifications)
    assert result.tier in {"A", "B"}
    assert result.score >= 60


def test_recursive_orchestrator_honors_route_and_recurses() -> None:
    connector = type(
        "FakeConnector",
        (),
        {
            "supports_route": lambda self, route: route == "full_pipeline",
            "can_handle": lambda self, node: True,
            "discover": lambda self, node: [
                DiscoveredAttribute(
                    name="related_identifier",
                    value="child-1",
                    source="fake",
                    confidence=0.95,
                )
            ],
        },
    )()
    orchestrator = RecursiveDiscoveryOrchestrator(
        [connector],
        RuntimeConfig(max_recursion_depth=2, recurse_on_confidence=0.9, cache_enabled=True),
    )
    seed = DiscoveryNode(
        node_id="node-1",
        entity_id="entity-1",
        node_type="primary",
        attributes={"name": "Alice"},
        identifiers=["seed-1"],
    )
    attrs = __import__("asyncio").run(orchestrator.discover(seed, "full_pipeline"))
    blocked = __import__("asyncio").run(orchestrator.discover(seed, "core_connectors"))
    assert len(attrs) >= 2
    assert blocked == []


def test_ui_load_results_handles_valid_and_invalid_json(tmp_path) -> None:
    good = tmp_path / "good.json"
    bad = tmp_path / "bad.json"
    good.write_text(json.dumps([{"entity_id": "1"}]))
    bad.write_text("{not-json")
    assert _load_results(good) == [{"entity_id": "1"}]
    assert _load_results(bad) == []

