from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import httpx

from .base import InputConnector


class APIConnector(InputConnector):
    def can_handle(self, source_config: dict[str, Any]) -> bool:
        return source_config.get("type") in {"api", "rest", "graphql"}

    def read(self, source_config: dict[str, Any]) -> Iterator[dict[str, Any]]:
        endpoint = str(source_config["path"])
        method = str(source_config.get("method", "GET")).upper()
        headers = dict(source_config.get("auth", {}))
        params = dict(source_config.get("options", {}))
        response = httpx.request(method, endpoint, headers=headers, params=params, timeout=30.0)
        response.raise_for_status()
        payload = response.json()
        if isinstance(payload, list):
            for row in payload:
                yield row
        elif isinstance(payload, dict) and isinstance(payload.get("data"), list):
            for row in payload["data"]:
                yield row
        elif isinstance(payload, dict):
            yield payload

    def get_schema_hint(self, source_config: dict[str, Any]) -> dict[str, str]:
        return dict(source_config.get("schema", {}))

