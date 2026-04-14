from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from phoenix.core.models import DiscoveredAttribute

from .base import DiscoveryConnector


class DocumentParserConnector(DiscoveryConnector):
    name = "document_parser"

    def can_handle(self, node: dict[str, Any]) -> bool:
        attrs = node.get("attributes", {})
        return bool(attrs.get("text") or attrs.get("document_path"))

    def discover(self, node: dict[str, Any]) -> list[DiscoveredAttribute]:
        attrs = node.get("attributes", {})
        text = str(attrs.get("text") or "")
        path_value = attrs.get("document_path")
        if not text and path_value:
            path = Path(str(path_value))
            if path.exists() and path.suffix.lower() in {".txt", ".md", ".html", ".json"}:
                raw = path.read_text(encoding="utf-8")
                text = json.dumps(json.loads(raw), indent=2) if path.suffix.lower() == ".json" else raw

        discovered: list[DiscoveredAttribute] = []
        for email in re.findall(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", text):
            discovered.append(
                DiscoveredAttribute(
                    name="email",
                    value=email,
                    source=self.name,
                    confidence=0.76,
                )
            )
        for phone in re.findall(r"\+?\d[\d\-\(\)\s]{7,}\d", text):
            discovered.append(
                DiscoveredAttribute(
                    name="phone",
                    value=phone.strip(),
                    source=self.name,
                    confidence=0.70,
                )
            )
        for url in re.findall(r"https?://[^\s)]+", text):
            discovered.append(
                DiscoveredAttribute(
                    name="source_url",
                    value=url,
                    source=self.name,
                    confidence=0.72,
                )
            )
        return discovered

