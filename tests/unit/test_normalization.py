from phoenix.config import InputConfig, ProjectConfig
from phoenix.core.normalization import EntityNormalizer


def test_normalize_record_extracts_identifiers_and_relationships() -> None:
    normalizer = EntityNormalizer(
        ProjectConfig(name="demo", entity_type="contractor"),
        InputConfig(type="csv", primary_key="contractor_id"),
    )
    entity = normalizer.normalize_record(
        {
            "contractor_id": "abc",
            "email_address": "a@example.com",
            "phone_text": "+1 555 123 4567",
            "project_parent_id": "PARENT-1",
            "vendor_related_id": "REL-1",
        }
    )

    assert entity.primary_key == "abc"
    assert "a@example.com" in entity.identifiers
    assert any(rel["target_id"] == "PARENT-1" for rel in entity.relationships)
    assert any(rel["target_id"] == "REL-1" for rel in entity.relationships)


def test_normalize_batch_works_for_multiple_records() -> None:
    normalizer = EntityNormalizer(
        ProjectConfig(name="demo", entity_type="contractor"),
        InputConfig(type="csv", primary_key="id"),
    )
    entities = normalizer.normalize_batch(
        [
            {"id": "1", "name": "Alice"},
            {"id": "2", "name": "Bob"},
        ]
    )
    assert [entity.primary_key for entity in entities] == ["1", "2"]

