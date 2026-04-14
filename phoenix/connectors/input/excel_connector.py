from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pandas as pd

from .base import InputConnector


class ExcelConnector(InputConnector):
    def can_handle(self, source_config: dict[str, Any]) -> bool:
        return source_config.get("type") in {"excel", "xlsx", "xls"}

    def read(self, source_config: dict[str, Any]) -> Iterator[dict[str, Any]]:
        path = Path(str(source_config["path"]))
        frame = pd.read_excel(path, dtype=str, sheet_name=source_config.get("sheet_name", 0))
        for row in frame.fillna("").to_dict(orient="records"):
            yield {key: value for key, value in row.items() if value not in ("", None)}

    def get_schema_hint(self, source_config: dict[str, Any]) -> dict[str, str]:
        return dict(source_config.get("schema", {}))

