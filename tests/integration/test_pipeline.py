from pathlib import Path

from phoenix.config import PhoenixConfig
from phoenix.pipeline import DiscoveryPipeline


def test_pipeline_processes_fixture_data(tmp_path) -> None:
    fixture_path = Path(__file__).resolve().parents[1] / "fixtures" / "sample_input.csv"
    output_path = tmp_path / "output.json"
    config = PhoenixConfig.model_validate(
        {
            "project": {"name": "test", "entity_type": "contractor"},
            "input": {
                "type": "csv",
                "path": str(fixture_path),
                "primary_key": "contractor_id",
            },
            "scoring": {
                "rules": [{"field": "name", "operator": "exists", "points": 20}],
                "feature_weights": {"notes": 0.5},
                "route_thresholds": {"full_pipeline": 70, "core_connectors": 30},
                "confidence_weights": {
                    "identity_match": 35,
                    "verification_consensus": 25,
                    "source_diversity": 20,
                    "signal_quality": 20,
                    "temporal_freshness": 15,
                },
                "tier_thresholds": {"A": 80, "B": 60},
            },
            "expansion": {
                "max_nodes": 7,
                "variation_rules": {
                    "name_variations": {"field": "name"},
                    "identifier_aliases": {},
                },
            },
            "connectors": [
                {
                    "type": "pattern_match",
                    "config": {
                        "routes": ["full_pipeline", "core_connectors"],
                        "patterns": {
                            "email": "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}",
                            "phone": "\\+?\\d[\\d\\-\\(\\)\\s]{7,}\\d",
                        },
                    },
                },
                {"type": "graph_traversal", "config": {"routes": ["full_pipeline", "core_connectors"]}},
            ],
            "output": [{"type": "json", "path": str(output_path), "include_tiers": ["A", "B", "C"]}],
            "runtime": {"max_recursion_depth": 2, "recurse_on_confidence": 0.9, "cache_enabled": True},
        }
    )

    results = DiscoveryPipeline(config).run()
    assert len(results) == 2
    assert output_path.exists()
    assert any(result.attributes for result in results)

