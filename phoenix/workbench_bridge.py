from __future__ import annotations

import argparse
import json
import tempfile
from pathlib import Path

from phoenix.config import load_config
from phoenix.pipeline import DiscoveryPipeline


def run_pipeline(config_path: str) -> dict[str, object]:
    config = load_config(config_path)
    results = DiscoveryPipeline(config).run()
    tier_counts = {"A": 0, "B": 0, "C": 0}
    output_paths: list[str] = []

    for result in results:
        if result.confidence:
            tier_counts[result.confidence.tier] = tier_counts.get(result.confidence.tier, 0) + 1
        output_paths.extend(result.exported_to)

    return {
        "ok": True,
        "configPath": str(config_path),
        "entityCount": len(results),
        "tierACount": tier_counts.get("A", 0),
        "tierBCount": tier_counts.get("B", 0),
        "tierCCount": tier_counts.get("C", 0),
        "outputPaths": sorted(set(output_paths))
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Bridge for the Electron Phoenix workbench.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    run_parser = subparsers.add_parser("run")
    run_parser.add_argument("--config", type=str)
    run_parser.add_argument("--config-text", type=str)

    args = parser.parse_args()

    if args.command == "run":
        config_path = args.config
        temp_path: Path | None = None

        if not config_path and args.config_text:
            with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as handle:
                handle.write(args.config_text)
                temp_path = Path(handle.name)
            config_path = str(temp_path)

        if not config_path:
            raise SystemExit("Either --config or --config-text must be provided.")

        payload = run_pipeline(config_path)
        print(json.dumps(payload))

        if temp_path and temp_path.exists():
            temp_path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()

