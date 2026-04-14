# Architecture

RentSeeker implements a layered discovery pipeline:

1. Inputs arrive through connector adapters for files or APIs.
2. Raw records are normalized into canonical `Entity` objects.
3. `SignalPreScorer` computes a 0-100 route score.
4. `EntityGraphExpander` fans each entity into multiple discovery nodes.
5. `RecursiveDiscoveryOrchestrator` runs applicable connectors per route tier.
6. `ConsensusVerificationEngine` scores independent agreement on attributes.
7. `ConfidenceScorer` assigns an A/B/C output tier.
8. Output connectors materialize JSON, CSV, Excel, Parquet, database, or webhook payloads.
9. The Electron workbench reads the same DuckDB workspace to present buckets, graphs, dossiers, query composition, and Phoenix run control.

## Architectural References

This design intentionally follows the patterns surfaced in the local RE reference docs:

- graph-first expansion before expensive discovery
- route-aware pre-scoring
- recursive enrichment from weak signals
- verification as a distinct layer instead of source-count handwaving

## Package Breakdown

- `phoenix/core`: normalization, scoring, orchestration, and verification logic
- `phoenix/connectors`: input, discovery, and output plugin systems
- `phoenix/ui`: Streamlit dashboard scaffold
- `src/main`: Electron main-process workspace services, IPC, and Python bridge
- `src/preload`: secure renderer bridge for workbench actions
- `src/renderer`: the operator-facing bucket dashboard, graph canvas, grid, dossier, and control panels
- `config`: project and deployment configuration
- `schemas`: machine-readable schemas for entity and result objects

## Desktop Workbench Shape

The Electron UI follows a simple operator model instead of a generic admin layout:

1. A left rail groups the universe into orthogonal data buckets and control buckets.
2. The center stage shows the relationship fabric and the result grid for the active bucket or query.
3. The right dossier stays focused on one selected record or linked entity at a time.

This lets a user move from a universal search term such as a name, address, parcel ID, permit number, or zoning code into cross-bucket record selection, then into a detailed dossier, without changing tools.

## Build-Time Grounding

The `.references/` directory is intentionally not part of runtime. It exists as a build-time grounding corpus pulled from upstream projects so the Electron and local-data integration follows real library structures rather than invented wrappers.
