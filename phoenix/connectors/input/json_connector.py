from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from .base import InputConnector


class JSONConnector(InputConnector):
    def can_handle(self, source_config: dict[str, Any]) -> bool:
        return source_config.get("type") == "json"

    def read(self, source_config: dict[str, Any]) -> Iterator[dict[str, Any]]:
        path = Path(str(source_config["path"]))
        payload = json.loads(path.read_text())
        if isinstance(payload, list):
            for row in payload:
                yield row
            return
        if isinstance(payload, dict) and isinstance(payload.get("data"), list):
            for row in payload["data"]:
                yield row
            return
        if isinstance(payload, dict):
            yield payload

    def get_schema_hint(self, source_config: dict[str, Any]) -> dict[str, str]:
        return dict(source_config.get("schema", {}))

