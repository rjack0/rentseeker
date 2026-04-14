import json

import duckdb

from phoenix.config import OutputConfig
from phoenix.connectors.output.database_output import DatabaseOutputConnector
from phoenix.connectors.output.file_output import FileOutputConnector
from phoenix.connectors.output.registry import build_output_connectors
from phoenix.connectors.output.webhook_output import WebhookOutputConnector


def test_database_output_connector_writes_duckdb_table(tmp_path) -> None:
    db_path = tmp_path / "results.duckdb"
    connector = DatabaseOutputConnector({"driver": "duckdb", "path": str(db_path), "table": "runs"})
    destination = connector.write([{"entity_id": "1", "signal_score": 90, "route": "full_pipeline"}])
    conn = duckdb.connect(str(db_path))
    count = conn.execute("select count(*) from runs").fetchone()[0]
    conn.close()
    assert count == 1
    assert destination.endswith(":runs")


def test_database_output_connector_writes_manifest_for_non_duckdb(tmp_path) -> None:
    manifest = tmp_path / "manifest.json"
    connector = DatabaseOutputConnector(
        {"driver": "postgresql", "manifest_path": str(manifest)}
    )
    destination = connector.write([{"entity_id": "1"}])
    assert json.loads(manifest.read_text()) == [{"entity_id": "1"}]
    assert destination == str(manifest)


def test_webhook_output_connector_supports_manifest_and_http(monkeypatch, tmp_path) -> None:
    manifest = tmp_path / "webhook.json"
    connector = WebhookOutputConnector({"manifest_path": str(manifest)})
    destination = connector.write([{"entity_id": "1"}])
    assert json.loads(manifest.read_text()) == [{"entity_id": "1"}]
    assert destination == str(manifest)

    calls = {}

    class DummyResponse:
        def raise_for_status(self) -> None:
            return None

    def fake_post(url, json=None, timeout=None):
        calls["url"] = url
        calls["json"] = json
        return DummyResponse()

    monkeypatch.setattr("phoenix.connectors.output.webhook_output.httpx.post", fake_post)
    http_connector = WebhookOutputConnector({"path": "https://example.test/hook"})
    destination = http_connector.write([{"entity_id": "2"}])
    assert calls["url"] == "https://example.test/hook"
    assert calls["json"] == [{"entity_id": "2"}]
    assert destination == "https://example.test/hook"


def test_output_registry_and_file_output_handle_none_confidence(tmp_path) -> None:
    output_path = tmp_path / "out.csv"
    connectors = build_output_connectors([OutputConfig(type="csv", path=str(output_path))])
    assert len(connectors) == 1
    assert isinstance(connectors[0], FileOutputConnector)
    connectors[0].write(
        [{"entity_id": "1", "signal_score": 10, "route": "skip", "confidence": None, "attributes": []}]
    )
    assert output_path.exists()

