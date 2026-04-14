from __future__ import annotations

from typing import Any

import duckdb
import polars as pl

from phoenix.config import InputConfig, ProjectConfig

from .entity import Entity


class EntityNormalizer:
    """Normalize raw records into canonical Entity objects."""

    def __init__(self, project: ProjectConfig, input_config: InputConfig) -> None:
        self.project = project
        self.input_config = input_config

    def normalize_record(self, record: dict[str, Any]) -> Entity:
        primary_key_field = self.input_config.primary_key
        primary_key = str(record.get(primary_key_field) or record.get("id") or "")
        attributes = {k: v for k, v in record.items() if v not in (None, "")}
        identifiers = self._extract_identifiers(attributes)
        metadata = {
            "source_type": self.input_config.type,
            "primary_key_field": primary_key_field,
        }
        return Entity(
            entity_type=self.project.entity_type,
            primary_key=primary_key,
            attributes=attributes,
            identifiers=identifiers,
            relationships=self._extract_relationships(record),
            metadata=metadata,
        )

    def normalize_batch(self, records: list[dict[str, Any]]) -> list[Entity]:
        if not records:
            return []
        frame = pl.DataFrame(records)
        normalized = duckdb.sql("select * from frame").pl().to_dicts()
        return [self.normalize_record(record) for record in normalized]

    def _extract_identifiers(self, attributes: dict[str, Any]) -> list[str]:
        identifiers: list[str] = []
        for key, value in attributes.items():
            normalized_key = key.lower()
            if any(token in normalized_key for token in ("id", "email", "phone", "url", "domain")):
                identifiers.append(str(value))
        return list(dict.fromkeys(identifiers))

    def _extract_relationships(self, record: dict[str, Any]) -> list[dict[str, Any]]:
        relationships: list[dict[str, Any]] = []
        for key, value in record.items():
            if key.endswith("_parent_id") and value:
                relationships.append({"type": "parent_of", "target_id": str(value), "expand": True})
            if key.endswith("_related_id") and value:
                relationships.append({"type": "related_to", "target_id": str(value), "expand": True})
        return relationships

