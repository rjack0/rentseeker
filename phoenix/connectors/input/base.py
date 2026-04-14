from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Iterator
from typing import Any


class InputConnector(ABC):
    @abstractmethod
    def can_handle(self, source_config: dict[str, Any]) -> bool:
        raise NotImplementedError

    @abstractmethod
    def read(self, source_config: dict[str, Any]) -> Iterator[dict[str, Any]]:
        raise NotImplementedError

    @abstractmethod
    def get_schema_hint(self, source_config: dict[str, Any]) -> dict[str, str]:
        raise NotImplementedError

