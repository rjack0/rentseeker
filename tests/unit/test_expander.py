from phoenix.config import ExpansionConfig
from phoenix.core.entity import Entity
from phoenix.core.expander import EntityGraphExpander


def test_expander_generates_variation_nodes() -> None:
    expander = EntityGraphExpander(
        ExpansionConfig(
            max_nodes=7,
            variation_rules={
                "name_variations": {"field": "name"},
                "identifier_aliases": {},
                "temporal_variants": {"labels": ["current", "historical"]},
            },
        )
    )
    entity = Entity(
        entity_type="person",
        primary_key="1",
        attributes={"name": "Robert Smith"},
        identifiers=["robert@example.org"],
    )
    nodes = expander.expand(entity)
    assert len(nodes) >= 4
    assert any(node.node_type.startswith("variation") for node in nodes)

