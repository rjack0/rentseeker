from __future__ import annotations

from phoenix.core.models import DiscoveredAttribute

from .base import DiscoveryConnector


class GraphTraversalConnector(DiscoveryConnector):
    name = "graph_traversal"

    def can_handle(self, node: dict[str, object]) -> bool:
        return bool(node.get("identifiers") or node.get("attributes"))

    def discover(self, node: dict[str, object]) -> list[DiscoveredAttribute]:
        discovered: list[DiscoveredAttribute] = []
        for identifier in node.get("identifiers", []):
            discovered.append(
                DiscoveredAttribute(
                    name="related_identifier",
                    value=str(identifier),
                    source=self.name,
                    confidence=0.82,
                )
            )
        relationship_type = node.get("attributes", {}).get("relationship_type")
        target_id = node.get("attributes", {}).get("target_id")
        if relationship_type and target_id:
            discovered.append(
                DiscoveredAttribute(
                    name="related_identifier",
                    value=str(target_id),
                    source=self.name,
                    confidence=0.78,
                    metadata={"relationship_type": relationship_type},
                )
            )
        return discovered

