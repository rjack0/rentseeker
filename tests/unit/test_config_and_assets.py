import json
from pathlib import Path

import yaml
from jsonschema import validate

from phoenix.config import load_config
from phoenix.core.entity import Entity
from phoenix.core.models import ConfidenceResult, DiscoveryRunResult


def test_load_config_resolves_relative_paths(tmp_path) -> None:
    input_path = tmp_path / "input.csv"
    input_path.write_text("id,name\n1,Alice\n")
    config_path = tmp_path / "project.yaml"
    config_path.write_text(
        yaml.safe_dump(
            {
                "project": {"name": "demo", "entity_type": "person"},
                "input": {"type": "csv", "path": "./input.csv", "primary_key": "id"},
                "output": [{"type": "json", "path": "./results/output.json"}],
            },
            sort_keys=False,
        )
    )

    config = load_config(config_path)
    assert Path(config.input.path).is_absolute()
    assert Path(config.output[0].path).is_absolute()
    assert Path(config.input.path) == input_path.resolve()


def test_entity_and_output_match_json_schemas() -> None:
    root = Path(__file__).resolve().parents[2]
    entity_schema = json.loads((root / "schemas" / "entity_schema.json").read_text())
    output_schema = json.loads((root / "schemas" / "output_schema.json").read_text())

    entity = Entity(entity_type="person", primary_key="123", attributes={"name": "Alice"})
    result = DiscoveryRunResult(
        entity_id=entity.entity_id,
        signal_score=88,
        route="full_pipeline",
        confidence=ConfidenceResult(score=91, tier="A", breakdown={}, recommendations=[]),
    )

    validate(entity.model_dump(mode="json"), entity_schema)
    validate(result.model_dump(mode="json"), output_schema)

