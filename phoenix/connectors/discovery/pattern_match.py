from __future__ import annotations

import re
from typing import Any

from phoenix.core.models import DiscoveredAttribute

from .base import DiscoveryConnector


class PatternMatcherConnector(DiscoveryConnector):
    name = "pattern_match"

    def can_handle(self, node: dict[str, Any]) -> bool:
        return bool(node.get("attributes"))

    def discover(self, node: dict[str, Any]) -> list[DiscoveredAttribute]:
        patterns = dict(self.config.get("patterns", {}))
        fields = self.config.get("fields")
        discovered: list[DiscoveredAttribute] = []
        attributes = node.get("attributes", {})
        for key, value in attributes.items():
            if fields and key not in fields:
                continue
            text = str(value)
            for name, pattern in patterns.items():
                for match in re.findall(pattern, text):
                    discovered.append(
                        DiscoveredAttribute(
                            name=name,
                            value=match,
                            source=self.name,
                            confidence=0.74,
                            metadata={"field": key},
                        )
                    )
        return discovered

