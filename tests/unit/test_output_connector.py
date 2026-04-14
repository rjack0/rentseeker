import json

from phoenix.connectors.output.file_output import FileOutputConnector


def test_file_output_connector_filters_tiers(tmp_path) -> None:
    output_path = tmp_path / "results.json"
    connector = FileOutputConnector(
        {"type": "json", "path": str(output_path), "include_tiers": ["A"]}
    )
    connector.write(
        [
            {"entity_id": "1", "signal_score": 80, "route": "full", "confidence": {"tier": "A"}},
            {"entity_id": "2", "signal_score": 20, "route": "skip", "confidence": {"tier": "C"}},
        ]
    )
    payload = json.loads(output_path.read_text())
    assert len(payload) == 1
    assert payload[0]["entity_id"] == "1"

