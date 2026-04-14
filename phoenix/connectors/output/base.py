from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class OutputConnector(ABC):
    def __init__(self, config: dict[str, Any] | None = None) -> None:
        self.config = config or {}

    @abstractmethod
    def write(self, results: list[dict[str, Any]]) -> str:
        raise NotImplementedError

