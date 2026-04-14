from __future__ import annotations

import json
from pathlib import Path

import duckdb
import pandas as pd

from .base import OutputConnector


class DatabaseOutputConnector(OutputConnector):
    def write(self, results: list[dict[str, object]]) -> str:
        driver = str(self.config.get("driver", "duckdb")).lower()
        if driver != "duckdb":
            manifest = Path(str(self.config.get("manifest_path", "./results/database_export_manifest.json")))
            manifest.parent.mkdir(parents=True, exist_ok=True)
            manifest.write_text(json.dumps(results, indent=2))
            return str(manifest)

        database_path = Path(str(self.config.get("path", "./results/phoenix.duckdb")))
        table_name = str(self.config.get("table", "discovery_results"))
        database_path.parent.mkdir(parents=True, exist_ok=True)
        connection = duckdb.connect(str(database_path))
        frame = pd.DataFrame(results)
        connection.register("results_frame", frame)
        connection.execute(f"create or replace table {table_name} as select * from results_frame")
        connection.close()
        return f"{database_path}:{table_name}"
