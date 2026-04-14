import json

from phoenix.connectors.discovery.api_lookup import APILookupConnector
from phoenix.connectors.discovery.custom_template import CustomTemplateConnector
from phoenix.connectors.discovery.document_parser import DocumentParserConnector
from phoenix.connectors.discovery.graph_traversal import GraphTraversalConnector
from phoenix.connectors.discovery.pattern_match import PatternMatcherConnector
from phoenix.connectors.discovery.registry import build_discovery_connectors
from phoenix.connectors.discovery.web_search import WebSearchConnector


def test_pattern_match_connector_extracts_email_and_phone() -> None:
    connector = PatternMatcherConnector(
        {
            "patterns": {
                "email": r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}",
                "phone": r"\+?\d[\d\-\(\)\s]{7,}\d",
            }
        }
    )
    attrs = connector.discover(
        {"attributes": {"notes": "Email alice@example.com and call +1 555 123 4567."}}
    )
    names = {attr.name for attr in attrs}
    assert {"email", "phone"} <= names


def test_document_parser_connector_reads_json_file(tmp_path) -> None:
    path = tmp_path / "doc.json"
    path.write_text(
        json.dumps(
            {
                "contact": "alice@example.com",
                "phone": "+1 555 123 4567",
                "site": "https://example.test/profile",
            }
        )
    )
    connector = DocumentParserConnector()
    attrs = connector.discover({"attributes": {"document_path": str(path)}})
    names = [attr.name for attr in attrs]
    assert "email" in names
    assert "phone" in names
    assert "source_url" in names


def test_graph_traversal_connector_returns_related_identifiers() -> None:
    connector = GraphTraversalConnector()
    attrs = connector.discover(
        {
            "identifiers": ["alice@example.com"],
            "attributes": {"relationship_type": "parent_of", "target_id": "REL-1"},
        }
    )
    values = {attr.value for attr in attrs}
    assert "alice@example.com" in values
    assert "REL-1" in values


def test_web_search_connector_uses_offline_results() -> None:
    connector = WebSearchConnector(
        {
            "offline_results": {
                "Alice Smith": [
                    {
                        "url": "https://example.test/alice",
                        "snippet": "Reach Alice at alice@example.com",
                        "confidence": 0.81,
                    }
                ]
            }
        }
    )
    attrs = connector.discover({"attributes": {"name": "Alice Smith"}})
    assert any(attr.name == "source_url" for attr in attrs)
    assert any(attr.name == "email" and attr.value == "alice@example.com" for attr in attrs)


def test_api_lookup_connector_supports_mock_and_http(monkeypatch) -> None:
    connector = APILookupConnector(
        {
            "mock_responses": {"Alice": {"mail": "alice@example.com"}},
            "return_fields": {"email": "mail"},
        }
    )
    attrs = connector.discover({"attributes": {"name": "Alice"}})
    assert len(attrs) == 1
    assert attrs[0].value == "alice@example.com"

    class DummyResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, str]:
            return {"mail": "bob@example.com"}

    def fake_get(url, params=None, timeout=None):
        assert url == "https://example.test/lookup"
        assert params == {"q": "Bob"}
        return DummyResponse()

    monkeypatch.setattr("phoenix.connectors.discovery.api_lookup.httpx.get", fake_get)
    http_connector = APILookupConnector(
        {
            "endpoint": "https://example.test/lookup",
            "return_fields": {"email": "mail"},
        }
    )
    http_attrs = http_connector.discover({"attributes": {"name": "Bob"}})
    assert http_attrs[0].value == "bob@example.com"


def test_custom_template_and_registry_behave_as_expected() -> None:
    connector = CustomTemplateConnector()
    assert connector.can_handle({"attributes": {}}) is False
    assert connector.discover({"attributes": {}}) == []
    registry = build_discovery_connectors(
        [{"type": "custom_template", "config": {}}, {"type": "graph_traversal", "config": {}}]
    )
    assert [item.name for item in registry] == ["custom_template", "graph_traversal"]

