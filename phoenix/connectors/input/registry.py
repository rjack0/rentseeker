from __future__ import annotations

from phoenix.config import InputConfig

from .api_connector import APIConnector
from .base import InputConnector
from .csv_connector import CSVConnector
from .excel_connector import ExcelConnector
from .json_connector import JSONConnector

INPUT_CONNECTORS = [
    CSVConnector(),
    ExcelConnector(),
    JSONConnector(),
    APIConnector(),
]


def build_input_connector(config: InputConfig) -> InputConnector:
    source = config.model_dump(by_alias=True)
    for connector in INPUT_CONNECTORS:
        if connector.can_handle(source):
            return connector
    raise ValueError(f"No input connector available for type '{config.type}'.")
