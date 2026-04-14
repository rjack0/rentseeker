from pathlib import Path

import json
import yaml
from typer.testing import CliRunner

from phoenix.cli import app


def _write_config(tmp_path: Path, fixture_csv: Path, output_json: Path) -> Path:
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        yaml.safe_dump(
            {
                "project": {"name": "cli-demo", "entity_type": "contractor"},
                "input": {"type": "csv", "path": str(fixture_csv), "primary_key": "contractor_id"},
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
                "expansion": {"max_nodes": 7, "variation_rules": {"name_variations": {"field": "name"}}},
                "connectors": [
                    {
                        "type": "pattern_match",
                        "config": {
                            "routes": ["full_pipeline", "core_connectors"],
                            "patterns": {"email": r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"},
                        },
                    }
                ],
                "output": [{"type": "json", "path": str(output_json), "include_tiers": ["A", "B", "C"]}],
                "runtime": {"max_recursion_depth": 2, "recurse_on_confidence": 0.95, "cache_enabled": True},
            },
            sort_keys=False,
        )
    )
    return config_path


def test_cli_print_sample_config() -> None:
    runner = CliRunner()
    result = runner.invoke(app, ["print-sample-config"])
    assert result.exit_code == 0
    assert "project:" in result.output
    assert "connectors:" in result.output


def test_cli_run_and_view_commands(tmp_path) -> None:
    runner = CliRunner()
    fixture_csv = Path(__file__).resolve().parents[1] / "fixtures" / "sample_input.csv"
    output_json = tmp_path / "output.json"
    config_path = _write_config(tmp_path, fixture_csv, output_json)

    run_result = runner.invoke(app, ["run", "--config", str(config_path)])
    assert run_result.exit_code == 0
    assert "Discovery Run Summary" in run_result.output
    assert output_json.exists()

    generated = json.loads(output_json.read_text())
    tier = generated[0]["confidence"]["tier"]
    view_result = runner.invoke(app, ["view", "--config", str(config_path), "--tier", tier])
    assert view_result.exit_code == 0
    assert "entity_id" in view_result.output
