import { useDeferredValue, useEffect, useMemo, useState } from 'react'

import exampleProjectConfig from '../../config/example_project.yaml?raw'

import type {
  BucketDataResponse,
  BucketKey,
  BucketRow,
  DashboardSnapshot,
  DossierResponse,
  PhoenixRunResponse,
  QueryRequest,
  QueryResult
} from '@shared/types'

import { BucketSidebar } from './components/BucketSidebar'
import { ConnectionCanvas } from './components/ConnectionCanvas'
import { DataGridPanel } from './components/DataGridPanel'
import { DossierPanel } from './components/DossierPanel'
import { MetricStrip } from './components/MetricStrip'
import { ParcelExplorer } from './components/ParcelExplorer'
import { PhoenixControlPanel } from './components/PhoenixControlPanel'
import { QueryLabPanel } from './components/QueryLabPanel'

const initialQuery: QueryRequest = {
  searchText: '',
  limit: 250,
  offset: 0,
  filters: [],
  sorts: []
}

const bucketKeys = new Set<BucketKey>([
  'overview',
  'uploads',
  'records',
  'parcels',
  'addresses',
  'people',
  'phones',
  'permits',
  'deeds',
  'zoning',
  'buildability',
  'runs',
  'query-lab',
  'phoenix-control'
])

export function App() {
  const hasDashboardApi = typeof window !== 'undefined' && Boolean(window.rentSeeker)
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null)
  const [activeBucket, setActiveBucket] = useState<BucketKey>('overview')
  const [bucketData, setBucketData] = useState<BucketDataResponse | null>(null)
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null)
  const [selectedEntityId, setSelectedEntityId] = useState<string>()
  const [dossier, setDossier] = useState<DossierResponse>()
  const [query, setQuery] = useState<QueryRequest>(initialQuery)
  const [configText, setConfigText] = useState(exampleProjectConfig)
  const [configPath, setConfigPath] = useState<string>()
  const [runningPhoenix, setRunningPhoenix] = useState(false)
  const [runResult, setRunResult] = useState<PhoenixRunResponse>()
  const [loading, setLoading] = useState(false)
  const [showParcelExplorer, setShowParcelExplorer] = useState(true)
  const deferredSearchText = useDeferredValue(query.searchText)

  const activeQuery = useMemo<QueryRequest>(
    () => ({
      ...query,
      searchText: deferredSearchText
    }),
    [deferredSearchText, query]
  )

  const refreshSnapshot = async () => {
    if (!hasDashboardApi) return
    const next = await window.rentSeeker.getSnapshot()
    setSnapshot(next)
  }

  const loadBucket = async (bucket: BucketKey, nextQuery: QueryRequest) => {
    if (!hasDashboardApi) return
    setLoading(true)
    try {
      if (bucket === 'query-lab') {
        const result = await window.rentSeeker.runQuery(nextQuery)
        setQueryResult(result)
        setBucketData(null)
      } else {
        const result = await window.rentSeeker.getBucketData(bucket, nextQuery)
        setBucketData(result)
        setQueryResult(null)
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!hasDashboardApi) return
    void refreshSnapshot()
  }, [hasDashboardApi])

  useEffect(() => {
    if (!hasDashboardApi) return
    void loadBucket(activeBucket, activeQuery)
  }, [activeBucket, activeQuery, hasDashboardApi])

  useEffect(() => {
    if (!hasDashboardApi) return
    if (
      !selectedEntityId ||
      bucketKeys.has(selectedEntityId as BucketKey) ||
      activeBucket === 'uploads' ||
      activeBucket === 'runs'
    ) {
      setDossier(undefined)
      return
    }
    void window.rentSeeker.getDossier(selectedEntityId).then(setDossier)
  }, [selectedEntityId, activeBucket, hasDashboardApi])

  const activeGraph = queryResult?.graph ?? bucketData?.graph ?? {
    title: 'Connection Workspace',
    nodes: [],
    edges: []
  }

  const tableRows = useMemo(() => {
    if (activeBucket === 'query-lab' && queryResult) {
      return queryResult.rows.map((row, index) => ({
        id: String(row.id ?? index),
        title: String(row.record_label ?? row.id ?? `Result ${index + 1}`),
        values: Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'id' && key !== 'record_label'))
      }))
    }
    return bucketData?.rows ?? []
  }, [activeBucket, queryResult, bucketData])

  const tableColumns = activeBucket === 'query-lab'
    ? queryResult?.columns ?? []
    : bucketData?.columns ?? []

  const activeBucketDescription = snapshot?.buckets.find((bucket) => bucket.key === activeBucket)

  const handleUpload = async () => {
    const paths = await window.rentSeeker.pickImportFiles()
    if (paths.length === 0) {
      return
    }
    await window.rentSeeker.ingestFiles({ filePaths: paths })
    await refreshSnapshot()
    await loadBucket(activeBucket, query)
  }

  const handleLoadConfig = async () => {
    const result = await window.rentSeeker.loadConfigFile()
    if (result.text) {
      setConfigText(result.text)
      setConfigPath(result.path)
    }
  }

  const handleRunPhoenix = async () => {
    setRunningPhoenix(true)
    try {
      const result = await window.rentSeeker.runPhoenix({ configPath, configText })
      setRunResult(result)
      await refreshSnapshot()
      await loadBucket(activeBucket, query)
    } finally {
      setRunningPhoenix(false)
    }
  }

  // If parcel explorer mode is active, render it full-screen
  if (showParcelExplorer) {
    return <ParcelExplorer />
  }

  return (
    <div className="app-shell">
      <BucketSidebar
        buckets={snapshot?.buckets ?? []}
        activeBucket={activeBucket}
        workspacePath={snapshot?.workspacePath}
        onSelect={(bucket) => {
          setSelectedEntityId(undefined)
          setActiveBucket(bucket)
        }}
      />

      <main className="main-stage">
        <header className="top-bar">
          <div className="top-bar-copy">
            <div className="top-bar-kicker">Local DuckDB mission console</div>
            <h2>{activeBucketDescription?.label ?? 'RentSeeker'}</h2>
            <p>{activeBucketDescription?.description ?? 'Search, connect, and run the system from one surface.'}</p>
          </div>

          <div className="top-bar-actions">
            <input
              className="global-search"
              placeholder="Search names, parcels, permits, zoning, phones, addresses…"
              value={query.searchText}
              onChange={(event) => setQuery((current) => ({ ...current, searchText: event.target.value }))}
            />
            <button className="action-button" onClick={handleUpload}>
              Upload CSV / XLSX
            </button>
            <button className="action-button solid" onClick={() => setActiveBucket('phoenix-control')}>
              Open Run Bucket
            </button>
          </div>
        </header>

        <div className="surface-status-strip">
          <div className="surface-status-card">
            <span>Workspace File</span>
            <strong>{snapshot?.workspacePath ?? 'Initializing local DuckDB workspace…'}</strong>
          </div>
          <div className="surface-status-card">
            <span>Visible Surface</span>
            <strong>
              {activeBucket === 'query-lab'
                ? `${queryResult?.total ?? 0} query matches`
                : `${bucketData?.total ?? 0} bucket rows`}
            </strong>
          </div>
          <div className="surface-status-card">
            <span>Current Search</span>
            <strong>{query.searchText.trim() || 'No universal search term'}</strong>
          </div>
        </div>

        <MetricStrip metrics={snapshot?.metrics ?? []} />

        <div className="stage-grid">
          <section className="center-column">
            {(activeBucket === 'query-lab' || activeBucket === 'phoenix-control') ? (
              activeBucket === 'query-lab' ? (
                <QueryLabPanel query={query} onChange={setQuery} onRun={() => void loadBucket('query-lab', query)} />
              ) : (
                <PhoenixControlPanel
                  configPath={configPath}
                  configText={configText}
                  setConfigText={setConfigText}
                  onLoadConfig={handleLoadConfig}
                  onRun={handleRunPhoenix}
                  running={runningPhoenix}
                  runResult={runResult}
                />
              )
            ) : null}

            <ConnectionCanvas
              graph={activeGraph}
              selectedId={selectedEntityId}
              onSelect={(nodeId) => setSelectedEntityId(nodeId)}
            />

            <DataGridPanel
              title={loading ? 'Loading…' : `${activeBucketDescription?.label ?? 'Results'} surface`}
              columns={tableColumns}
              rows={tableRows as BucketRow[]}
              onSelect={(rowId) => setSelectedEntityId(rowId)}
            />
          </section>

          <DossierPanel dossier={dossier} onSelectEntity={(entityId) => setSelectedEntityId(entityId)} />
        </div>
      </main>
    </div>
  )
}
