/**
 * AnalyticsSuite — Big data analytics overlay for RentSeeker
 * 
 * Full-screen modal with tabs:
 *   - Top Owners: ranked by parcels, acreage, total value
 *   - Heat Map: value density choropleth
 *   - Owner Search: type-ahead for any owner name
 *   - Distribution: value histograms
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import type { TopOwnerEntry, HeatMapCell, AnalyticsSortBy, DistributionsResponse, DistributionBin } from '@shared/types'

const api = (window as any).rentSeeker

type Tab = 'top-owners' | 'heat-map' | 'owner-search' | 'distribution'

function fmtCurrency(val: number): string {
  if (!val) return '—'
  if (val >= 1e9) return `$${(val / 1e9).toFixed(1)}B`
  if (val >= 1e6) return `$${(val / 1e6).toFixed(1)}M`
  if (val >= 1e3) return `$${(val / 1e3).toFixed(0)}K`
  return `$${val.toFixed(0)}`
}

function Bars({ title, bins }: { title: string; bins: DistributionBin[] }) {
  const max = Math.max(1, ...bins.map(b => b.count))
  return (
    <div className="as-dist-block">
      <div className="as-dist-title">{title}</div>
      <div className="as-dist-bars">
        {bins.map((b) => (
          <div key={b.label} className="as-dist-row">
            <div className="as-dist-label">{b.label}</div>
            <div className="as-dist-bar">
              <div className="as-dist-fill" style={{ width: `${(b.count / max) * 100}%` }} />
            </div>
            <div className="as-dist-count">{b.count.toLocaleString()}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function DistributionTab() {
  const [data, setData] = useState<DistributionsResponse | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setLoading(true)
    api.getDistributions()
      .then((resp: DistributionsResponse) => setData(resp))
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="as-loading">Computing distributions...</div>
  if (!data) return <div className="as-loading">Distribution data not available.</div>

  return (
    <div className="as-tab-content">
      <Bars title="Total Value" bins={data.totalValue} />
      <Bars title="Lot Size (sqft)" bins={data.lotSize} />
      <Bars title="Year Built" bins={data.yearBuilt} />
    </div>
  )
}

/* ═══════════════ TOP OWNERS TAB ═══════════════ */

function TopOwnersTab({ onSelectOwner }: { onSelectOwner: (name: string) => void }) {
  const [owners, setOwners] = useState<TopOwnerEntry[]>([])
  const [sortBy, setSortBy] = useState<AnalyticsSortBy>('parcel_count')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setLoading(true)
    api.getTopOwners(sortBy, 100)
      .then((data: TopOwnerEntry[]) => setOwners(data))
      .catch(() => setOwners([]))
      .finally(() => setLoading(false))
  }, [sortBy])

  return (
    <div className="as-tab-content">
      <div className="as-sort-bar">
        <span className="as-sort-label">Rank by:</span>
        {([
          ['parcel_count', 'Parcels'],
          ['total_value', 'Total Value'],
          ['total_acres', 'Acreage'],
          ['total_sqft', 'Total Sqft'],
          ['avg_value', 'Avg Value']
        ] as [AnalyticsSortBy, string][]).map(([key, label]) => (
          <button
            key={key}
            className={`as-sort-btn ${sortBy === key ? 'active' : ''}`}
            onClick={() => setSortBy(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {loading && <div className="as-loading">Crunching data across 800K+ owner records...</div>}

      <div className="as-table-wrap">
        <table className="as-table">
          <thead>
            <tr>
              <th className="as-th-rank">#</th>
              <th className="as-th-name">Owner Name</th>
              <th className="as-th-num">Parcels</th>
              <th className="as-th-num">Total Value</th>
              <th className="as-th-num">Acres</th>
              <th className="as-th-num">Avg Value</th>
            </tr>
          </thead>
          <tbody>
            {owners.map((o, i) => (
              <tr
                key={o.ownerName}
                className="as-row"
                onClick={() => onSelectOwner(o.ownerName)}
              >
                <td className="as-td-rank">{i + 1}</td>
                <td className="as-td-name">{o.ownerName}</td>
                <td className="as-td-num">{o.parcelCount.toLocaleString()}</td>
                <td className="as-td-num as-td-value">{fmtCurrency(o.totalValue)}</td>
                <td className="as-td-num">{o.totalAcres.toFixed(1)}</td>
                <td className="as-td-num">{fmtCurrency(o.avgValue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ═══════════════ HEAT MAP TAB ═══════════════ */

function HeatMapTab() {
  const [cells, setCells] = useState<HeatMapCell[]>([])
  const [loading, setLoading] = useState(false)
  const [resolution, setResolution] = useState(2)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    setLoading(true)
    api.getHeatMapData(resolution)
      .then((data: HeatMapCell[]) => setCells(data))
      .catch(() => setCells([]))
      .finally(() => setLoading(false))
  }, [resolution])

  // Draw the heat map
  useEffect(() => {
    if (!canvasRef.current || cells.length === 0) return
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    canvas.width = 600
    canvas.height = 500

    // Find bounds
    const lats = cells.map(c => c.latBin)
    const lngs = cells.map(c => c.lngBin)
    const minLat = Math.min(...lats), maxLat = Math.max(...lats)
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs)
    const maxVal = Math.max(...cells.map(c => c.totalValue))

    ctx.fillStyle = '#0a0f14'
    ctx.fillRect(0, 0, 600, 500)

    const cellW = 600 / ((maxLng - minLng) / (1 / Math.pow(10, resolution)) + 1)
    const cellH = 500 / ((maxLat - minLat) / (1 / Math.pow(10, resolution)) + 1)

    for (const cell of cells) {
      const x = ((cell.lngBin - minLng) / (maxLng - minLng || 1)) * 580 + 10
      const y = 490 - ((cell.latBin - minLat) / (maxLat - minLat || 1)) * 480
      const intensity = Math.min(1, cell.totalValue / (maxVal * 0.3))

      // Color gradient: dark blue → cyan → gold → red
      let r, g, b
      if (intensity < 0.33) {
        const t = intensity / 0.33
        r = Math.round(0 + t * 0); g = Math.round(30 + t * 180); b = Math.round(80 + t * 175)
      } else if (intensity < 0.66) {
        const t = (intensity - 0.33) / 0.33
        r = Math.round(0 + t * 232); g = Math.round(210 - t * 13); b = Math.round(255 - t * 184)
      } else {
        const t = (intensity - 0.66) / 0.34
        r = Math.round(232 + t * 23); g = Math.round(197 - t * 127); b = Math.round(71 - t * 71)
      }

      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.8)`
      ctx.fillRect(x - cellW / 2, y - cellH / 2, Math.max(4, cellW), Math.max(4, cellH))
    }
  }, [cells, resolution])

  return (
    <div className="as-tab-content">
      <div className="as-sort-bar">
        <span className="as-sort-label">Grid resolution:</span>
        {[1, 2, 3].map(r => (
          <button
            key={r}
            className={`as-sort-btn ${resolution === r ? 'active' : ''}`}
            onClick={() => setResolution(r)}
          >
            {r === 1 ? '~10km' : r === 2 ? '~1km' : '~100m'}
          </button>
        ))}
      </div>
      {loading && <div className="as-loading">Aggregating value data...</div>}
      <div className="as-heatmap-container">
        <canvas ref={canvasRef} className="as-heatmap-canvas" />
        <div className="as-heatmap-legend">
          <span className="as-hl-low">Low</span>
          <div className="as-hl-gradient" />
          <span className="as-hl-high">High</span>
        </div>
        <div className="as-heatmap-stats">
          {cells.length > 0 && (
            <>
              <span>{cells.length} grid cells</span>
              <span>{cells.reduce((s, c) => s + c.parcelCount, 0).toLocaleString()} parcels</span>
              <span>{fmtCurrency(cells.reduce((s, c) => s + c.totalValue, 0))} total value</span>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/* ═══════════════ OWNER SEARCH TAB ═══════════════ */

function OwnerSearchTab({ onSelectOwner }: { onSelectOwner: (name: string) => void }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const debounceRef = useRef<NodeJS.Timeout>()

  useEffect(() => {
    if (query.length < 2) { setResults([]); return }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      setLoading(true)
      try {
        const names = await api.searchOwners(query, 50)
        setResults(names)
      } catch { setResults([]) }
      setLoading(false)
    }, 300)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [query])

  return (
    <div className="as-tab-content">
      <div className="as-search-bar">
        <input
          type="text"
          className="as-search-input"
          placeholder="Search owner names (e.g. SMITH, PATEL, LLC)..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          autoFocus
        />
        {loading && <span className="as-search-spin">⟳</span>}
      </div>
      <div className="as-search-results">
        {results.map(name => (
          <button
            key={name}
            className="as-search-result"
            onClick={() => onSelectOwner(name)}
          >
            <span className="as-sr-icon">👤</span>
            <span className="as-sr-name">{name}</span>
            <span className="as-sr-arrow">→</span>
          </button>
        ))}
        {query.length >= 2 && !loading && results.length === 0 && (
          <div className="as-search-empty">No owners found matching "{query}"</div>
        )}
      </div>
    </div>
  )
}

/* ═══════════════ MAIN ANALYTICS SUITE ═══════════════ */

interface AnalyticsSuiteProps {
  visible: boolean
  onClose: () => void
  onSelectOwner: (name: string) => void
}

export function AnalyticsSuite({ visible, onClose, onSelectOwner }: AnalyticsSuiteProps) {
  const [tab, setTab] = useState<Tab>('top-owners')

  if (!visible) return null

  return (
    <div className="as-overlay">
      <div className="as-panel">
        {/* Header */}
        <div className="as-header">
          <div className="as-header-left">
            <span className="as-header-icon">📊</span>
            <h2>Data Intelligence Suite</h2>
          </div>
          <button className="as-close" onClick={onClose}>✕</button>
        </div>

        {/* Tab bar */}
        <div className="as-tabs">
          {([
            ['top-owners', '🏆 Top Owners'],
            ['heat-map', '🗺 Value Heat Map'],
            ['owner-search', '🔍 Owner Search'],
            ['distribution', '▦ Distribution']
          ] as [Tab, string][]).map(([key, label]) => (
            <button
              key={key}
              className={`as-tab ${tab === key ? 'active' : ''}`}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {tab === 'top-owners' && <TopOwnersTab onSelectOwner={onSelectOwner} />}
        {tab === 'heat-map' && <HeatMapTab />}
        {tab === 'owner-search' && <OwnerSearchTab onSelectOwner={onSelectOwner} />}
        {tab === 'distribution' && <DistributionTab />}
      </div>
    </div>
  )
}

/* ═══════════════ ANALYTICS TOGGLE BUTTON ═══════════════ */

export function AnalyticsToggleButton({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  return (
    <button
      className={`pe-analytics-toggle ${active ? 'active' : ''}`}
      onClick={onToggle}
      title="Data Intelligence Suite"
    >
      <span className="pe-analytics-icon">📊</span>
    </button>
  )
}
