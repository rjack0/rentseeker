from pathlib import Path

import yaml
from typer.testing import CliRunner

from phoenix.cli import app
from phoenix.config import load_config
from phoenix.pipeline import DiscoveryPipeline


def test_example_config_runs_offline_end_to_end(tmp_path) -> None:
    root = Path(__file__).resolve().parents[2]
    example = yaml.safe_load((root / "config" / "example_project.yaml").read_text())
    example["input"]["path"] = str(root / "data" / "input" / "sample_input.csv")
    example["output"][0]["path"] = str(tmp_path / "output.json")
    example["output"][1]["path"] = str(tmp_path / "output.csv")

    config_path = tmp_path / "example.yaml"
    config_path.write_text(yaml.safe_dump(example, sort_keys=False))

    config = load_config(config_path)
    results = DiscoveryPipeline(config).run()
    assert len(results) == 3
    assert all(result.exported_to for result in results)
    assert Path(config.output[0].path).exists()
    assert Path(config.output[1].path).exists()

    runner = CliRunner()
    cli_result = runner.invoke(app, ["run", "--config", str(config_path)])
    assert cli_result.exit_code == 0
    assert "Discovery Run Summary" in cli_result.output

