from __future__ import annotations

import re
from typing import Any

from phoenix.core.models import DiscoveredAttribute

from .base import DiscoveryConnector


class WebSearchConnector(DiscoveryConnector):
    name = "web_search"

    def can_handle(self, node: dict[str, Any]) -> bool:
        attrs = node.get("attributes", {})
        return bool(attrs.get("search_term") or attrs.get("name"))

    def discover(self, node: dict[str, Any]) -> list[DiscoveredAttribute]:
        attrs = node.get("attributes", {})
        search_term = str(attrs.get("search_term") or attrs.get("name") or "")
        fixtures = dict(self.config.get("offline_results", {}))
        results = fixtures.get(search_term, [])
        discovered: list[DiscoveredAttribute] = []

        for result in results:
            if isinstance(result, dict) and result.get("url"):
                discovered.append(
                    DiscoveredAttribute(
                        name="source_url",
                        value=result["url"],
                        source=self.name,
                        confidence=float(result.get("confidence", 0.70)),
                        metadata={"title": result.get("title", "")},
                    )
                )
                for email in re.findall(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", result.get("snippet", "")):
                    discovered.append(
                        DiscoveredAttribute(
                            name="email",
                            value=email,
                            source=self.name,
                            confidence=0.78,
                            metadata={"query": search_term},
                        )
                    )
        return discovered

