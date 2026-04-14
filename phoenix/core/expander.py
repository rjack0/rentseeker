from __future__ import annotations

from hashlib import md5

from phoenix.config import ExpansionConfig

from .entity import Entity
from .models import DiscoveryNode


class EntityGraphExpander:
    """Expand a single entity into multiple discovery nodes."""

    def __init__(self, config: ExpansionConfig) -> None:
        self.config = config

    def expand(self, entity: Entity) -> list[DiscoveryNode]:
        nodes: list[DiscoveryNode] = [self._create_node(entity, "primary", entity.attributes)]

        for rule_name, rule_config in self.config.variation_rules.items():
            nodes.extend(self._apply_rule(entity, rule_name, rule_config))

        if self.config.relationship_expansion_enabled:
            for relationship in entity.relationships:
                if relationship.get("expand"):
                    attributes = {
                        "relationship_type": relationship.get("type"),
                        "target_id": relationship.get("target_id"),
                    }
                    nodes.append(self._create_node(entity, "relationship", attributes))

        deduped: list[DiscoveryNode] = []
        seen: set[str] = set()
        for node in nodes:
            signature = self._signature(node)
            if signature not in seen:
                seen.add(signature)
                deduped.append(node)

        return deduped[: self.config.max_nodes]

    def _apply_rule(
        self, entity: Entity, rule_name: str, rule_config: dict[str, object]
    ) -> list[DiscoveryNode]:
        field = str(rule_config.get("field", "name"))
        value = str(entity.attributes.get(field, "") or "")
        nodes: list[DiscoveryNode] = []

        if rule_name == "name_variations" and value:
            for variant in self._generate_name_variants(value):
                attrs = dict(entity.attributes)
                attrs[field] = variant
                nodes.append(self._create_node(entity, f"variation:{rule_name}", attrs))

        if rule_name == "identifier_aliases":
            aliases = [str(v) for v in entity.identifiers]
            for alias in aliases:
                attrs = dict(entity.attributes)
                attrs["search_term"] = alias
                nodes.append(self._create_node(entity, f"variation:{rule_name}", attrs))

        if rule_name == "temporal_variants":
            for label in rule_config.get("labels", ["current", "historical"]):
                attrs = dict(entity.attributes)
                attrs["temporal_context"] = str(label)
                nodes.append(self._create_node(entity, f"temporal:{label}", attrs))

        return nodes

    def _create_node(
        self, entity: Entity, node_type: str, attributes: dict[str, object]
    ) -> DiscoveryNode:
        payload = f"{entity.entity_id}:{node_type}:{sorted(attributes.items())}"
        node_id = md5(payload.encode("utf-8")).hexdigest()[:16]
        return DiscoveryNode(
            node_id=node_id,
            entity_id=entity.entity_id or entity.compute_id(),
            node_type=node_type,
            attributes=attributes,
            identifiers=list(entity.identifiers),
            metadata={"source_entity_type": entity.entity_type, "node_type": node_type},
        )

    def _generate_name_variants(self, name: str) -> list[str]:
        parts = [part for part in name.split() if part]
        if not parts:
            return []
        variants = {name}
        if len(parts) >= 2:
            variants.add(f"{parts[0][0]}. {' '.join(parts[1:])}")
        nickname_map = {
            "william": ["Will", "Bill"],
            "robert": ["Rob", "Bob"],
            "james": ["Jim", "Jamie"],
            "elizabeth": ["Liz", "Beth"],
        }
        first = parts[0].lower()
        for nickname in nickname_map.get(first, []):
            variants.add(f"{nickname} {' '.join(parts[1:])}".strip())
        return sorted(variants)

    def _signature(self, node: DiscoveryNode) -> str:
        return md5(
            f"{node.entity_id}:{node.node_type}:{sorted(node.attributes.items())}".encode("utf-8")
        ).hexdigest()

