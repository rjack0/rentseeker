from phoenix.config import ScoringConfig
from phoenix.core.entity import Entity
from phoenix.core.scorer import SignalPreScorer


def test_signal_pre_scorer_routes_high_signal_entities() -> None:
    scorer = SignalPreScorer(
        ScoringConfig(
            rules=[{"field": "name", "operator": "exists", "points": 30}],
            feature_weights={"notes": 0.5},
            route_thresholds={"full_pipeline": 70, "core_connectors": 40},
        )
    )
    entity = Entity(
        entity_type="contractor",
        primary_key="1",
        attributes={"name": "Robert Smith", "notes": "x" * 120},
    )
    score = scorer.score(entity)
    assert score >= 80
    assert scorer.route(score) == "full_pipeline"

