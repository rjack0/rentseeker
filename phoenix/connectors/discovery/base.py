from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from phoenix.core.models import DiscoveredAttribute


class DiscoveryConnector(ABC):
    name = "base"

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        self.config = config or {}
        self.routes = set(self.config.get("routes", ["full_pipeline", "core_connectors"]))

    def supports_route(self, route: str) -> bool:
        return route in self.routes

    @abstractmethod
    def can_handle(self, node: dict[str, Any]) -> bool:
        raise NotImplementedError

    @abstractmethod
    def discover(self, node: dict[str, Any]) -> list[DiscoveredAttribute]:
        raise NotImplementedError

