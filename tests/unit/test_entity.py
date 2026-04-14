from phoenix.core.entity import Entity


def test_entity_computes_deterministic_id() -> None:
    entity = Entity(entity_type="person", primary_key="123")
    assert entity.entity_id == entity.compute_id()
    assert len(entity.entity_id) == 16

