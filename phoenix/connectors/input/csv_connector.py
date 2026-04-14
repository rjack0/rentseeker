from __future__ import annotations

import csv
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from .base import InputConnector


class CSVConnector(InputConnector):
    def can_handle(self, source_config: dict[str, Any]) -> bool:
        return source_config.get("type") == "csv"

    def read(self, source_config: dict[str, Any]) -> Iterator[dict[str, Any]]:
        path = Path(str(source_config["path"]))
        with path.open(newline="", encoding="utf-8") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                yield {key: value for key, value in row.items() if value not in ("", None)}

    def get_schema_hint(self, source_config: dict[str, Any]) -> dict[str, str]:
        return dict(source_config.get("schema", {}))

