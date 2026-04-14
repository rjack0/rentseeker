# RentSeeker

RentSeeker is a complete scaffold for a universal data discovery and enrichment platform. It turns heterogeneous inputs into canonical entities, pre-scores them for likely signal yield, expands them into discovery nodes, runs configurable connector plugins, verifies discovered attributes by consensus, scores final confidence, and exports tiered outputs.

The architecture in this scaffold was shaped by the local reference material in:

- `/Users/rjack/Desktop/almanac/Docs/RE Data Docs/GOATFUNNEL.md`
- `/Users/rjack/Desktop/almanac/Docs/RE Data Docs/FIRSTFUNNEL.md`
- `/Users/rjack/Desktop/almanac/Docs/RE Data Docs/DataTheory.md`
- `/Users/rjack/Desktop/almanac/Docs/DESIGNBRIEF.md`

Those references pushed this implementation toward:

- pre-score driven routing
- graph expansion before expensive discovery
- recursive weak-signal amplification
- explicit consensus verification
- tiered confidence output

## Project Layout

```text
RentSeeker/
├── phoenix/                  # Primary Python package
├── src/                      # Electron main/preload/renderer workbench
├── core/                     # Top-level compatibility exports
├── connectors/               # Top-level compatibility exports
├── ui/                       # Top-level Streamlit entrypoint and assets
├── config/                   # Example configs and deployment settings
├── schemas/                  # JSON schemas
├── tests/                    # Unit and integration coverage
├── tests-dashboard/          # Electron renderer/unit coverage
├── docs/                     # Architecture and deployment docs
├── .references/              # Cloned upstream docs/examples used as build-time grounding
├── data/input/               # Sample input data
├── results/                  # Export destination
├── package.json              # Electron workbench package manifest
├── Dockerfile
├── docker-compose.yml
├── pyproject.toml
└── requirements.txt
```

## Features

- Input connectors for CSV, Excel, JSON, and API sources
- Canonical entity normalization with deterministic IDs
- Signal pre-scoring and route-aware connector execution
- Entity graph expansion with variation rules
- Recursive discovery with cycle detection
- Consensus verification and A/B/C confidence tiering
- Output sinks for JSON, CSV, Excel, Parquet, database, and webhook paths
- Streamlit UI scaffold for dashboards, review queue, and exports
- Electron workbench with bucketed navigation, query lab, dossier pane, and Phoenix run control
- DuckDB-backed desktop workspace that can ingest uploaded CSV/XLSX/JSON files into a local graph
- MapLibre-backed spatial lens for geocoded entities and PMTiles-ready local map layering
- Build-time reference corpus under `.references/` for DuckDB, Electron, MapLibre, and Glide grounding

## Quickstart

```bash
pip install -r requirements.txt
phoenix run --config config/example_project.yaml
streamlit run ui/app.py
```

## Desktop Workbench

The Electron workbench is the main operational surface for this project. It is designed as a three-part operator console:

- left: bucket navigation for datasets, records, parcels, people, permits, zoning, buildability, and control surfaces
- center: connection workspace plus a fast result grid and a spatial lens for geocoded nodes
- right: dossier pane for the selected record or linked entity

The workbench uses DuckDB as its local analytical spine and re-ingests uploaded CSV/XLSX/JSON files into the same graph-oriented workspace that Phoenix runs write back into.

Typical desktop commands:

```bash
npm install --legacy-peer-deps
npm run typecheck
npm run test:desktop
npm run build
```

## Notes

- The connector layer is offline-safe by default when you use the included fixture-based config.
- I did not run any of these commands while building this scaffold.
