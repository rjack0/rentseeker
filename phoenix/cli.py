from __future__ import annotations

import json
from pathlib import Path

import typer
from rich.console import Console
from rich.table import Table

from .config import load_config
from .pipeline import DiscoveryPipeline

app = typer.Typer(help="Phoenix universal data discovery platform.")
console = Console()


@app.command()
def run(config: Path = typer.Option(..., exists=True, readable=True)) -> None:
    phoenix_config = load_config(config)
    results = DiscoveryPipeline(phoenix_config).run()
    table = Table(title="Discovery Run Summary")
    table.add_column("Entity ID")
    table.add_column("Route")
    table.add_column("Signal")
    table.add_column("Tier")
    table.add_column("Attributes")
    for result in results:
        table.add_row(
            result.entity_id,
            result.route,
            str(result.signal_score),
            result.confidence.tier if result.confidence else "-",
            str(len(result.attributes)),
        )
    console.print(table)


@app.command()
def view(
    config: Path = typer.Option(..., exists=True, readable=True),
    tier: str = typer.Option("A"),
) -> None:
    phoenix_config = load_config(config)
    results = DiscoveryPipeline(phoenix_config).run()
    filtered = [result for result in results if result.confidence and result.confidence.tier == tier]
    console.print_json(json.dumps([result.model_dump(mode="json") for result in filtered], indent=2))


@app.command("print-sample-config")
def print_sample_config() -> None:
    sample_path = Path(__file__).resolve().parents[1] / "config" / "example_project.yaml"
    console.print(sample_path.read_text(), markup=False)


if __name__ == "__main__":
    app()
