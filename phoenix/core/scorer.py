from __future__ import annotations

import re
from typing import Any

from phoenix.config import ScoringConfig

from .entity import Entity


class SignalPreScorer:
    """Calculate discovery probability before expensive connector execution."""

    def __init__(self, config: ScoringConfig) -> None:
        self.rules = config.rules
        self.weights = config.feature_weights
        self.route_thresholds = config.route_thresholds

    def score(self, entity: Entity) -> int:
        score = 0.0

        for rule in self.rules:
            if self._evaluate_rule(rule, entity):
                score += float(rule.get("points", 0))

        for feature, weight in self.weights.items():
            value = entity.attributes.get(feature)
            if value is not None:
                score += self._score_feature(value) * float(weight) * 100

        return max(0, min(100, int(score)))

    def route(self, score: int) -> str:
        full_threshold = self.route_thresholds.get("full_pipeline", 70)
        core_threshold = self.route_thresholds.get("core_connectors", 40)
        if score >= full_threshold:
            return "full_pipeline"
        if score >= core_threshold:
            return "core_connectors"
        return "skip"

    def _evaluate_rule(self, rule: dict[str, Any], entity: Entity) -> bool:
        field = str(rule.get("field", ""))
        operator = str(rule.get("operator", "exists"))
        value = rule.get("value")
        entity_value = entity.attributes.get(field)

        if operator == "exists":
            return entity_value not in (None, "")
        if operator == "equals":
            return entity_value == value
        if operator == "contains":
            return str(value).lower() in str(entity_value).lower()
        if operator == "regex":
            return bool(re.search(str(value), str(entity_value or "")))
        if operator == "min_length":
            return len(str(entity_value or "")) >= int(value)
        return False

    def _score_feature(self, value: Any) -> float:
        if isinstance(value, str):
            return min(1.0, len(value.strip()) / 100)
        if isinstance(value, bool):
            return 1.0 if value else 0.0
        if isinstance(value, (int, float)):
            return min(1.0, float(value) / 1000)
        if isinstance(value, (list, tuple, set)):
            return min(1.0, len(value) / 10)
        return 0.25

