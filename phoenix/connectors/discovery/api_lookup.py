from __future__ import annotations

from typing import Any

import httpx

from phoenix.core.models import DiscoveredAttribute

from .base import DiscoveryConnector


class APILookupConnector(DiscoveryConnector):
    name = "api_lookup"

    def can_handle(self, node: dict[str, Any]) -> bool:
        attrs = node.get("attributes", {})
        return bool(attrs.get("search_term") or attrs.get("name"))

    def discover(self, node: dict[str, Any]) -> list[DiscoveredAttribute]:
        query = str(node.get("attributes", {}).get("search_term") or node.get("attributes", {}).get("name") or "")
        mock_responses = dict(self.config.get("mock_responses", {}))
        payload = mock_responses.get(query)
        if payload is None and self.config.get("endpoint"):
            response = httpx.get(self.config["endpoint"], params={"q": query}, timeout=30.0)
            response.raise_for_status()
            payload = response.json()
        if payload is None:
            return []

        return_fields = self.config.get("return_fields", {})
        discovered: list[DiscoveredAttribute] = []
        for attr_name, payload_key in return_fields.items():
            value = payload.get(payload_key)
            if value:
                discovered.append(
                    DiscoveredAttribute(
                        name=attr_name,
                        value=value,
                        source=self.name,
                        confidence=0.73,
                    )
                )
        return discovered

