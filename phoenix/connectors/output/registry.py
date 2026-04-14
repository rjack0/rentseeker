from __future__ import annotations

from phoenix.config import OutputConfig

from .base import OutputConnector
from .database_output import DatabaseOutputConnector
from .file_output import FileOutputConnector
from .webhook_output import WebhookOutputConnector


def build_output_connectors(configs: list[OutputConfig]) -> list[OutputConnector]:
    connectors: list[OutputConnector] = []
    for config in configs:
        payload = config.model_dump()
        if config.type in {"json", "csv", "excel", "parquet"}:
            connectors.append(FileOutputConnector(payload))
        elif config.type == "database":
            connectors.append(DatabaseOutputConnector(payload))
        elif config.type in {"webhook", "api"}:
            connectors.append(WebhookOutputConnector(payload))
        else:
            raise ValueError(f"Unsupported output connector type '{config.type}'.")
    return connectors

