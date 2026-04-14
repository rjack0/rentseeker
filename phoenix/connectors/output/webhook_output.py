from __future__ import annotations

import json
from pathlib import Path

import httpx

from .base import OutputConnector


class WebhookOutputConnector(OutputConnector):
    def write(self, results: list[dict[str, object]]) -> str:
        manifest_path = self.config.get("manifest_path")
        if manifest_path:
            path = Path(str(manifest_path))
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(results, indent=2))
            return str(path)

        endpoint = str(self.config["path"])
        response = httpx.post(endpoint, json=results, timeout=30.0)
        response.raise_for_status()
        return endpoint

