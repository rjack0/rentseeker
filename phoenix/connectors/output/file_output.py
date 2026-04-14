from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pandas as pd
import polars as pl

from .base import OutputConnector


class FileOutputConnector(OutputConnector):
    def write(self, results: list[dict[str, Any]]) -> str:
        path = Path(str(self.config.get("path", "./results/output.json")))
        path.parent.mkdir(parents=True, exist_ok=True)
        format_type = str(self.config.get("type", path.suffix.lstrip(".") or "json")).lower()
        filtered = self._filter_by_tier(results)

        if format_type == "json":
            path.write_text(json.dumps(filtered, indent=2))
        elif format_type == "csv":
            pd.DataFrame(self._flatten(filtered)).to_csv(path, index=False)
        elif format_type == "excel":
            pd.DataFrame(self._flatten(filtered)).to_excel(path, index=False)
        elif format_type == "parquet":
            pl.DataFrame(self._flatten(filtered)).write_parquet(path)
        else:
            raise ValueError(f"Unsupported file output type '{format_type}'.")
        return str(path)

    def _filter_by_tier(self, results: list[dict[str, Any]]) -> list[dict[str, Any]]:
        allowed = set(self.config.get("include_tiers", ["A", "B", "C"]))
        return [
            result
            for result in results
            if (result.get("confidence") or {}).get("tier", "C") in allowed
        ]

    def _flatten(self, results: list[dict[str, Any]]) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for result in results:
            rows.append(
                {
                    "entity_id": result["entity_id"],
                    "signal_score": result["signal_score"],
                    "route": result["route"],
                    "confidence_score": (result.get("confidence") or {}).get("score"),
                    "tier": (result.get("confidence") or {}).get("tier"),
                    "attribute_count": len(result.get("attributes", [])),
                }
            )
        return rows
