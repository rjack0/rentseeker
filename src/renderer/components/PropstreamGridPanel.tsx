import { useEffect, useMemo, useState } from 'react'

import type {
  DashboardApi,
  ImportedDataFolder,
  PropstreamGridPayload,
  PropstreamGridRecord
} from '@shared/types'

interface PropstreamGridPanelProps {
  api?: DashboardApi
  visible: boolean
  onClose: () => void
}

function formatNumber(value: number | '' | undefined): string {
  if (value === '' || value == null || Number.isNaN(Number(value))) return '—'
  return Number(value).toLocaleString()
}

function previewText(record: PropstreamGridRecord): string {
  return [
    record.characteristics,
    record.sourceFiles.join(' · '),
    record.sourceIndexes.join(' · ')
  ].filter(Boolean).join(' • ')
}

export function PropstreamGridPanel({ api, visible, onClose }: PropstreamGridPanelProps) {
  const [payload, setPayload] = useState<PropstreamGridPayload | null>(null)
  const [folders, setFolders] = useState<ImportedDataFolder[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [activeDataset, setActiveDataset] = useState<string>('All')
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null)

  useEffect(() => {
    if (!visible || !api) return
    let alive = true
    setLoading(true)
    setError(null)

    const run = async () => {
      try {
        const [syncResult, grid] = await Promise.all([
          api.syncPropstreamFolders().catch((err: any) => ({ ok: false, folders: [], error: err?.message || String(err) })),
          api.getPropstreamGridData()
        ])
        if (!alive) return
        setPayload(grid)
        setFolders(syncResult?.ok ? syncResult.folders : [])
        setSelectedRecordId((current) => current ?? grid.records[0]?.propertyId ?? null)
        if (syncResult && !syncResult.ok) {
          setError(syncResult.error ?? 'Unable to sync PropStream folders')
        }
      } catch (err: any) {
        if (!alive) return
        setError(err?.message || String(err))
      } finally {
        if (alive) setLoading(false)
      }
    }

    void run()

    return () => {
      alive = false
    }
  }, [api, visible])

  const filteredRecords = useMemo(() => {
    const records = payload?.records ?? []
    const needle = search.trim().toLowerCase()
    return [...records]
      .filter((record) => {
        if (activeDataset !== 'All' && !record.searchLists.includes(activeDataset)) return false
        if (!needle) return true
        const haystack = [
          record.address,
          record.value,
          record.valueLabel,
          record.estEquity,
          record.estLoanBalance,
          record.characteristics,
          record.searchLists.join(' '),
          record.sourceFiles.join(' '),
          record.sourceIndexes.join(' ')
        ].join(' ').toLowerCase()
        return haystack.includes(needle)
      })
      .sort((a, b) => (b.valueAmount || 0) - (a.valueAmount || 0) || a.address.localeCompare(b.address))
  }, [activeDataset, payload?.records, search])

  useEffect(() => {
    if (!filteredRecords.length) {
      setSelectedRecordId(null)
      return
    }
    setSelectedRecordId((current) => {
      if (current && filteredRecords.some((record) => record.propertyId === current)) return current
      return filteredRecords[0]?.propertyId ?? null
    })
  }, [filteredRecords])

  const selectedRecord = useMemo(() => {
    if (!selectedRecordId) return filteredRecords[0] ?? payload?.records[0] ?? null
    return filteredRecords.find((record) => record.propertyId === selectedRecordId)
      ?? payload?.records.find((record) => record.propertyId === selectedRecordId)
      ?? null
  }, [filteredRecords, payload?.records, selectedRecordId])

  const datasetOptions = useMemo(() => {
    const base = payload?.datasets ?? []
    return [
      { name: 'All', color: '#abff02', count: payload?.uniqueProperties ?? 0 },
      ...base
    ]
  }, [payload?.datasets, payload?.uniqueProperties])

  const sourceStats = payload?.sourceStats ?? []
  const syncedFolderCount = folders.length > 0 ? folders.length : (payload?.datasets.length ?? 0)

  const syncFolders = async () => {
    if (!api) return
    setLoading(true)
    try {
      const [syncResult, grid] = await Promise.all([
        api.syncPropstreamFolders(),
        api.getPropstreamGridData()
      ])
      setPayload(grid)
      setFolders(syncResult.ok ? syncResult.folders : [])
      if (!syncResult.ok) setError(syncResult.error ?? 'Unable to sync PropStream folders')
    } catch (err: any) {
      setError(err?.message || String(err))
    } finally {
      setLoading(false)
    }
  }

  if (!visible) return null

  return (
    <div className="pe-propstream-overlay">
      <div className="pe-propstream-shell">
        <aside className="pe-propstream-rail">
          <div className="pe-propstream-head">
            <div>
              <div className="pe-propstream-kicker">PropStream HTML</div>
              <h3>Listing Grid</h3>
            </div>
            <button className="pe-propstream-close" onClick={onClose}>CLOSE</button>
          </div>

          <div className="pe-propstream-stat-grid">
            <div>
              <span>Records</span>
              <strong>{payload?.uniqueProperties?.toLocaleString() ?? '—'}</strong>
            </div>
            <div>
              <span>Cards</span>
              <strong>{payload?.totalCards?.toLocaleString() ?? '—'}</strong>
            </div>
            <div>
              <span>Datasets</span>
              <strong>{payload?.datasets?.length?.toLocaleString() ?? '—'}</strong>
            </div>
            <div>
              <span>Synced folders</span>
              <strong>{syncedFolderCount.toLocaleString()}</strong>
            </div>
          </div>

          <div className="pe-propstream-search-row">
            <input
              className="pe-propstream-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search address, value, beds, baths…"
            />
            <button className="pe-propstream-sync" onClick={() => void syncFolders()}>
              SYNC FOLDERS
            </button>
          </div>

          <div className="pe-propstream-rail-section">
            <div className="pe-propstream-section-title">Datasets as folders</div>
            <div className="pe-propstream-folder-list">
              {datasetOptions.map((dataset) => (
                <button
                  key={dataset.name}
                  className={`pe-propstream-folder-chip ${activeDataset === dataset.name ? 'active' : ''}`}
                  onClick={() => setActiveDataset(dataset.name)}
                >
                  <span className="swatch" style={{ background: dataset.color }} />
                  <span className="label">{dataset.name}</span>
                  <strong>{dataset.count.toLocaleString()}</strong>
                </button>
              ))}
            </div>
          </div>

          <div className="pe-propstream-rail-section">
            <div className="pe-propstream-section-title">HTML source files</div>
            <div className="pe-propstream-source-list">
              {sourceStats.map((item) => (
                <div key={item.file} className="pe-propstream-source-row">
                  <span>{item.file}</span>
                  <strong>{item.cards.toLocaleString()}</strong>
                </div>
              ))}
            </div>
          </div>

          {error && <div className="pe-propstream-error">{error}</div>}
        </aside>

        <section className="pe-propstream-main">
          <div className="pe-propstream-toolbar">
            <div className="pe-propstream-toolbar-copy">
              <span>Filtered</span>
              <strong>{filteredRecords.length.toLocaleString()}</strong>
            </div>
            <div className="pe-propstream-toolbar-copy">
              <span>Visible datasets</span>
              <strong>{activeDataset}</strong>
            </div>
            <button className="pe-propstream-clear" onClick={() => setActiveDataset('All')}>
              CLEAR DATASET
            </button>
          </div>

          {loading && !payload ? (
            <div className="pe-propstream-loading">
              <div className="pe-loading-spinner" />
              <div className="pe-propstream-loading-copy">Loading PropStream HTML export…</div>
            </div>
          ) : (
            <div className="pe-propstream-grid">
              {filteredRecords.map((record) => {
                const isSelected = record.propertyId === selectedRecord?.propertyId
                return (
                  <article
                    key={record.propertyId}
                    className={`pe-propstream-card ${isSelected ? 'active' : ''}`}
                    onClick={() => setSelectedRecordId(record.propertyId)}
                  >
                    <div className="pe-propstream-card-media">
                      {record.imageUrl ? (
                        <img src={record.imageUrl} alt={record.address} loading="lazy" />
                      ) : (
                        <div className="pe-propstream-photo-fallback">NO PHOTO</div>
                      )}
                      <div className="pe-propstream-media-overlay">
                        <span>{record.imageCount > 0 ? `${record.imageCount} image${record.imageCount === 1 ? '' : 's'}` : 'No image'}</span>
                        <a href={record.propstreamUrl} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
                          OPEN
                        </a>
                      </div>
                    </div>

                    <div className="pe-propstream-card-body">
                      <div className="pe-propstream-card-title">{record.address}</div>
                      <div className="pe-propstream-card-value">
                        <strong>{record.value || '—'}</strong>
                        <span>{record.valueLabel || 'EST. VALUE'}</span>
                      </div>
                      <div className="pe-propstream-card-metrics">
                        <div><span>Beds</span><strong>{formatNumber(record.beds)}</strong></div>
                        <div><span>Baths</span><strong>{formatNumber(record.baths)}</strong></div>
                        <div><span>Sq Ft</span><strong>{formatNumber(record.sqft)}</strong></div>
                        <div><span>Lot</span><strong>{formatNumber(record.lotSqft)}</strong></div>
                      </div>
                      <div className="pe-propstream-card-metrics secondary">
                        <div><span>Equity</span><strong>{record.estEquity || '—'}</strong></div>
                        <div><span>Loan</span><strong>{record.estLoanBalance || '—'}</strong></div>
                        <div><span>Last sale</span><strong>{record.lastSale || '—'}</strong></div>
                        <div><span>Property ID</span><strong>{record.propertyId}</strong></div>
                      </div>
                      <div className="pe-propstream-dataset-tags">
                        {record.searchLists.map((list) => (
                          <button
                            key={list}
                            className="pe-propstream-tag"
                            onClick={(event) => {
                              event.stopPropagation()
                              setActiveDataset(list)
                            }}
                          >
                            {list}
                          </button>
                        ))}
                      </div>
                      <div className="pe-propstream-source-preview">{previewText(record)}</div>
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </section>

        <aside className="pe-propstream-detail">
          {selectedRecord ? (
            <>
              <div className="pe-propstream-detail-image">
                {selectedRecord.imageUrl ? (
                  <img src={selectedRecord.imageUrl} alt={selectedRecord.address} />
                ) : (
                  <div className="pe-propstream-photo-fallback">NO PHOTO</div>
                )}
              </div>

              <div className="pe-propstream-detail-title">{selectedRecord.address}</div>
              <div className="pe-propstream-detail-value">
                <strong>{selectedRecord.value || '—'}</strong>
                <span>{selectedRecord.valueLabel || 'EST. VALUE'}</span>
              </div>

              <div className="pe-propstream-detail-grid">
                <div><span>Beds</span><strong>{formatNumber(selectedRecord.beds)}</strong></div>
                <div><span>Baths</span><strong>{formatNumber(selectedRecord.baths)}</strong></div>
                <div><span>Sq Ft</span><strong>{formatNumber(selectedRecord.sqft)}</strong></div>
                <div><span>Lot</span><strong>{formatNumber(selectedRecord.lotSqft)}</strong></div>
                <div><span>Equity</span><strong>{selectedRecord.estEquity || '—'}</strong></div>
                <div><span>Loan</span><strong>{selectedRecord.estLoanBalance || '—'}</strong></div>
              </div>

              <div className="pe-propstream-detail-section">
                <div className="pe-propstream-section-title">Cross-reference</div>
                <div className="pe-propstream-source-stack">
                  <div><strong>Datasets</strong><span>{selectedRecord.searchLists.join(' · ') || '—'}</span></div>
                  <div><strong>Source files</strong><span>{selectedRecord.sourceFiles.join(' · ') || '—'}</span></div>
                  <div><strong>Index refs</strong><span>{selectedRecord.sourceIndexes.join(' · ') || '—'}</span></div>
                  <div><strong>Image path</strong><span>{selectedRecord.imagePath || '—'}</span></div>
                </div>
              </div>

              <div className="pe-propstream-detail-section">
                <div className="pe-propstream-section-title">Characteristics</div>
                <div className="pe-propstream-characteristics">{selectedRecord.characteristics || '—'}</div>
              </div>

              <a className="pe-propstream-open" href={selectedRecord.propstreamUrl} target="_blank" rel="noreferrer">
                OPEN IN PROPSTREAM
              </a>
            </>
          ) : (
            <div className="pe-propstream-detail-empty">
              <div className="pe-propstream-kicker">No record selected</div>
              <p>Pick a property card to inspect images, source files, and folder matches.</p>
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}
