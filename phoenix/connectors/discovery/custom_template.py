from __future__ import annotations

from phoenix.core.models import DiscoveredAttribute

from .base import DiscoveryConnector


class CustomTemplateConnector(DiscoveryConnector):
    name = "custom_template"

    def can_handle(self, node: dict[str, object]) -> bool:
        return False

    def discover(self, node: dict[str, object]) -> list[DiscoveredAttribute]:
        return []

