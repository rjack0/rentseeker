from __future__ import annotations

from .api_lookup import APILookupConnector
from .base import DiscoveryConnector
from .custom_template import CustomTemplateConnector
from .document_parser import DocumentParserConnector
from .graph_traversal import GraphTraversalConnector
from .pattern_match import PatternMatcherConnector
from .web_search import WebSearchConnector

DISCOVERY_CONNECTOR_TYPES: dict[str, type[DiscoveryConnector]] = {
    "api_lookup": APILookupConnector,
    "custom_template": CustomTemplateConnector,
    "document_parser": DocumentParserConnector,
    "graph_traversal": GraphTraversalConnector,
    "pattern_match": PatternMatcherConnector,
    "web_search": WebSearchConnector,
}


def build_discovery_connectors(configs: list[dict[str, object]]) -> list[DiscoveryConnector]:
    connectors: list[DiscoveryConnector] = []
    for config in configs:
        connector_type = str(config.get("type"))
        connector_class = DISCOVERY_CONNECTOR_TYPES.get(connector_type)
        if not connector_class:
            raise ValueError(f"Unsupported discovery connector type '{connector_type}'.")
        connectors.append(connector_class(dict(config.get("config", {}))))
    return connectors

