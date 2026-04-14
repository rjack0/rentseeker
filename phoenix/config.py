from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, ConfigDict, Field


class ProjectConfig(BaseModel):
    name: str = "phoenix_project"
    entity_type: str = "generic_entity"


class InputConfig(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    type: str
    path: str | None = None
    primary_key: str = "id"
    schema_map: dict[str, str] = Field(default_factory=dict, alias="schema")
    options: dict[str, Any] = Field(default_factory=dict)
    auth: dict[str, Any] = Field(default_factory=dict)


class ScoringConfig(BaseModel):
    rules: list[dict[str, Any]] = Field(default_factory=list)
    feature_weights: dict[str, float] = Field(default_factory=dict)
    route_thresholds: dict[str, int] = Field(
        default_factory=lambda: {"full_pipeline": 70, "core_connectors": 40}
    )
    confidence_weights: dict[str, float] = Field(
        default_factory=lambda: {
            "identity_match": 35.0,
            "verification_consensus": 25.0,
            "source_diversity": 20.0,
            "signal_quality": 20.0,
            "temporal_freshness": 15.0,
        }
    )
    tier_thresholds: dict[str, int] = Field(default_factory=lambda: {"A": 80, "B": 60})


class ExpansionConfig(BaseModel):
    max_nodes: int = 7
    variation_rules: dict[str, Any] = Field(default_factory=dict)
    relationship_expansion_enabled: bool = True


class OutputConfig(BaseModel):
    type: str = "json"
    path: str = "./results/output.json"
    include_tiers: list[str] = Field(default_factory=lambda: ["A", "B", "C"])
    options: dict[str, Any] = Field(default_factory=dict)


class RuntimeConfig(BaseModel):
    max_recursion_depth: int = 3
    recurse_on_confidence: float = 0.85
    cache_enabled: bool = True


class PhoenixConfig(BaseModel):
    project: ProjectConfig = Field(default_factory=ProjectConfig)
    input: InputConfig
    scoring: ScoringConfig = Field(default_factory=ScoringConfig)
    expansion: ExpansionConfig = Field(default_factory=ExpansionConfig)
    connectors: list[dict[str, Any]] = Field(default_factory=list)
    output: list[OutputConfig] = Field(default_factory=list)
    runtime: RuntimeConfig = Field(default_factory=RuntimeConfig)
    metadata: dict[str, Any] = Field(default_factory=dict)


def load_config(path: str | Path) -> PhoenixConfig:
    config_path = Path(path)
    raw = yaml.safe_load(config_path.read_text()) or {}
    _resolve_relative_paths(raw, config_path.parent)
    return PhoenixConfig.model_validate(raw)


def _resolve_relative_paths(raw: dict[str, Any], base_dir: Path) -> None:
    input_config = raw.get("input")
    if isinstance(input_config, dict):
        input_path = input_config.get("path")
        if isinstance(input_path, str):
            input_config["path"] = _resolve_path_like(input_path, base_dir)

    output_configs = raw.get("output")
    if isinstance(output_configs, list):
        for output_config in output_configs:
            if not isinstance(output_config, dict):
                continue
            output_path = output_config.get("path")
            if isinstance(output_path, str):
                output_config["path"] = _resolve_path_like(output_path, base_dir)
            manifest_path = output_config.get("manifest_path")
            if isinstance(manifest_path, str):
                output_config["manifest_path"] = _resolve_path_like(manifest_path, base_dir)


def _resolve_path_like(value: str, base_dir: Path) -> str:
    if "://" in value:
        return value
    candidate = Path(value)
    if candidate.is_absolute():
        return str(candidate)
    return str((base_dir / candidate).resolve())
