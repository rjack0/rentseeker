from __future__ import annotations

from hashlib import md5

from phoenix.config import RuntimeConfig

from .models import DiscoveredAttribute, DiscoveryNode


class RecursiveDiscoveryOrchestrator:
    """Run connector discovery recursively with cycle detection."""

    def __init__(self, connectors: list[object], runtime: RuntimeConfig) -> None:
        self.connectors = connectors
        self.runtime = runtime
        self.visited: set[str] = set()

    async def discover(
        self,
        seed_node: DiscoveryNode,
        route: str,
        depth: int = 0,
    ) -> list[DiscoveredAttribute]:
        if depth >= self.runtime.max_recursion_depth:
            return []

        signature = self._signature(seed_node)
        if signature in self.visited and self.runtime.cache_enabled:
            return []
        self.visited.add(signature)

        attributes: list[DiscoveredAttribute] = []
        for connector in self.connectors:
            if hasattr(connector, "supports_route") and not connector.supports_route(route):
                continue
            if connector.can_handle(seed_node.model_dump()):
                discovered = connector.discover(seed_node.model_dump())
                attributes.extend(discovered)
                for attribute in discovered:
                    if attribute.confidence >= self.runtime.recurse_on_confidence:
                        child = self._child_node(seed_node, attribute)
                        if child:
                            attributes.extend(await self.discover(child, route, depth + 1))
        return attributes

    def _signature(self, node: DiscoveryNode) -> str:
        payload = f"{node.entity_id}:{node.node_type}:{sorted(node.attributes.items())}"
        return md5(payload.encode("utf-8")).hexdigest()

    def _child_node(
        self, parent: DiscoveryNode, attribute: DiscoveredAttribute
    ) -> DiscoveryNode | None:
        if attribute.name in {"related_identifier", "source_url", "email", "phone", "domain"}:
            payload = f"{parent.node_id}:{attribute.name}:{attribute.value}"
            node_id = md5(payload.encode("utf-8")).hexdigest()[:16]
            return DiscoveryNode(
                node_id=node_id,
                entity_id=parent.entity_id,
                node_type=f"derived:{attribute.name}",
                attributes={"search_term": str(attribute.value), "derived_from": attribute.name},
                identifiers=parent.identifiers + [str(attribute.value)],
                metadata={"parent_node": parent.node_id},
            )
        return None
