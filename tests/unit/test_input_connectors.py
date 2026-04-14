import json
from pathlib import Path

import pandas as pd

from phoenix.config import InputConfig
from phoenix.connectors.input.api_connector import APIConnector
from phoenix.connectors.input.csv_connector import CSVConnector
from phoenix.connectors.input.excel_connector import ExcelConnector
from phoenix.connectors.input.json_connector import JSONConnector
from phoenix.connectors.input.registry import build_input_connector


def test_csv_connector_reads_rows(tmp_path) -> None:
    path = tmp_path / "input.csv"
    path.write_text("id,name\n1,Alice\n2,Bob\n")
    rows = list(CSVConnector().read({"type": "csv", "path": str(path)}))
    assert rows == [{"id": "1", "name": "Alice"}, {"id": "2", "name": "Bob"}]


def test_excel_connector_reads_rows(tmp_path) -> None:
    path = tmp_path / "input.xlsx"
    pd.DataFrame([{"id": "1", "name": "Alice"}]).to_excel(path, index=False)
    rows = list(ExcelConnector().read({"type": "excel", "path": str(path)}))
    assert rows == [{"id": "1", "name": "Alice"}]


def test_json_connector_reads_list_payload(tmp_path) -> None:
    path = tmp_path / "input.json"
    path.write_text(json.dumps([{"id": "1"}, {"id": "2"}]))
    rows = list(JSONConnector().read({"type": "json", "path": str(path)}))
    assert rows == [{"id": "1"}, {"id": "2"}]


def test_api_connector_reads_http_payload(monkeypatch) -> None:
    class DummyResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> list[dict[str, str]]:
            return [{"id": "1", "name": "Alice"}]

    def fake_request(method, endpoint, headers=None, params=None, timeout=None):
        assert method == "GET"
        assert endpoint == "https://example.test/api"
        return DummyResponse()

    monkeypatch.setattr("phoenix.connectors.input.api_connector.httpx.request", fake_request)
    rows = list(
        APIConnector().read(
            {
                "type": "api",
                "path": "https://example.test/api",
                "auth": {"Authorization": "Bearer x"},
                "options": {"page": 1},
            }
        )
    )
    assert rows == [{"id": "1", "name": "Alice"}]


def test_build_input_connector_selects_expected_type() -> None:
    connector = build_input_connector(InputConfig(type="json", path="/tmp/input.json"))
    assert isinstance(connector, JSONConnector)

