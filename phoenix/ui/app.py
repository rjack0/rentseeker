from __future__ import annotations

import json
from pathlib import Path

import pandas as pd
import streamlit as st
import yaml


def _load_results(default_path: Path) -> list[dict]:
    if default_path.exists():
        try:
            return json.loads(default_path.read_text())
        except json.JSONDecodeError:
            return []
    return []


def main() -> None:
    st.set_page_config(page_title="Phoenix Platform", layout="wide")

    root = Path(__file__).resolve().parents[2]
    default_config_path = root / "config" / "example_project.yaml"
    default_results_path = root / "results" / "output.json"

    st.sidebar.title("Configuration")
    uploaded = st.sidebar.file_uploader("Load YAML config", type=["yaml", "yml"])
    if uploaded:
        config = yaml.safe_load(uploaded.getvalue().decode("utf-8"))
    elif default_config_path.exists():
        config = yaml.safe_load(default_config_path.read_text())
    else:
        config = {}
    st.sidebar.code(yaml.safe_dump(config, sort_keys=False), language="yaml")

    results = _load_results(default_results_path)
    result_frame = pd.DataFrame(
        [
            {
                "entity_id": row.get("entity_id"),
                "route": row.get("route"),
                "signal_score": row.get("signal_score"),
                "tier": row.get("confidence", {}).get("tier"),
                "confidence_score": row.get("confidence", {}).get("score"),
                "attribute_count": len(row.get("attributes", [])),
            }
            for row in results
        ]
    )

    tab1, tab2, tab3, tab4, tab5 = st.tabs(
        ["Dashboard", "Entity Explorer", "Workflow Builder", "Review Queue", "Export"]
    )

    with tab1:
        st.title("Phoenix Discovery Dashboard")
        col1, col2, col3, col4 = st.columns(4)
        col1.metric("Entities", str(len(results)))
        col2.metric(
            "Avg Confidence",
            f"{result_frame['confidence_score'].mean():.1f}" if not result_frame.empty else "0.0",
        )
        col3.metric(
            "Tier A Rate",
            f"{(result_frame['tier'].eq('A').mean() * 100):.1f}%" if not result_frame.empty else "0.0%",
        )
        col4.metric("Connectors", str(len(config.get("connectors", []))))
        if not result_frame.empty:
            st.bar_chart(result_frame["tier"].value_counts())
            st.dataframe(result_frame, use_container_width=True)
        else:
            st.info("No result file found yet. Run the pipeline later to populate the dashboard.")

    with tab2:
        st.title("Entity Explorer")
        if result_frame.empty:
            st.info("Entity explorer will activate after results exist.")
        else:
            search = st.text_input("Search entity ID")
            filtered = result_frame
            if search:
                filtered = filtered[filtered["entity_id"].astype(str).str.contains(search, case=False)]
            st.dataframe(filtered, use_container_width=True)
            selected = filtered.iloc[0]["entity_id"] if not filtered.empty else None
            if selected:
                detail = next((row for row in results if row.get("entity_id") == selected), None)
                if detail:
                    st.json(detail)

    with tab3:
        st.title("Workflow Builder")
        st.write("Connector pipeline defined by YAML and route-aware tiers.")
        st.code(
            yaml.safe_dump(
                {
                    "input": config.get("input", {}),
                    "connectors": config.get("connectors", []),
                    "scoring": config.get("scoring", {}),
                    "output": config.get("output", []),
                },
                sort_keys=False,
            ),
            language="yaml",
        )

    with tab4:
        st.title("Review Queue")
        review_rows = [
            row
            for row in results
            if row.get("confidence", {}).get("tier") == "B"
        ]
        if review_rows:
            st.dataframe(pd.DataFrame(review_rows), use_container_width=True)
        else:
            st.info("No Tier B review rows available.")

    with tab5:
        st.title("Export")
        st.write("Configured sinks")
        st.json(config.get("output", []))
        if results:
            st.download_button(
                "Download current JSON results",
                data=json.dumps(results, indent=2),
                file_name="phoenix-results.json",
                mime="application/json",
            )


if __name__ == "__main__":
    main()

