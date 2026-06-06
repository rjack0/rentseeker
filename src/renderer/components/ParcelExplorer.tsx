/**
 * ParcelExplorer — Map-Centric Industrial Theatre v2
 *
 * Phase 2 Architecture:
 *   - Full-screen dark map (MapLibre GL + CartoDB Dark Matter tiles)
 *   - GeoJSON source + circle layers for perfectly synced markers
 *   - Multi-dataset cross-referencing (Parcel + Certificate of Occupancy)
 *   - Smart FilterBar with APN prefix, value range, C-of-O, draw-a-boundary
 *   - Bottom horizontal strip of compact parcel cards
 *   - Right sidebar dossier panel with C-of-O data
 *   - Dataset legend with color-coded toggles
 *   - Google 3D Photorealistic Tiles toggle (deck.gl)
 */

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { Geometry } from 'geojson'
import type {
  ParcelRecord,
  ParcelQueryResult,
  ParcelFilterQuery,
  DataSource,
  TerrainMetrics,
  TerrainMetricsResponse,
  SunAnalysis,
  SunAnalysisResponse,
  ParcelPolygon,
  DataLoadProgress,
  DataLoadStep,
  ParcelPmtilesInfo,
  BuildRunOutput,
  MapBounds,
  ParcelSelectionMode,
  HeatMapCell,
  ParcelDossierProvenance,
  ParcelFactProvenance,
  ParcelFactSourceManifestEntry,
  ParcelSourceBlobStats,
  ParcelAnalysisBundleResponse
} from '@shared/types'
import { geometryFingerprint, normalizeAin } from '@shared/sourceRegistry'
import { useDeck3DOverlay, Toggle3DButton, ClayModeToggle, SlopeTooltip } from './Deck3DOverlay'
import { SunOverlay, SunToggleButton } from './SunOverlay'
import { ViewOverlay, ViewToggleButton } from './ViewOverlay'
import { BuildPanel, BuildToggleButton } from './BuildPanel'
import { OwnerPanel } from './OwnerPanel'
import { AnalyticsSuite, AnalyticsToggleButton } from './AnalyticsSuite'
import { LoadingCinema } from './LoadingCinema'
import { PropstreamGridPanel } from './PropstreamGridPanel'

/* ═══════════════════════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════════════════════ */

const TARGET_PARCELS = '5560002009, 5560003013, 5556007007, 5556028011'

const MAP_STYLE = {
  version: 8 as const,
  name: 'Dark Matter',
  sources: {
    'carto-dark': {
      type: 'raster' as const,
      tiles: [
        'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
        'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
        'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png'
      ],
      tileSize: 256,
      attribution: '&copy; CartoDB'
    }
  },
  layers: [
    {
      id: 'carto-dark-layer',
      type: 'raster' as const,
      source: 'carto-dark',
      minzoom: 0,
      maxzoom: 20
    }
  ]
}

const LA_CENTER: [number, number] = [-118.25, 34.05]

// Default startup: Golden Triangle (Beverly Hills), zoomed-in so PMTiles parcel boundaries
// only need to load the on-screen neighborhood (not a huge swath of LA).
// Start very zoomed in so the initial parcel-boundary render stays in the low-thousands.
// Note: PMTiles maxZoom is 15; MapLibre overzooms (reuses z15 tiles) for z>15 which still
// reduces the viewport area and therefore visible parcel count.
// Calibrated so the initial viewport stays under the ~2.5k parcel boundary target.
const DEFAULT_ZOOM = 17.7
const SANTA_MONICA_MOUNTAINS_CENTER: [number, number] = [-118.4057, 34.0676]

const PMTILES_ARCHIVE_KEY = 'lacounty-parcels'
const PMTILES_VECTOR_SOURCE_ID = 'parcel-boundaries-vt'
const PMTILES_VECTOR_LAYER_ID = 'parcels'
const PMTILES_LINE_LAYER_ID = 'parcel-boundaries-line'
const PMTILES_FILL_LAYER_ID = 'parcel-boundaries-fill'
const PARCEL_BOUNDARY_RENDER_MIN_ZOOM = 15
const MAX_VISIBLE_PARCEL_BOUNDARIES = 2500

const DATASET_COLORS = {
  parcel: '#00d4ff',
  sbf: '#ffde59',
  cofo: '#ff7a45',
  building: '#a78bfa',
  electrical: '#34d399',
  submitted: '#f472b6',
  inspection: '#94a3b8',
  polygon: '#abff02',
  both: '#abff02',
  target: '#abff02',
  selected: '#ffffff'
}

interface VisualSettings {
  showDots: boolean
  showPolygonFill: boolean
  streetClearEdges: boolean
  lineStrength: number
  datasetColorDots: boolean
  showTopoOverlay: boolean
  showHeatOverlay: boolean
  showPmtilesInspector: boolean
}

const DEFAULT_VISUAL_SETTINGS: VisualSettings = {
  showDots: true,
  showPolygonFill: false,
  streetClearEdges: true,
  lineStrength: 1,
  datasetColorDots: true,
  showTopoOverlay: false,
  showHeatOverlay: false,
  showPmtilesInspector: false
}

const MAP_STATE_KEY = 'rentseeker.mapState'

function getSavedMapState(): { center: [number, number]; zoom: number; bounds?: { north: number; south: number; east: number; west: number } } | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(MAP_STATE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { center?: [number, number]; zoom?: number; bounds?: { north: number; south: number; east: number; west: number } }
    if (!parsed.center || typeof parsed.zoom !== 'number') return null
    // Ensure we don't restore to a zoom where parcel boundary layers are disabled.
    const zoom = Math.max(parsed.zoom, PARCEL_BOUNDARY_RENDER_MIN_ZOOM)
    return { center: parsed.center, zoom, bounds: parsed.bounds }
  } catch {
    return null
  }
}

function saveMapState(map: maplibregl.Map) {
  try {
    const center = map.getCenter()
    const bounds = map.getBounds()
    window.localStorage.setItem(MAP_STATE_KEY, JSON.stringify({
      center: [center.lng, center.lat],
      zoom: map.getZoom(),
      bounds: {
        north: bounds.getNorth(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        west: bounds.getWest()
      }
    }))
  } catch {
    // localStorage can be disabled in hardened contexts.
  }
}

function lngLatToTile(lng: number, lat: number, z: number): { x: number; y: number } {
  const n = Math.pow(2, z)
  const x = Math.floor(((lng + 180) / 360) * n)
  const latRad = (lat * Math.PI) / 180
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n)
  return { x, y }
}

function ensurePmtilesProtocolRegistered() {
  if (typeof window === 'undefined') return
  const w = window as unknown as {
    __rentseeker_pmtiles_protocol__?: boolean
    __rentseeker_pmtiles_first_tile__?: boolean
    __rentseeker_pmtiles_stats__?: { tiles: number; totalMs: number; lastMs: number }
    rentSeeker?: any
  }
  if (w.__rentseeker_pmtiles_protocol__) return
  if (!w.rentSeeker?.getParcelPmtilesTile) {
    // Desktop API not ready yet; try again shortly.
    window.setTimeout(() => ensurePmtilesProtocolRegistered(), 250)
    return
  }
  maplibregl.addProtocol('pmtiles', async (params: any, abortController: AbortController) => {
    const url: string = params?.url ?? ''
    const match = url.match(/^pmtiles:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)(?:\.[a-z0-9]+)?$/i)
    if (!match) {
      throw new Error(`Invalid pmtiles url: ${url}`)
    }
    const key = match[1]
    if (key !== PMTILES_ARCHIVE_KEY) {
      throw new Error(`Unknown pmtiles archive key: ${key}`)
    }
    const z = Number(match[2])
    const x = Number(match[3])
    const y = Number(match[4])
    const t0 = performance.now()
    const tile = await w.rentSeeker.getParcelPmtilesTile(z, x, y)
    const dt = Math.max(0, performance.now() - t0)
    const stats = w.__rentseeker_pmtiles_stats__ ?? { tiles: 0, totalMs: 0, lastMs: 0 }
    stats.tiles += 1
    stats.totalMs += dt
    stats.lastMs = dt
    w.__rentseeker_pmtiles_stats__ = stats
    try { window.dispatchEvent(new CustomEvent('rentseeker:pmtiles:stats', { detail: stats })) } catch { /* ignore */ }
    abortController.signal?.throwIfAborted?.()
    if (!tile) return { data: null }
    // MapLibre expects an (uncompressed) pbf for vector tiles.
    const bytes = tile instanceof Uint8Array ? tile : new Uint8Array(tile)
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    if (!w.__rentseeker_pmtiles_first_tile__) {
      w.__rentseeker_pmtiles_first_tile__ = true
      try { window.dispatchEvent(new CustomEvent('rentseeker:pmtiles:first-tile')) } catch { /* ignore */ }
    }
    return { data: buf }
  })
  w.__rentseeker_pmtiles_protocol__ = true
}

function getMapLibreProtocol(): boolean {
  try {
    return typeof (maplibregl as any).getProtocol === 'function'
  } catch {
    return false
  }
}

/* ═══════════════════════════════════════════════════════════
   FORMATTERS
   ═══════════════════════════════════════════════════════════ */

function formatCurrency(value: number): string {
  if (value === 0) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0
  }).format(value)
}
function formatNumber(value: number): string {
  if (value === 0) return '—'
  return new Intl.NumberFormat('en-US').format(value)
}
function formatAddress(parcel: ParcelRecord): string {
  if (parcel.propertyLocation?.trim()) return parcel.propertyLocation
  const parts = [
    parcel.addressHouseNumber, parcel.addressHouseNumberFraction,
    parcel.direction, parcel.street,
    parcel.unitNumber ? `#${parcel.unitNumber}` : '', parcel.city
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : 'No address on record'
}
function formatCoord(val: number | null): string {
  if (val == null) return '—'
  return val.toFixed(6)
}
function formatCompact(value: number): string {
  if (!value) return '—'
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: value >= 1000000 ? 1 : 0
  }).format(value)
}
function normalizeParcelDisplay(assessorId: string): string {
  return assessorId.replace(/-/g, ' ')
}

function formatMatchKey(parcel: ParcelRecord): string {
  return normalizeAin(parcel.ain || parcel.assessorId)
}

function parcelRecordKeys(parcel: ParcelRecord): string[] {
  return [...new Set([
    parcel.ain,
    parcel.assessorId,
    parcel.assessorId?.replace(/[^0-9]/g, '')
  ].filter(Boolean))]
}

function parcelPolygonKeys(parcel: ParcelPolygon): string[] {
  return [...new Set([
    parcel.ain,
    parcel.apn,
    parcel.apn?.replace(/[^0-9]/g, '')
  ].filter(Boolean))]
}

function mergeParcelIntoResult(result: ParcelQueryResult | null, parcel: ParcelRecord): ParcelQueryResult | null {
  if (!result) return result
  const alreadyPresent = result.allParcels.some(item => item.assessorId === parcel.assessorId)
  if (alreadyPresent) return result
  return {
    ...result,
    allParcels: [parcel, ...result.allParcels],
    surroundingParcels: [parcel, ...result.surroundingParcels],
    returnedCount: (result.returnedCount ?? result.allParcels.length) + 1
  }
}

function parcelVisualSource(parcel: ParcelRecord): string {
  const sources = new Set(parcel.dataSources ?? [])
  if (parcel.dataSource === 'both' || sources.has('cofo')) return 'cofo'
  if (sources.has('building_permit')) return 'building'
  if (sources.has('electrical_permit')) return 'electrical'
  if (sources.has('building_permit_submitted')) return 'submitted'
  if (sources.has('inspection')) return 'inspection'
  return parcel.dataSource ?? 'parcel'
}

function lineGeometryForPolygon(geometry: Geometry, streetClearEdges: boolean): Geometry {
  if (!streetClearEdges) return geometry

  const ringToLine = (ring: number[][]): number[][] => {
    if (ring.length <= 3) return ring
    let longestIndex = -1
    let longestDistance = -1
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = ring[i]
      const [x2, y2] = ring[i + 1]
      const distance = Math.hypot(x2 - x1, y2 - y1)
      if (distance > longestDistance) {
        longestDistance = distance
        longestIndex = i
      }
    }
    return ring.filter((_, index) => index !== longestIndex + 1)
  }

  if (geometry.type === 'Polygon') {
    return {
      type: 'MultiLineString',
      coordinates: geometry.coordinates.map(ring => ringToLine(ring as number[][]))
    }
  }
  if (geometry.type === 'MultiPolygon') {
    return {
      type: 'MultiLineString',
      coordinates: geometry.coordinates.flatMap(poly => poly.map(ring => ringToLine(ring as number[][])))
    }
  }
  return geometry
}

/* ═══════════════════════════════════════════════════════════
   FILTER BAR
   ═══════════════════════════════════════════════════════════ */

interface FilterBarProps {
  filter: ParcelFilterQuery
  onFilterChange: (filter: ParcelFilterQuery) => void
  onDrawBoundary: () => void
  isDrawing: boolean
  resultCount: number
  queryTimeMs: number
}

function FilterBar({ filter, onFilterChange, onDrawBoundary, isDrawing, resultCount, queryTimeMs }: FilterBarProps) {
  const [localApn, setLocalApn] = useState(filter.apnPrefix ?? '')
  const [localSearch, setLocalSearch] = useState(filter.searchText ?? '')
  const [localValueMin, setLocalValueMin] = useState(filter.valueMin?.toString() ?? '')
  const [localValueMax, setLocalValueMax] = useState(filter.valueMax?.toString() ?? '')

  const applyFilter = useCallback((patch: Partial<ParcelFilterQuery>) => {
    onFilterChange({ ...filter, ...patch })
  }, [filter, onFilterChange])

  return (
    <div className="pe-filter-bar">
      <div className="pe-filter-section">
        {/* APN Prefix */}
        <div className="pe-filter-group">
          <label className="pe-filter-label">APN BOOK</label>
          <input
            className="pe-filter-input small"
            placeholder="5560"
            maxLength={4}
            value={localApn}
            onChange={e => setLocalApn(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && applyFilter({ apnPrefix: localApn || undefined })}
            onBlur={() => applyFilter({ apnPrefix: localApn || undefined })}
          />
        </div>

        {/* Free text */}
        <div className="pe-filter-group wide">
          <label className="pe-filter-label">SEARCH</label>
          <input
            className="pe-filter-input"
            placeholder="Address, APN, legal desc…"
            value={localSearch}
            onChange={e => setLocalSearch(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && applyFilter({ searchText: localSearch || undefined })}
            onBlur={() => applyFilter({ searchText: localSearch || undefined })}
          />
        </div>

        {/* Value Range */}
        <div className="pe-filter-group">
          <label className="pe-filter-label">MIN VALUE</label>
          <input
            className="pe-filter-input small"
            placeholder="$0"
            value={localValueMin}
            onChange={e => setLocalValueMin(e.target.value.replace(/[^0-9]/g, ''))}
            onKeyDown={e => e.key === 'Enter' && applyFilter({ valueMin: localValueMin ? Number(localValueMin) : undefined })}
            onBlur={() => applyFilter({ valueMin: localValueMin ? Number(localValueMin) : undefined })}
          />
        </div>
        <div className="pe-filter-group">
          <label className="pe-filter-label">MAX VALUE</label>
          <input
            className="pe-filter-input small"
            placeholder="∞"
            value={localValueMax}
            onChange={e => setLocalValueMax(e.target.value.replace(/[^0-9]/g, ''))}
            onKeyDown={e => e.key === 'Enter' && applyFilter({ valueMax: localValueMax ? Number(localValueMax) : undefined })}
            onBlur={() => applyFilter({ valueMax: localValueMax ? Number(localValueMax) : undefined })}
          />
        </div>

        {/* C-of-O Toggle */}
        <div className="pe-filter-group">
          <label className="pe-filter-label">C-of-O</label>
          <button
            className={`pe-filter-toggle ${filter.hasCofO ? 'active' : ''}`}
            onClick={() => applyFilter({ hasCofO: !filter.hasCofO })}
          >
            {filter.hasCofO ? 'YES' : 'ALL'}
          </button>
        </div>

        {/* Use Type */}
        <div className="pe-filter-group">
          <label className="pe-filter-label">USE TYPE</label>
          <select
            className="pe-filter-select"
            value={filter.useType ?? ''}
            onChange={e => applyFilter({ useType: e.target.value || undefined })}
          >
            <option value="">All</option>
            <option value="SFR">SFR</option>
            <option value="Commercial">Commercial</option>
            <option value="Multi-Family Residence">Multi-Family</option>
            <option value="Condominium">Condo</option>
            <option value="Vacant">Vacant</option>
            <option value="Industrial">Industrial</option>
          </select>
        </div>

        {/* Sort */}
        <div className="pe-filter-group">
          <label className="pe-filter-label">SORT BY</label>
          <select
            className="pe-filter-select"
            value={filter.sortField ?? 'assessorId'}
            onChange={e => applyFilter({ sortField: e.target.value })}
          >
            <option value="assessorId">APN</option>
            <option value="totalValue">Total Value</option>
            <option value="squareFootage">SQFT</option>
            <option value="yearBuilt">Year Built</option>
            <option value="taxableValue">Taxable</option>
            <option value="landValue">Land Value</option>
          </select>
          <button
            className="pe-filter-sort-dir"
            onClick={() => applyFilter({ sortDir: filter.sortDir === 'desc' ? 'asc' : 'desc' })}
            title={filter.sortDir === 'desc' ? 'Descending' : 'Ascending'}
          >
            {filter.sortDir === 'desc' ? '↓' : '↑'}
          </button>
        </div>

        {/* Draw Boundary */}
        <button
          className={`pe-filter-draw-btn ${isDrawing ? 'active' : ''}`}
          onClick={onDrawBoundary}
        >
          {isDrawing ? '✕ CANCEL' : '◻ SELECT AREA'}
        </button>
      </div>

      {/* Active filter pills */}
      <div className="pe-filter-pills">
        {filter.apnPrefix && (
          <span className="pe-pill">Book: {filter.apnPrefix} <button onClick={() => { setLocalApn(''); applyFilter({ apnPrefix: undefined }) }}>×</button></span>
        )}
        {filter.valueMin != null && (
          <span className="pe-pill">≥ {formatCurrency(filter.valueMin)} <button onClick={() => { setLocalValueMin(''); applyFilter({ valueMin: undefined }) }}>×</button></span>
        )}
        {filter.valueMax != null && (
          <span className="pe-pill">≤ {formatCurrency(filter.valueMax)} <button onClick={() => { setLocalValueMax(''); applyFilter({ valueMax: undefined }) }}>×</button></span>
        )}
        {filter.hasCofO && (
          <span className="pe-pill cofo">C-of-O Only <button onClick={() => applyFilter({ hasCofO: false })}>×</button></span>
        )}
        {filter.useType && (
          <span className="pe-pill">{filter.useType} <button onClick={() => applyFilter({ useType: undefined })}>×</button></span>
        )}
        {filter.searchText && (
          <span className="pe-pill">"{filter.searchText}" <button onClick={() => { setLocalSearch(''); applyFilter({ searchText: undefined }) }}>×</button></span>
        )}
        {filter.bounds && (
          <span className="pe-pill boundary">Boundary Active <button onClick={() => applyFilter({ bounds: undefined })}>×</button></span>
        )}
        <span className="pe-filter-result-count">
          {resultCount.toLocaleString()} matched records · {queryTimeMs}ms
        </span>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════
   DATASET LEGEND
   ═══════════════════════════════════════════════════════════ */

interface DatasetLegendProps {
  showCofO: boolean
  onToggleCofO: (v: boolean) => void
  showBuilding: boolean
  onToggleBuilding: (v: boolean) => void
  showElectrical: boolean
  onToggleElectrical: (v: boolean) => void
  showSubmitted: boolean
  onToggleSubmitted: (v: boolean) => void
  showInspections: boolean
  onToggleInspections: (v: boolean) => void
  showPolygons: boolean
  onTogglePolygons: (v: boolean) => void
  parcelCount: number
  ownerCount: number
  cofOCount: number
  bothCount: number
  buildingPermitCount: number
  electricalPermitCount: number
  submittedPermitCount: number
  inspectionCount: number
  datasetTotals: Record<string, number>
  manifestSteps: DataLoadStep[]
}

interface FactSourceManifestProps {
  entries: ParcelFactSourceManifestEntry[]
}

function DatasetLegend({
  showCofO,
  onToggleCofO,
  showBuilding,
  onToggleBuilding,
  showElectrical,
  onToggleElectrical,
  showSubmitted,
  onToggleSubmitted,
  showInspections,
  onToggleInspections,
  showPolygons,
  onTogglePolygons,
  parcelCount,
  ownerCount,
  cofOCount,
  bothCount,
  buildingPermitCount,
  electricalPermitCount,
  submittedPermitCount,
  inspectionCount,
  datasetTotals,
  manifestSteps
}: DatasetLegendProps) {
  const sampled = (count: number, totalKey: string, fallbackKey?: string) => {
    const total = datasetTotals[totalKey] ?? (fallbackKey ? datasetTotals[fallbackKey] : 0) ?? 0
    return total ? `${count.toLocaleString()} / ${formatCompact(total)}` : count.toLocaleString()
  }

  const rowForDataset = (name: string): { countText: string; toggle?: { checked: boolean; onChange: (v: boolean) => void } } => {
    const lower = name.toLowerCase()
    if (lower.includes('certificate of occupancy')) {
      return { countText: sampled(cofOCount, name), toggle: { checked: showCofO, onChange: onToggleCofO } }
    }
    if (lower.includes('building permits submitted')) {
      return { countText: sampled(submittedPermitCount, name), toggle: { checked: showSubmitted, onChange: onToggleSubmitted } }
    }
    if (lower.includes('building permits')) {
      return { countText: sampled(buildingPermitCount, name), toggle: { checked: showBuilding, onChange: onToggleBuilding } }
    }
    if (lower.includes('electrical permits')) {
      return { countText: sampled(electricalPermitCount, name), toggle: { checked: showElectrical, onChange: onToggleElectrical } }
    }
    if (lower.includes('inspections')) {
      return { countText: sampled(inspectionCount, name), toggle: { checked: showInspections, onChange: onToggleInspections } }
    }
    if (lower.includes('secured basic file') || lower.includes('(sbf)')) {
      return { countText: sampled(ownerCount, name, 'Owner Records (SBF)') }
    }
    if (lower.includes('assessor parcels')) {
      return { countText: sampled(parcelCount, name) }
    }
    if (lower.includes('parcel boundary') || lower.includes('pmtiles')) {
      const total = datasetTotals[name] ?? datasetTotals['Parcel Boundary Lines'] ?? datasetTotals['Parcel Polygons'] ?? 0
      return { countText: formatCompact(total), toggle: { checked: showPolygons, onChange: onTogglePolygons } }
    }
    const total = datasetTotals[name] ?? 0
    return { countText: total ? formatCompact(total) : '—' }
  }

  return (
    <div className="pe-legend">
      <div className="pe-legend-title">DATASETS</div>
      {manifestSteps.map((step) => {
        const info = rowForDataset(step.datasetName)
        return (
          <div key={step.datasetName} className="pe-legend-row">
            <div className="pe-legend-dot" style={{ background: step.color || DATASET_COLORS.parcel }} />
            <span>{step.datasetName}</span>
            {info.toggle && (
              <label className="pe-legend-toggle">
                <input type="checkbox" checked={info.toggle.checked} onChange={e => info.toggle!.onChange(e.target.checked)} />
                <span className="pe-legend-toggle-track" />
              </label>
            )}
            <span className="pe-legend-count">{info.countText}</span>
          </div>
        )
      })}
      <div className="pe-legend-row">
        <div className="pe-legend-dot" style={{ background: DATASET_COLORS.both }} />
        <span>Cross-Referenced</span>
        <span className="pe-legend-count">{bothCount}</span>
      </div>
    </div>
  )
}

function FactSourceManifestPanel({ entries }: FactSourceManifestProps) {
  const grouped = useMemo(() => {
    const buckets = new Map<string, ParcelFactSourceManifestEntry[]>()
    for (const entry of entries) {
      const key = entry.sourceType
      const list = buckets.get(key) ?? []
      list.push(entry)
      buckets.set(key, list)
    }
    return [...buckets.entries()].map(([sourceType, items]) => ({
      sourceType,
      items: items.slice().sort((a, b) => a.factLabel.localeCompare(b.factLabel))
    }))
  }, [entries])

  if (entries.length === 0) return null

  return (
    <div className="pe-manifest">
      <div className="pe-manifest-title">FACT SOURCES</div>
      <div className="pe-manifest-summary">
        {entries.length.toLocaleString()} provenance rules · registry-backed
      </div>
      <div className="pe-manifest-groups">
        {grouped.map(({ sourceType, items }) => (
          <div key={sourceType} className="pe-manifest-group">
            <div className="pe-manifest-group-title">{sourceType}</div>
            {items.map((entry) => (
              <div key={entry.factLabel} className="pe-manifest-row">
                <div className="pe-manifest-row-head">
                  <span className="pe-manifest-label">{entry.factLabel}</span>
                  <span className="pe-manifest-confidence">{entry.confidence}</span>
                </div>
                <div className="pe-manifest-meta">
                  <span>{entry.datasetCandidates.join(' · ')}</span>
                  <span>{entry.sourceFields.join(' · ')}</span>
                  <span>{entry.normalizations.join(' · ')}</span>
                </div>
                {entry.notes && <div className="pe-manifest-note">{entry.notes}</div>}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

function EmptyWorkspacePanel({
  importingData,
  onChooseSources,
  onLoadDefault
}: {
  importingData: boolean
  onChooseSources: () => void
  onLoadDefault: () => void
}) {
  return (
    <div className="pe-empty-state">
      <div className="pe-empty-shell">
        <div className="pe-empty-kicker">Workspace Empty</div>
        <h2>Load your own data before parcel assembly starts.</h2>
        <p>
          Start with no records, import selected folders, then run the map and dossier flow against only those sources.
        </p>
        <div className="pe-empty-actions">
          <button className="pe-empty-primary" onClick={onChooseSources} disabled={importingData}>
            {importingData ? 'Importing…' : 'Load Your Data'}
          </button>
          <button className="pe-empty-secondary" onClick={onLoadDefault} disabled={importingData}>
            Load Default Stack
          </button>
        </div>
        <div className="pe-empty-note">
          Drag folders into the window or use the `FOLDER` control in the header after startup.
        </div>
      </div>
    </div>
  )
}

function VisualSettingsMenu({
  settings,
  onChange,
  onClose,
  pmtilesInfo,
  pmtilesSourceLayer,
  pmtilesReady,
  sourceBlobStats
}: {
  settings: VisualSettings
  onChange: (settings: VisualSettings) => void
  onClose: () => void
  pmtilesInfo: ParcelPmtilesInfo | null
  pmtilesSourceLayer: string
  pmtilesReady: boolean
  sourceBlobStats: ParcelSourceBlobStats | null
}) {
  const patch = (next: Partial<VisualSettings>) => onChange({ ...settings, ...next })
  return (
    <div className="pe-visual-menu">
      <div className="pe-visual-menu-head">
        <span>Visual Settings</span>
        <button onClick={onClose}>×</button>
      </div>
      <label className="pe-visual-row">
        <input type="checkbox" checked={settings.showDots} onChange={event => patch({ showDots: event.target.checked })} />
        <span>Parcel dots</span>
      </label>
      <label className="pe-visual-row">
        <input type="checkbox" checked={settings.showPolygonFill} onChange={event => patch({ showPolygonFill: event.target.checked })} />
        <span>Boundary fill</span>
      </label>
      <label className="pe-visual-row">
        <input type="checkbox" checked={settings.streetClearEdges} onChange={event => patch({ streetClearEdges: event.target.checked })} />
        <span>Soften street-facing edge</span>
      </label>
      <label className="pe-visual-row">
        <input type="checkbox" checked={settings.datasetColorDots} onChange={event => patch({ datasetColorDots: event.target.checked })} />
        <span>Dataset colors on dots</span>
      </label>
      <label className="pe-visual-row">
        <input type="checkbox" checked={settings.showTopoOverlay} onChange={event => patch({ showTopoOverlay: event.target.checked })} />
        <span>Topographic overlay</span>
      </label>
      <label className="pe-visual-row">
        <input type="checkbox" checked={settings.showHeatOverlay} onChange={event => patch({ showHeatOverlay: event.target.checked })} />
        <span>Owner heat overlay</span>
      </label>
      <label className="pe-visual-row">
        <input type="checkbox" checked={settings.showPmtilesInspector} onChange={event => patch({ showPmtilesInspector: event.target.checked })} />
        <span>PMTiles inspector</span>
      </label>
      <label className="pe-visual-slider">
        <span>Boundary strength</span>
        <input
          type="range"
          min="0.5"
          max="3"
          step="0.25"
          value={settings.lineStrength}
          onChange={event => patch({ lineStrength: Number(event.target.value) })}
        />
      </label>

      {settings.showPmtilesInspector && (
        <div className="pe-pmtiles-inspector">
          <div className="pe-pmtiles-row">
            <span className="k">Status</span>
            <span className="v">{pmtilesReady ? 'Ready' : 'Not ready'}</span>
          </div>
          <div className="pe-pmtiles-row">
            <span className="k">Source-layer</span>
            <span className="v">{pmtilesSourceLayer || '—'}</span>
          </div>
          <div className="pe-pmtiles-row">
            <span className="k">Source blob cache</span>
            <span className="v">
              {sourceBlobStats?.blobs ? `${sourceBlobStats.blobs.toLocaleString()} blobs` : 'empty'}
            </span>
          </div>
          {sourceBlobStats?.totalBytes != null && (
            <div className="pe-pmtiles-row">
              <span className="k">Blob bytes</span>
              <span className="v">{formatCompact(sourceBlobStats.totalBytes)}</span>
            </div>
          )}
          {sourceBlobStats?.latestAt && (
            <div className="pe-pmtiles-row">
              <span className="k">Blob updated</span>
              <span className="v">{new Date(sourceBlobStats.latestAt).toLocaleTimeString()}</span>
            </div>
          )}
          {!pmtilesInfo && (
            <div className="pe-pmtiles-hint">PMTiles info not loaded.</div>
          )}
          {pmtilesInfo && !pmtilesInfo.ok && (
            <div className="pe-pmtiles-error">{pmtilesInfo.error ?? 'PMTiles unavailable'}</div>
          )}
          {pmtilesInfo?.ok && (
            <>
              <div className="pe-pmtiles-row">
                <span className="k">Zoom</span>
                <span className="v">{pmtilesInfo.minZoom ?? '—'}–{pmtilesInfo.maxZoom ?? '—'}</span>
              </div>
              <div className="pe-pmtiles-layers">
                {(pmtilesInfo.vectorLayers ?? []).map((layer) => (
                  <div key={layer.id} className="pe-pmtiles-layer">
                    <div className="pe-pmtiles-layer-id">{layer.id}</div>
                    <div className="pe-pmtiles-fields">
                      {Object.keys(layer.fields ?? {}).length === 0
                        ? <span className="pe-pmtiles-field dim">No fields</span>
                        : Object.entries(layer.fields).slice(0, 18).map(([k, v]) => (
                          <span key={k} className="pe-pmtiles-field">{k}:{String(v)}</span>
                        ))}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════
   COMPACT PARCEL CARD
   ═══════════════════════════════════════════════════════════ */

interface ParcelCardProps {
  parcel: ParcelRecord
  isTarget: boolean
  isSelected: boolean
  isOwnerParcel: boolean
  index: number
  maxTotalValue: number
  onSelect: (parcel: ParcelRecord) => void
  onMouseEnter: () => void
  onMouseLeave: () => void
}

function ParcelCard({
  parcel, isTarget, isSelected, index, maxTotalValue,
  isOwnerParcel,
  onSelect, onMouseEnter, onMouseLeave
}: ParcelCardProps) {
  const className = [
    'pe-card',
    isTarget ? 'target' : '',
    isSelected ? 'selected' : '',
    isOwnerParcel ? 'owner-parcel' : '',
    parcel.dataSource === 'both' ? 'has-cofo' : ''
  ].filter(Boolean).join(' ')

  const valueRatio = maxTotalValue > 0 ? parcel.totalValue / maxTotalValue : 0
  const borderColor = isOwnerParcel ? DATASET_COLORS.sbf
    : isTarget ? DATASET_COLORS.target
    : parcel.dataSource === 'both' ? DATASET_COLORS.both
    : parcel.dataSource === 'cofo' ? DATASET_COLORS.cofo
    : DATASET_COLORS.parcel

  return (
    <div
      className={className}
      style={{ animationDelay: `${Math.min(index * 20, 800)}ms`, borderLeftColor: borderColor }}
      onClick={() => onSelect(parcel)}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="pe-card-topline">
        <div className="pe-card-id">{normalizeParcelDisplay(parcel.assessorId)}</div>
        <div className="pe-card-badges">
          {isTarget && <div className="pe-card-badge target-badge">TARGET</div>}
          {isOwnerParcel && <div className="pe-card-badge owner-badge">OWNER</div>}
          {parcel.dataSource === 'both' && <div className="pe-card-badge cofo-badge">C-of-O</div>}
          {!isTarget && parcel.dataSource !== 'both' && <div className="pe-card-badge node">NODE</div>}
        </div>
      </div>

      <div className="pe-card-address">{formatAddress(parcel)}</div>

      {parcel.propertyUseType && (
        <div className="pe-card-use-type">
          {parcel.propertyUseType}
          {parcel.useCode3 ? ` · ${parcel.useCode3}` : ''}
        </div>
      )}

      <div className="pe-card-body">
        <div className="pe-data-row">
          <span className="pe-data-label">Value</span>
          <span className="pe-data-value currency">{formatCurrency(parcel.totalValue)}</span>
        </div>
        <div className="pe-data-row">
          <span className="pe-data-label">SQFT</span>
          <span className="pe-data-value">{formatNumber(parcel.squareFootage)}</span>
        </div>
        <div className="pe-data-row">
          <span className="pe-data-label">Bed/Bath</span>
          <span className="pe-data-value">
            {parcel.numberOfBedrooms || '—'} / {parcel.numberOfBathrooms || '—'}
          </span>
        </div>
        {parcel.cofoStatus && (
          <div className="pe-data-row">
            <span className="pe-data-label cofo">C-of-O</span>
            <span className="pe-data-value cofo-val">{parcel.cofoStatus}</span>
          </div>
        )}
        <div className="pe-value-bar-bg">
          <div
            className="pe-value-bar-fill amber"
            style={{ transform: `scaleX(${valueRatio})` }}
          />
        </div>
      </div>

      <div className="pe-card-footer">
        <span>{formatCoord(parcel.latitude)}, {formatCoord(parcel.longitude)}</span>
        <span>AIN {parcel.ain || '—'}</span>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════
   DOSSIER SIDEBAR
   ═══════════════════════════════════════════════════════════ */

function DossierPanel({
  parcel,
  onSelectOwner,
  dossierProvenance
}: {
  parcel: ParcelRecord | null
  onSelectOwner: (ownerName: string) => void
  dossierProvenance: ParcelDossierProvenance | null
}) {
  if (!parcel) {
    return (
      <aside className="pe-dossier">
        <div className="pe-dossier-empty">
          <div className="pe-dossier-empty-icon">⌘</div>
          <h3>Parcel Dossier</h3>
          <p>
            Click any parcel boundary, marker, or bottom card to load
            its full dossier. Cross-referenced data
            from all active datasets is shown automatically.
          </p>
        </div>
      </aside>
    )
  }

  const Fact = ({ label, value, isCurrency }: { label: string; value: string; isCurrency?: boolean }) => (
    <DossierFact
      label={label}
      value={value}
      isCurrency={isCurrency}
      provenance={dossierProvenance?.facts?.[label] ?? null}
    />
  )

  return (
    <aside className="pe-dossier">
      <div className="pe-dossier-content" key={parcel.assessorId}>
        {/* Header */}
        <div className="pe-dossier-header">
          <div className="pe-dossier-kicker">Full Dossier</div>
          <h2 className="pe-dossier-title">{normalizeParcelDisplay(parcel.assessorId)}</h2>
          <div className="pe-dossier-subtitle">{formatAddress(parcel)}</div>
          <div className="pe-dossier-source-badge" data-source={parcel.dataSource}>
            {parcel.dataSource === 'both' ? 'PARCEL + C-of-O' : parcel.dataSource === 'cofo' ? 'C-of-O ONLY' : 'PARCEL DATA'}
          </div>
        </div>

        <OwnerPanel ain={parcel.ain || parcel.assessorId} onSelectOwner={onSelectOwner} provenance={dossierProvenance?.owner ?? null} />

        {/* Summary */}
        <div className="pe-dossier-summary-grid">
          <div className="pe-dossier-summary-card amber">
            <span>Total Value</span>
            <strong>{formatCurrency(parcel.totalValue)}</strong>
          </div>
          <div className="pe-dossier-summary-card accent">
            <span>Taxable</span>
            <strong>{formatCurrency(parcel.taxableValue)}</strong>
          </div>
          <div className="pe-dossier-summary-card">
            <span>SQFT</span>
            <strong>{formatNumber(parcel.squareFootage)}</strong>
          </div>
          <div className="pe-dossier-summary-card">
            <span>Year Built</span>
            <strong>{parcel.yearBuilt || '—'}</strong>
          </div>
        </div>

        {/* Certificate of Occupancy (if available) */}
        {parcel.dataSource === 'both' && (
          <div className="pe-dossier-section cofo-section">
            <div className="pe-dossier-section-title cofo">Certificate of Occupancy</div>
            <Fact label="CofO Number" value={parcel.cofoNumber ?? ''} />
            <Fact label="Issue Date" value={parcel.cofoIssueDate ?? ''} />
            <Fact label="Status" value={parcel.cofoStatus ?? ''} />
            <Fact label="Permit Type" value={parcel.permitType ?? ''} />
            <Fact label="Sub-Type" value={parcel.permitSubType ?? ''} />
            <Fact label="Work Description" value={parcel.workDescription ?? ''} />
            <Fact label="Valuation" value={parcel.cofoValuation ?? ''} isCurrency />
            <Fact label="Zone" value={parcel.cofoZone ?? ''} />
            <Fact label="Stories" value={parcel.numberOfStories ?? ''} />
            <Fact label="Contractor" value={parcel.contractorName ?? ''} />
          </div>
        )}

        {(parcel.buildingPermitCount || parcel.electricalPermitCount || parcel.submittedBuildingPermitCount || parcel.inspectionCount) && (
          <div className="pe-dossier-section">
            <div className="pe-dossier-section-title">Permit Cross-References</div>
            <Fact label="Building Permits" value={String(parcel.buildingPermitCount ?? 0)} />
            <Fact label="Building Valuation" value={formatCurrency(parcel.buildingPermitValuation ?? 0)} isCurrency />
            <Fact label="Latest Building Permit" value={parcel.latestBuildingPermit ?? ''} />
            <Fact label="Building Status" value={parcel.latestBuildingPermitStatus ?? ''} />
            <Fact label="Building Work" value={parcel.latestBuildingPermitDescription ?? ''} />
            <Fact label="Electrical Permits" value={String(parcel.electricalPermitCount ?? 0)} />
            <Fact label="Latest Electrical Permit" value={parcel.latestElectricalPermit ?? ''} />
            <Fact label="Electrical Status" value={parcel.latestElectricalPermitStatus ?? ''} />
            <Fact label="Electrical Work" value={parcel.latestElectricalPermitDescription ?? ''} />
            <Fact label="Submitted Building Permits" value={String(parcel.submittedBuildingPermitCount ?? 0)} />
            <Fact label="Latest Submitted Permit" value={parcel.latestSubmittedBuildingPermit ?? ''} />
            <Fact label="Submitted Status" value={parcel.latestSubmittedBuildingPermitStatus ?? ''} />
            <Fact label="Submitted Work" value={parcel.latestSubmittedBuildingPermitDescription ?? ''} />
            <Fact label="Inspections" value={String(parcel.inspectionCount ?? 0)} />
            <Fact label="Latest Inspection" value={parcel.latestInspection ?? ''} />
            <Fact label="Inspection Result" value={parcel.latestInspectionStatus ?? ''} />
            <Fact label="Inspection Type" value={parcel.latestInspectionDescription ?? ''} />
          </div>
        )}

        {/* Identity */}
        <div className="pe-dossier-section">
          <div className="pe-dossier-section-title">Identity</div>
          <Fact label="Assessor ID" value={parcel.assessorId} />
          <Fact label="AIN" value={parcel.ain} />
          <Fact label="Roll Year" value={String(parcel.rollYear)} />
          <Fact label="Row ID" value={parcel.rowId} />
          <Fact label="Object ID" value={parcel.objectId} />
        </div>

        {/* Location */}
        <div className="pe-dossier-section">
          <div className="pe-dossier-section-title">Location</div>
          <Fact label="Property Location" value={parcel.propertyLocation} />
          <Fact label="House #" value={parcel.addressHouseNumber} />
          <Fact label="Direction" value={parcel.direction} />
          <Fact label="Street" value={parcel.street} />
          <Fact label="Unit #" value={parcel.unitNumber} />
          <Fact label="City" value={parcel.city} />
          <Fact label="Zip Code" value={parcel.zipCodeFull || parcel.zipCode} />
          <Fact label="Latitude" value={formatCoord(parcel.latitude)} />
          <Fact label="Longitude" value={formatCoord(parcel.longitude)} />
        </div>

        {/* Use Classification */}
        <div className="pe-dossier-section">
          <div className="pe-dossier-section-title">Use Classification</div>
          <Fact label="Use Type" value={parcel.propertyUseType} />
          <Fact label="Use Code" value={parcel.propertyUseCode} />
          <Fact label="1st Digit" value={parcel.useCode1} />
          <Fact label="2nd Digit" value={parcel.useCode2} />
          <Fact label="3rd Digit" value={parcel.useCode3} />
          <Fact label="4th Digit" value={parcel.useCode4} />
        </div>

        <div className="pe-dossier-section">
          <div className="pe-dossier-section-title">SB 79 Screening</div>
          <Fact label="Eligible" value={parcel.sb79Eligible == null ? '' : parcel.sb79Eligible ? 'Yes' : 'No'} />
          <Fact label="Tier" value={parcel.sb79Tier ?? ''} />
          <Fact label="Nearest Transit Distance" value={parcel.sb79DistanceToStopFt ? `${parcel.sb79DistanceToStopFt.toLocaleString()} ft` : ''} />
        </div>

        {/* Structure */}
        <div className="pe-dossier-section">
          <div className="pe-dossier-section-title">Structure</div>
          <Fact label="# Buildings" value={String(parcel.numberOfBuildings)} />
          <Fact label="Year Built" value={String(parcel.yearBuilt)} />
          <Fact label="Effective Year" value={String(parcel.effectiveYear)} />
          <Fact label="Square Footage" value={formatNumber(parcel.squareFootage)} />
          <Fact label="Bedrooms" value={String(parcel.numberOfBedrooms)} />
          <Fact label="Bathrooms" value={String(parcel.numberOfBathrooms)} />
          <Fact label="Units" value={String(parcel.numberOfUnits)} />
        </div>

        {/* Valuation */}
        <div className="pe-dossier-section">
          <div className="pe-dossier-section-title">Valuation</div>
          <Fact label="Land Value" value={formatCurrency(parcel.landValue)} isCurrency />
          <Fact label="Land Base Year" value={String(parcel.landBaseYear)} />
          <Fact label="Improvement Value" value={formatCurrency(parcel.improvementValue)} isCurrency />
          <Fact label="Improvement Base Yr" value={String(parcel.improvementBaseYear)} />
          <Fact label="Land+Improvement" value={formatCurrency(parcel.totalValueLandImprovement)} isCurrency />
        </div>

        {/* Exemptions */}
        <div className="pe-dossier-section">
          <div className="pe-dossier-section-title">Exemptions</div>
          <Fact label="Homeowner Exempt" value={formatCurrency(parcel.homeOwnersExemption)} isCurrency />
          <Fact label="Real Estate Exempt" value={formatCurrency(parcel.realEstateExemption)} isCurrency />
          <Fact label="Fixture Value" value={formatCurrency(parcel.fixtureValue)} isCurrency />
          <Fact label="Fixture Exempt" value={formatCurrency(parcel.fixtureExemption)} isCurrency />
          <Fact label="Personal Prop Val" value={formatCurrency(parcel.personalPropertyValue)} isCurrency />
          <Fact label="Personal Prop Exempt" value={formatCurrency(parcel.personalPropertyExemption)} isCurrency />
        </div>

        {/* Tax Roll */}
        <div className="pe-dossier-section">
          <div className="pe-dossier-section-title">Tax Roll</div>
          <Fact label="Property Taxable?" value={parcel.propertyTaxable} />
          <Fact label="Total Value" value={formatCurrency(parcel.totalValue)} isCurrency />
          <Fact label="Total Exemption" value={formatCurrency(parcel.totalExemption)} isCurrency />
          <Fact label="Taxable Value" value={formatCurrency(parcel.taxableValue)} isCurrency />
          <Fact label="Recording Date" value={parcel.recordingDate} />
        </div>

        {/* Administrative */}
        <div className="pe-dossier-section">
          <div className="pe-dossier-section-title">Administrative</div>
          <Fact label="City Tax Rate Area" value={parcel.cityTaxRateArea} />
          <Fact label="Tax Rate Area Code" value={parcel.taxRateAreaCode} />
          <Fact label="Classification" value={parcel.classification} />
          <Fact label="Region #" value={parcel.regionNumber} />
          <Fact label="Cluster Code" value={parcel.clusterCode} />
          <Fact label="Legal Description" value={parcel.parcelLegalDescription} />
        </div>
      </div>
    </aside>
  )
}

function DossierFact({
  label,
  value,
  isCurrency,
  provenance
}: {
  label: string
  value: string
  isCurrency?: boolean
  provenance?: ParcelFactProvenance | null
}) {
  const [open, setOpen] = useState(false)
  const displayValue = value === '0' || !value ? '—' : value
  return (
    <div className={`pe-dossier-fact ${open ? 'open' : ''}`}>
      <span className="pe-dossier-fact-key">{label}</span>
      <span className={`pe-dossier-fact-value ${isCurrency ? 'currency' : ''}`}>{displayValue}</span>
      {provenance && (
        <button
          className="pe-dossier-fact-source"
          onClick={() => setOpen(current => !current)}
          title="Show source dataset and match basis"
        >
          i
        </button>
      )}
      {open && provenance && (
        <div className="pe-dossier-provenance">
          <div><strong>Dataset</strong><span>{provenance.datasetName}</span></div>
          <div><strong>Fields</strong><span>{provenance.sourceFields.join(', ')}</span></div>
          <div><strong>Match</strong><span>{provenance.matchKey}</span></div>
          <div><strong>Normalization</strong><span>{provenance.normalizations.join(' · ')}</span></div>
          <div><strong>Confidence</strong><span>{provenance.confidence}</span></div>
          {provenance.notes && <div><strong>Notes</strong><span>{provenance.notes}</span></div>}
        </div>
      )}
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════
   CUSTOM CURSOR
   ═══════════════════════════════════════════════════════════ */

function useCustomCursor() {
  const dotRef = useRef<HTMLDivElement>(null)
  const ringRef = useRef<HTMLDivElement>(null)
  const mousePos = useRef({ x: 0, y: 0 })
  const ringPos = useRef({ x: 0, y: 0 })
  const [hovering, setHovering] = useState(false)

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      mousePos.current = { x: e.clientX, y: e.clientY }
      if (dotRef.current) {
        dotRef.current.style.transform = `translate3d(${e.clientX}px, ${e.clientY}px, 0) translate(-50%, -50%)`
      }
    }
    window.addEventListener('mousemove', onMouseMove, { passive: true })

    let raf: number
    const loop = () => {
      ringPos.current.x += (mousePos.current.x - ringPos.current.x) * 0.15
      ringPos.current.y += (mousePos.current.y - ringPos.current.y) * 0.15
      if (ringRef.current) {
        ringRef.current.style.transform = `translate3d(${ringPos.current.x}px, ${ringPos.current.y}px, 0) translate(-50%, -50%)`
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      cancelAnimationFrame(raf)
    }
  }, [])

  return { dotRef, ringRef, hovering, setHovering }
}

/* ═══════════════════════════════════════════════════════════
   MAP VIEW (GeoJSON Layer — perfectly synced markers)
   ═══════════════════════════════════════════════════════════ */

interface MapViewProps {
  parcels: ParcelRecord[]
  targetIds: string[]
  ownerAins: Set<string>
  heatCells: HeatMapCell[]
  selectedParcelIds: Set<string>
  showPolygons: boolean
  visualSettings: VisualSettings
  selectedParcel: ParcelRecord | null
  terrainMetrics: TerrainMetrics | null
  topoOverlayData: any | null
  onSelectParcel: (parcel: ParcelRecord) => void
  onSelectParcelByKey: (parcelKey: string, polygon?: ParcelPolygon | null) => void
  isDrawing: boolean
  onGroupSelect: (polygons: ParcelPolygon[], mode: ParcelSelectionMode) => void
  onViewportChange: (bounds: MapBounds) => void
  onBoundaryStats: (visibleCount: number, renderedCount: number, complete: boolean, suppressed: boolean) => void
  onBoundaryRefreshStateChange?: (state: 'idle' | 'moving' | 'settling') => void
  onMapReady?: (map: maplibregl.Map) => void
  onBasemapReady?: () => void
  onBoundariesReady?: () => void
}

function MapView({
  parcels,
  targetIds,
  ownerAins,
  heatCells,
  selectedParcelIds,
  showPolygons,
  visualSettings,
  selectedParcel,
  terrainMetrics,
  topoOverlayData,
  onSelectParcel,
  onSelectParcelByKey,
  isDrawing,
  onGroupSelect,
  onViewportChange,
  onBoundaryStats,
  onBoundaryRefreshStateChange,
  onMapReady,
  onBasemapReady,
  onBoundariesReady
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const parcelsRef = useRef<ParcelRecord[]>([])
  const drawStartRef = useRef<{ lng: number; lat: number } | null>(null)
  const drawStartScreenRef = useRef<{ x: number; y: number } | null>(null)
  const initialFitDone = useRef(false)
  const pmtilesReadyRef = useRef(false)
  const pmtilesSourceLayerRef = useRef<string>(PMTILES_VECTOR_LAYER_ID)
  const lastHoverAinRef = useRef<string | null>(null)
  const lastSelectedAinsRef = useRef<Set<string>>(new Set())
  const lastOwnerAinsRef = useRef<Set<string>>(new Set())
  const [hoveredParcelKey, setHoveredParcelKey] = useState<string | null>(null)
  const [hoverTooltip, setHoverTooltip] = useState<{ x: number; y: number; label: string; sublabel: string } | null>(null)
  const [drawBox, setDrawBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
  const onSelectParcelRef = useRef(onSelectParcel)
  const onSelectParcelByKeyRef = useRef(onSelectParcelByKey)
  const onViewportChangeRef = useRef(onViewportChange)

  // Keep a ref to parcels for click handler
  parcelsRef.current = parcels

  useEffect(() => {
    onSelectParcelRef.current = onSelectParcel
    onSelectParcelByKeyRef.current = onSelectParcelByKey
    onViewportChangeRef.current = onViewportChange
  }, [onSelectParcel, onSelectParcelByKey, onViewportChange])

  // Initialize map once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    const saved = getSavedMapState()
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE as any,
      center: saved?.center ?? SANTA_MONICA_MOUNTAINS_CENTER,
      zoom: saved?.zoom ?? DEFAULT_ZOOM,
      attributionControl: false,
      maxZoom: 18,
      minZoom: 8
    })

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left')

    map.on('load', () => {
      onBasemapReady?.()
      ensurePmtilesProtocolRegistered()
      // Add empty GeoJSON source
      map.addSource('parcels-source', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      })

      map.addSource('owner-heat-source', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      })

      map.addSource('topo-source', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      })

      const initParcelBoundaryTiles = async (attempt: number = 0) => {
        try {
          // The map can load before the preload API is attached (especially under HMR).
          // Boundaries must retry until the desktop API is ready; otherwise parcels never render.
          if (!window.rentSeeker?.getParcelPmtilesInfo || !window.rentSeeker?.getParcelPmtilesTile) {
            if (attempt === 0) console.log('[pmtiles] waiting for preload API…')
            if (attempt < 120) window.setTimeout(() => void initParcelBoundaryTiles(attempt + 1), 250)
            return
          }

          ensurePmtilesProtocolRegistered()
          const info = await window.rentSeeker.getParcelPmtilesInfo()
          if (!info.ok) {
            pmtilesReadyRef.current = false
            // If PMTiles info isn't available yet (startup race), keep retrying.
            console.warn('[pmtiles] info not ok:', info.error ?? 'unknown')
            if (attempt < 120) window.setTimeout(() => void initParcelBoundaryTiles(attempt + 1), 250)
            return
          }
          if (attempt > 0) console.log(`[pmtiles] preload ready after ${attempt} retries`)
          console.log('[pmtiles] info:', { minZoom: info.minZoom, maxZoom: info.maxZoom, layers: info.vectorLayers?.map(l => l.id) })

          // Ensure the map is within the PMTiles zoom range; otherwise tiles will never request.
          const minZ = Math.max(Number(info.minZoom ?? 0) || 0, PARCEL_BOUNDARY_RENDER_MIN_ZOOM)
          if (map.getZoom() < minZ) {
            map.setZoom(minZ)
          }

          // Prefer the expected layer id, but fall back to first vector layer.
          const sourceLayer = info.vectorLayers?.some(layer => layer.id === PMTILES_VECTOR_LAYER_ID)
            ? PMTILES_VECTOR_LAYER_ID
            : (info.vectorLayers?.[0]?.id ?? PMTILES_VECTOR_LAYER_ID)
          pmtilesSourceLayerRef.current = sourceLayer

          if (!map.getSource(PMTILES_VECTOR_SOURCE_ID)) {
            // Allow one extra zoom level in the source so fractional zoom doesn't strand tile loading.
            const srcMaxZoom = Math.min(Number(info.maxZoom ?? 22) || 22, PARCEL_BOUNDARY_RENDER_MIN_ZOOM + 1)
            const httpBase = await window.rentSeeker.getParcelPmtilesHttpBase().catch(() => null)
            const tileTemplate = httpBase
              ? `${httpBase}/{z}/{x}/{y}.pbf`
              : `pmtiles://${PMTILES_ARCHIVE_KEY}/{z}/{x}/{y}.pbf`
            map.addSource(PMTILES_VECTOR_SOURCE_ID, {
              type: 'vector',
              // Prefer HTTP-served tiles so workers can fetch them normally (more reliable in Electron).
              tiles: [tileTemplate],
              minzoom: info.minZoom,
              // Force overzoom at startup so we fetch a less expensive tile pyramid (fewer/heavier tiles at z15).
              maxzoom: srcMaxZoom,
              bounds: info.bounds,
              promoteId: 'AIN'
            } as any)
            console.log('[pmtiles] vector source added:', { maxzoom: srcMaxZoom })

            // Prewarm only the single tile under the current center. This verifies IPC/protocol wiring
            // and gets first paint faster without trying to load the whole viewport.
            try {
              const c = map.getCenter()
              const { x, y } = lngLatToTile(c.lng, c.lat, srcMaxZoom)
              void window.rentSeeker.getParcelPmtilesTile(srcMaxZoom, x, y)
            } catch {
              // ignore
            }
          }

          if (!map.getLayer(PMTILES_FILL_LAYER_ID)) {
            map.addLayer({
              id: PMTILES_FILL_LAYER_ID,
              type: 'fill',
              source: PMTILES_VECTOR_SOURCE_ID,
              'source-layer': sourceLayer,
              minzoom: PARCEL_BOUNDARY_RENDER_MIN_ZOOM,
              paint: {
                'fill-color': [
                  'case',
                  ['boolean', ['feature-state', 'selected'], false], DATASET_COLORS.target,
                  ['boolean', ['feature-state', 'hover'], false], DATASET_COLORS.selected,
                  ['boolean', ['feature-state', 'owner'], false], DATASET_COLORS.sbf,
                  DATASET_COLORS.polygon
                ],
                'fill-opacity': [
                  'case',
                  ['boolean', ['feature-state', 'selected'], false], 0.18,
                  ['boolean', ['feature-state', 'hover'], false], 0.14,
                  ['boolean', ['feature-state', 'owner'], false], 0.1,
                  visualSettings.showPolygonFill ? 0.04 : 0
                ]
              }
            } as any)
          }

          if (!map.getLayer(PMTILES_LINE_LAYER_ID)) {
            map.addLayer({
              id: PMTILES_LINE_LAYER_ID,
              type: 'line',
              source: PMTILES_VECTOR_SOURCE_ID,
              'source-layer': sourceLayer,
              minzoom: PARCEL_BOUNDARY_RENDER_MIN_ZOOM,
              paint: {
                'line-color': [
                  'case',
                  ['boolean', ['feature-state', 'selected'], false], DATASET_COLORS.selected,
                  ['boolean', ['feature-state', 'hover'], false], DATASET_COLORS.selected,
                  ['boolean', ['feature-state', 'owner'], false], DATASET_COLORS.sbf,
                  DATASET_COLORS.polygon
                ],
                'line-width': [
                  'case',
                  ['boolean', ['feature-state', 'selected'], false], visualSettings.lineStrength * 3,
                  ['boolean', ['feature-state', 'hover'], false], visualSettings.lineStrength * 2.5,
                  ['boolean', ['feature-state', 'owner'], false], visualSettings.lineStrength * 2,
                  visualSettings.lineStrength
                ],
                'line-opacity': 0.86
              }
            } as any)
          }

          pmtilesReadyRef.current = true
          // Nudge MapLibre to schedule tile work without changing zoom (overzoom edge cases are real).
          try { map.resize() } catch { /* ignore */ }
          // Mark boundary-ready after the first PMTiles tile is actually served to MapLibre.
          // `isSourceLoaded()` can be flaky with custom protocols; first-tile is a real signal.
          const markReady = () => {
            onBoundariesReady?.()
            window.removeEventListener('rentseeker:pmtiles:first-tile', markReady as any)
            map.off('sourcedata', tryMarkReady as any)
          }
          window.addEventListener('rentseeker:pmtiles:first-tile', markReady as any)
          console.log('[pmtiles] listening for first tile…')

          // Fallback: if source reports loaded, also mark ready.
          const tryMarkReady = () => {
            if (map.isSourceLoaded(PMTILES_VECTOR_SOURCE_ID)) markReady()
          }
          map.on('sourcedata', tryMarkReady as any)
        } catch {
          pmtilesReadyRef.current = false
          if (attempt < 120) window.setTimeout(() => void initParcelBoundaryTiles(attempt + 1), 250)
        }
      }

      void initParcelBoundaryTiles()

      // Kick a zero-duration moveend so boundary tile loading starts immediately
      // (important when boundary rendering is debounced to moveend).
      try {
        map.easeTo({ center: map.getCenter(), zoom: map.getZoom(), duration: 0 })
      } catch {
        // ignore
      }

      // Circle layer for normal parcels
      map.addLayer({
        id: 'parcels-circles',
        type: 'circle',
        source: 'parcels-source',
        paint: {
          'circle-radius': [
            'case',
            ['==', ['get', 'isSelected'], true], 10,
            ['==', ['get', 'isTarget'], true], 8,
            5
          ],
          'circle-color': [
            'case',
            ['==', ['get', 'isSelected'], true], '#ffffff',
            ['==', ['get', 'isOwnerParcel'], true], DATASET_COLORS.sbf,
            ['==', ['get', 'isTarget'], true], DATASET_COLORS.target,
            ['==', ['get', 'dataSource'], 'cofo'], DATASET_COLORS.cofo,
            ['==', ['get', 'dataSource'], 'building'], DATASET_COLORS.building,
            ['==', ['get', 'dataSource'], 'electrical'], DATASET_COLORS.electrical,
            ['==', ['get', 'dataSource'], 'submitted'], DATASET_COLORS.submitted,
            ['==', ['get', 'dataSource'], 'inspection'], DATASET_COLORS.inspection,
            DATASET_COLORS.parcel
          ],
          'circle-opacity': [
            'case',
            ['==', ['get', 'isSelected'], true], 1,
            ['==', ['get', 'isTarget'], true], 0.9,
            0.7
          ],
          'circle-stroke-width': [
            'case',
            ['==', ['get', 'isSelected'], true], 3,
            ['==', ['get', 'isOwnerParcel'], true], 3,
            ['==', ['get', 'isTarget'], true], 2,
            1
          ],
          'circle-stroke-color': [
            'case',
            ['==', ['get', 'isSelected'], true], DATASET_COLORS.target,
            ['==', ['get', 'isOwnerParcel'], true], DATASET_COLORS.sbf,
            ['==', ['get', 'isTarget'], true], DATASET_COLORS.target,
            'rgba(255,255,255,0.3)'
          ],
          'circle-blur': 0.1
        }
      })

      // Glow layer behind selected/target markers
      map.addLayer({
        id: 'parcels-glow',
        type: 'circle',
        source: 'parcels-source',
        filter: ['any',
          ['==', ['get', 'isSelected'], true],
          ['==', ['get', 'isOwnerParcel'], true],
          ['==', ['get', 'isTarget'], true]
        ],
        paint: {
          'circle-radius': [
            'case',
            ['==', ['get', 'isSelected'], true], 20,
            14
          ],
          'circle-color': [
            'case',
            ['==', ['get', 'isSelected'], true], DATASET_COLORS.target,
            DATASET_COLORS.target
          ],
          'circle-opacity': 0.15,
          'circle-blur': 1
        }
      }, 'parcels-circles') // Insert below circles

      map.addLayer({
        id: 'owner-heat-layer',
        type: 'heatmap',
        source: 'owner-heat-source',
        layout: { visibility: visualSettings.showHeatOverlay ? 'visible' : 'none' },
        paint: {
          'heatmap-weight': [
            'interpolate',
            ['linear'],
            ['get', 'w'],
            0, 0,
            1, 1
          ],
          'heatmap-intensity': [
            'interpolate',
            ['linear'],
            ['zoom'],
            10, 0.6,
            13, 1.0,
            15, 1.3
          ],
          'heatmap-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            10, 12,
            13, 18,
            15, 24
          ],
          'heatmap-opacity': 0.55,
          'heatmap-color': [
            'interpolate',
            ['linear'],
            ['heatmap-density'],
            0, 'rgba(0,0,0,0)',
            0.2, 'rgba(0,212,255,0.45)',
            0.45, 'rgba(171,255,2,0.55)',
            0.7, 'rgba(255,222,89,0.65)',
            1, 'rgba(255,75,75,0.75)'
          ]
        }
      } as any, 'parcels-glow')

      map.addLayer({
        id: 'topo-points-layer',
        type: 'circle',
        source: 'topo-source',
        layout: { visibility: visualSettings.showTopoOverlay ? 'visible' : 'none' },
        paint: {
          'circle-radius': [
            'interpolate', ['linear'], ['zoom'],
            10, 2,
            13, 3,
            15, 4
          ],
          'circle-color': [
            'interpolate',
            ['linear'],
            ['get', 'n'],
            0, 'rgba(0, 140, 255, 0.55)',
            0.5, 'rgba(171, 255, 2, 0.55)',
            1, 'rgba(255, 222, 89, 0.65)'
          ],
          'circle-opacity': 0.6,
          'circle-blur': 0.2
        }
      } as any, 'parcels-glow')

      // Click handler (dots)
      map.on('click', 'parcels-circles', (e) => {
        if (e.features && e.features.length > 0) {
          const assessorId = e.features[0].properties?.assessorId
          const parcel = parcelsRef.current.find(p => p.assessorId === assessorId)
          if (parcel) onSelectParcelRef.current(parcel)
        }
      })

      const polygonFromProps = (props: any): ParcelPolygon | null => {
        const ain = String(props?.AIN ?? props?.ain ?? '').trim()
        const apn = String(props?.APN ?? props?.apn ?? '').trim()
        if (!ain && !apn) return null
        return {
          ain,
          apn,
          address: String(props?.SitusFullAddress ?? props?.address ?? '').trim(),
          useCode: String(props?.UseCode ?? props?.useCode ?? '').trim(),
          useType: String(props?.UseType ?? props?.useType ?? '').trim(),
          geometry: { type: 'Polygon', coordinates: [] } as any,
          centerLat: Number(props?.CENTER_LAT ?? props?.centerLat ?? 0) || 0,
          centerLon: Number(props?.CENTER_LON ?? props?.centerLon ?? 0) || 0
        }
      }

      const selectPolygonFeature = (e: maplibregl.MapLayerMouseEvent) => {
        if (!e.features?.length) return
        const props = e.features[0].properties ?? {}
        const polygon = polygonFromProps(props)
        const key = polygon?.ain || polygon?.apn || ''
        if (!key) return
        onSelectParcelByKeyRef.current(key, polygon)
      }

      const hoverPolygonFeature = (e: maplibregl.MapLayerMouseEvent) => {
        if (!e.features?.length) return
        const props = e.features[0].properties ?? {}
        const ain = String(props.AIN ?? props.ain ?? '').trim()
        const apn = String(props.APN ?? props.apn ?? '').trim()
        const key = ain || apn
        if (!key) return
        setHoveredParcelKey(key)
        setHoverTooltip({
          x: e.point.x,
          y: e.point.y,
          label: String(apn || ain || 'Parcel'),
          sublabel: String(props.SitusFullAddress || props.address || 'Address unavailable')
        })
        if (pmtilesReadyRef.current && ain) {
          const prev = lastHoverAinRef.current
          if (prev && prev !== ain) {
            map.setFeatureState(
              { source: PMTILES_VECTOR_SOURCE_ID, sourceLayer: pmtilesSourceLayerRef.current, id: prev } as any,
              { hover: false }
            )
          }
          lastHoverAinRef.current = ain
          map.setFeatureState(
            { source: PMTILES_VECTOR_SOURCE_ID, sourceLayer: pmtilesSourceLayerRef.current, id: ain } as any,
            { hover: true }
          )
        }
        map.getCanvas().style.cursor = 'pointer'
      }

      const clearPolygonHover = () => {
        setHoveredParcelKey(null)
        setHoverTooltip(null)
        const prev = lastHoverAinRef.current
        if (pmtilesReadyRef.current && prev) {
          map.setFeatureState(
            { source: PMTILES_VECTOR_SOURCE_ID, sourceLayer: pmtilesSourceLayerRef.current, id: prev } as any,
            { hover: false }
          )
        }
        lastHoverAinRef.current = null
        map.getCanvas().style.cursor = ''
      }

      let boundaryHandlersRegistered = false
      const registerBoundaryHandlers = () => {
        if (boundaryHandlersRegistered) return
        if (!map.getLayer(PMTILES_FILL_LAYER_ID) || !map.getLayer(PMTILES_LINE_LAYER_ID)) return
        boundaryHandlersRegistered = true
        map.on('click', PMTILES_FILL_LAYER_ID, selectPolygonFeature)
        map.on('click', PMTILES_LINE_LAYER_ID, selectPolygonFeature)
        map.on('mousemove', PMTILES_FILL_LAYER_ID, hoverPolygonFeature)
        map.on('mousemove', PMTILES_LINE_LAYER_ID, hoverPolygonFeature)
        map.on('mouseleave', PMTILES_FILL_LAYER_ID, clearPolygonHover)
        map.on('mouseleave', PMTILES_LINE_LAYER_ID, clearPolygonHover)
      }
      map.on('click', async (e) => {
        const layers: string[] = ['parcels-circles']
        if (map.getLayer(PMTILES_FILL_LAYER_ID)) layers.push(PMTILES_FILL_LAYER_ID)
        if (map.getLayer(PMTILES_LINE_LAYER_ID)) layers.push(PMTILES_LINE_LAYER_ID)
        const rendered = map.queryRenderedFeatures(e.point, { layers })
        if (rendered.length > 0) return
        try {
          const polygon = await window.rentSeeker.getParcelByPoint(e.lngLat.lng, e.lngLat.lat)
          if (polygon) onSelectParcelByKeyRef.current(polygon.ain || polygon.apn, polygon)
        } catch {
          // Rendered feature clicks remain the primary path.
        }
      })
      // The PMTiles boundary layers are added asynchronously. Register interactions only after they're present.
      map.on('idle', registerBoundaryHandlers)

      // Hover cursor
      map.on('mouseenter', 'parcels-circles', () => {
        map.getCanvas().style.cursor = 'pointer'
      })
      map.on('mouseleave', 'parcels-circles', () => {
        map.getCanvas().style.cursor = ''
      })

      map.on('moveend', () => {
        const bounds = map.getBounds()
        saveMapState(map)
        onViewportChangeRef.current({
          north: bounds.getNorth(),
          south: bounds.getSouth(),
          east: bounds.getEast(),
          west: bounds.getWest()
        })
      })
    })

    mapRef.current = map
    if (onMapReady) onMapReady(map)

    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  // Keep MapLibre layer visibility + boundary counts in sync with viewport.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    let pollTimer: number | null = null
    let lastCountTs = 0
    let lastSeenSize = 0

    const applyVisibility = () => {
      const visibility = showPolygons ? 'visible' : 'none'
      if (map.getLayer(PMTILES_LINE_LAYER_ID)) map.setLayoutProperty(PMTILES_LINE_LAYER_ID, 'visibility', visibility)
      if (map.getLayer(PMTILES_FILL_LAYER_ID)) map.setLayoutProperty(PMTILES_FILL_LAYER_ID, 'visibility', visibility)
    }

    const updateCounts = () => {
      const now = performance.now()
      if (now - lastCountTs < 250) return
      lastCountTs = now
      if (!showPolygons || !pmtilesReadyRef.current) {
        onBoundaryStats(0, 0, true, false)
        return
      }
      if (map.getZoom() < PARCEL_BOUNDARY_RENDER_MIN_ZOOM) {
        onBoundaryStats(0, 0, true, true)
        return
      }
      if (!map.getLayer(PMTILES_LINE_LAYER_ID)) {
        onBoundaryStats(0, 0, true, false)
        return
      }
      const features = map.queryRenderedFeatures(undefined, { layers: [PMTILES_LINE_LAYER_ID] } as any)
      const seen = new Set<string>()
      for (let idx = 0; idx < features.length; idx++) {
        const feature = features[idx]
        const props: any = (feature as any).properties ?? {}
        const ain = String(props.AIN ?? props.ain ?? '').trim()
        const apn = String(props.APN ?? props.apn ?? '').trim()
        const objectId = String(props.OBJECTID ?? props.objectid ?? props.ObjectID ?? props.oid ?? '').trim()
        // With promoteId enabled, feature.id should be stable even if AIN isn't present in properties.
        const fid = (feature as any).id != null ? String((feature as any).id) : ''
        const key = ain || apn || fid || objectId || String(idx)
        seen.add(key)
      }
      lastSeenSize = seen.size
      onBoundaryStats(seen.size, seen.size, true, false)
    }

    applyVisibility()
    updateCounts()
    const onMoveStart = () => {
      if (!showPolygons) return
      onBoundaryRefreshStateChange?.('moving')
      if (pollTimer != null) {
        window.clearTimeout(pollTimer)
        pollTimer = null
      }
      updateCounts()
    }
    const onMoveEnd = () => {
      if (!showPolygons) return
      onBoundaryRefreshStateChange?.('settling')
      updateCounts()
      if (pollTimer != null) window.clearTimeout(pollTimer)
      pollTimer = window.setTimeout(() => {
        updateCounts()
        onBoundaryRefreshStateChange?.('idle')
      }, 180)
    }
    const onSourceData = (e: any) => {
      if (!e?.sourceId || e.sourceId !== PMTILES_VECTOR_SOURCE_ID) return
      updateCounts()
    }
    map.on('movestart', onMoveStart)
    map.on('move', updateCounts)
    map.on('moveend', onMoveEnd)
    map.on('sourcedata', onSourceData)
    // Initial bring-up: trigger a real count pass so boundary tiles begin requesting.
    updateCounts()
    return () => {
      map.off('movestart', onMoveStart)
      map.off('move', updateCounts)
      map.off('moveend', onMoveEnd)
      map.off('sourcedata', onSourceData)
      if (pollTimer != null) window.clearTimeout(pollTimer)
    }
  }, [showPolygons, visualSettings.showPolygonFill, onBoundaryStats, onBoundaryRefreshStateChange])

  // Update topo overlay GeoJSON (terrain samples) + visibility.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const src = map.getSource('topo-source') as maplibregl.GeoJSONSource | undefined
    if (!src) return
    const visible = visualSettings.showTopoOverlay ? 'visible' : 'none'
    if (map.getLayer('topo-points-layer')) map.setLayoutProperty('topo-points-layer', 'visibility', visible)
    if (!visualSettings.showTopoOverlay || !topoOverlayData?.samples) {
      src.setData({ type: 'FeatureCollection', features: [] } as any)
      return
    }
    const samples = Array.isArray(topoOverlayData.samples) ? topoOverlayData.samples : []
    const zs = samples.map((s: any) => Number(s.z)).filter((n: number) => Number.isFinite(n))
    const minZ = zs.length ? Math.min(...zs) : 0
    const maxZ = zs.length ? Math.max(...zs) : 1
    const features = samples
      .map((s: any) => {
        const lat = Number(s.lat); const lng = Number(s.lng); const z = Number(s.z)
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(z)) return null
        const n = maxZ > minZ ? (z - minZ) / (maxZ - minZ) : 0.5
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [lng, lat] },
          properties: { z, n }
        }
      })
      .filter(Boolean)
    src.setData({ type: 'FeatureCollection', features } as any)
  }, [topoOverlayData, visualSettings.showTopoOverlay])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !pmtilesReadyRef.current) return
    if (map.getLayer(PMTILES_FILL_LAYER_ID)) {
      map.setPaintProperty(PMTILES_FILL_LAYER_ID, 'fill-opacity', [
        'case',
        ['boolean', ['feature-state', 'selected'], false], 0.18,
        ['boolean', ['feature-state', 'hover'], false], 0.14,
        ['boolean', ['feature-state', 'owner'], false], 0.1,
        visualSettings.showPolygonFill ? 0.04 : 0
      ])
    }
    if (map.getLayer(PMTILES_LINE_LAYER_ID)) {
      map.setPaintProperty(PMTILES_LINE_LAYER_ID, 'line-width', [
        'case',
        ['boolean', ['feature-state', 'selected'], false], visualSettings.lineStrength * 3,
        ['boolean', ['feature-state', 'hover'], false], visualSettings.lineStrength * 2.5,
        ['boolean', ['feature-state', 'owner'], false], visualSettings.lineStrength * 2,
        visualSettings.lineStrength
      ])
    }
  }, [visualSettings.showPolygonFill, visualSettings.lineStrength])

  // Sync owner/selected feature-state for PMTiles layer.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !pmtilesReadyRef.current) return
    if (!map.isStyleLoaded()) return
    if (!map.getSource(PMTILES_VECTOR_SOURCE_ID)) return
    const sourceLayer = pmtilesSourceLayerRef.current

    const nextSelectedAins = new Set<string>()
    // Highlight the active dossier parcel and any polygons selected via map selection.
    if (selectedParcel?.ain) nextSelectedAins.add(selectedParcel.ain)
    for (const id of selectedParcelIds) {
      const digits = String(id).replace(/[^0-9]/g, '')
      if (digits.length >= 6 && digits.length <= 14) nextSelectedAins.add(digits)
    }

    const prevSelected = lastSelectedAinsRef.current
    try {
      for (const prev of prevSelected) {
        if (!nextSelectedAins.has(prev)) {
          map.setFeatureState({ source: PMTILES_VECTOR_SOURCE_ID, sourceLayer, id: prev } as any, { selected: false })
        }
      }
      for (const ain of nextSelectedAins) {
        map.setFeatureState({ source: PMTILES_VECTOR_SOURCE_ID, sourceLayer, id: ain } as any, { selected: true })
      }
    } catch {
      // Style reload/HMR can temporarily invalidate feature-state calls.
      return
    }
    lastSelectedAinsRef.current = nextSelectedAins

    const prevOwners = lastOwnerAinsRef.current
    try {
      for (const prev of prevOwners) {
        if (!ownerAins.has(prev)) {
          map.setFeatureState({ source: PMTILES_VECTOR_SOURCE_ID, sourceLayer, id: prev } as any, { owner: false })
        }
      }
      for (const ain of ownerAins) {
        map.setFeatureState({ source: PMTILES_VECTOR_SOURCE_ID, sourceLayer, id: ain } as any, { owner: true })
      }
    } catch {
      return
    }
    lastOwnerAinsRef.current = new Set(ownerAins)
  }, [ownerAins, selectedParcel?.ain, selectedParcelIds])

  // Update GeoJSON source when parcels or selection changes
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    let raf: number | null = null
    let cancelled = false

    const updateSource = () => {
      const source = map.getSource('parcels-source') as maplibregl.GeoJSONSource | undefined
      if (!source) return

      const geolocated = parcels.filter(
        p => p.latitude != null && p.longitude != null && p.latitude !== 0 && p.longitude !== 0
      )

      const center = map.getCenter()
      const featuresFull = geolocated
        .map(p => ({
          p,
          // radial sort: bloom from current map center
          d: (p.latitude && p.longitude)
            ? Math.hypot(p.longitude - center.lng, p.latitude - center.lat)
            : 0
        }))
        .sort((a, b) => a.d - b.d)
        .map(({ p }) => ({
        type: 'Feature' as const,
        geometry: {
          type: 'Point' as const,
          coordinates: [p.longitude!, p.latitude!]
        },
        properties: {
          assessorId: p.assessorId,
          isTarget: targetIds.includes(p.assessorId),
          isOwnerParcel: ownerAins.has(p.ain),
          isSelected: selectedParcel?.assessorId === p.assessorId,
          dataSource: visualSettings.datasetColorDots ? parcelVisualSource(p) : 'parcel'
        }
      }))

      // Creative marker load animation (Plan 02): stream points in from center-out.
      if (!visualSettings.showDots || featuresFull.length <= 1) {
        source.setData({ type: 'FeatureCollection', features: featuresFull } as any)
      } else {
        if (raf) cancelAnimationFrame(raf)
        const started = performance.now()
        const durationMs = Math.min(650, 220 + featuresFull.length * 0.7)
        const ease = (t: number) => 1 - Math.pow(1 - t, 3)

        const tick = () => {
          if (cancelled) return
          const t = Math.min(1, (performance.now() - started) / durationMs)
          const pct = ease(t)
          const count = Math.max(1, Math.floor(featuresFull.length * pct))
          source.setData({ type: 'FeatureCollection', features: featuresFull.slice(0, count) } as any)
          if (t < 1) raf = requestAnimationFrame(tick)
        }
        raf = requestAnimationFrame(tick)
      }

      // Fit bounds on first load only
      if (!initialFitDone.current && geolocated.length > 0) {
        initialFitDone.current = true
        const bounds = new maplibregl.LngLatBounds()
        geolocated.forEach(p => bounds.extend([p.longitude!, p.latitude!]))
        if (geolocated.length > 1) {
          map.fitBounds(bounds, { padding: 80, maxZoom: 15, duration: 1200 })
        } else {
          map.flyTo({ center: [geolocated[0].longitude!, geolocated[0].latitude!], zoom: 15, duration: 1200 })
        }
      }
    }

    if (map.isStyleLoaded()) {
      updateSource()
    } else {
      map.on('load', updateSource)
    }
    if (map.getLayer('parcels-circles')) {
      map.setLayoutProperty('parcels-circles', 'visibility', visualSettings.showDots ? 'visible' : 'none')
      map.setLayoutProperty('parcels-glow', 'visibility', visualSettings.showDots ? 'visible' : 'none')
    }
    return () => {
      cancelled = true
      if (raf) cancelAnimationFrame(raf)
    }
  }, [parcels, targetIds, ownerAins, selectedParcel, visualSettings])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const source = map.getSource('owner-heat-source') as maplibregl.GeoJSONSource | undefined
    if (source) {
      const maxValue = Math.max(1, ...heatCells.map((c) => c.totalValue))
      source.setData({
        type: 'FeatureCollection',
        features: heatCells
          .filter((cell) => Number.isFinite(cell.latBin) && Number.isFinite(cell.lngBin))
          .map((cell) => ({
            type: 'Feature' as const,
            geometry: {
              type: 'Point' as const,
              coordinates: [cell.lngBin, cell.latBin]
            },
            properties: {
              w: Math.min(1, cell.totalValue / (maxValue * 0.25))
            }
          }))
      })
    }
    if (map.getLayer('owner-heat-layer')) {
      map.setLayoutProperty('owner-heat-layer', 'visibility', visualSettings.showHeatOverlay ? 'visible' : 'none')
    }
  }, [heatCells, visualSettings.showHeatOverlay])

  // Fly to selected parcel
  useEffect(() => {
    const map = mapRef.current
    if (!map || !selectedParcel?.latitude || !selectedParcel?.longitude) return
    map.flyTo({
      center: [selectedParcel.longitude, selectedParcel.latitude],
      zoom: Math.max(map.getZoom(), 14),
      duration: 800
    })
  }, [selectedParcel])

  // Draw-a-boundary mode
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    if (isDrawing) {
      map.getCanvas().style.cursor = 'crosshair'

      const onMouseDown = (e: maplibregl.MapMouseEvent) => {
        drawStartRef.current = { lng: e.lngLat.lng, lat: e.lngLat.lat }
        drawStartScreenRef.current = { x: e.point.x, y: e.point.y }
        setDrawBox({ x: e.point.x, y: e.point.y, width: 0, height: 0 })
      }

      const onMouseMove = (e: maplibregl.MapMouseEvent) => {
        if (!drawStartScreenRef.current) return
        const start = drawStartScreenRef.current
        setDrawBox({
          x: Math.min(start.x, e.point.x),
          y: Math.min(start.y, e.point.y),
          width: Math.abs(e.point.x - start.x),
          height: Math.abs(e.point.y - start.y)
        })
      }

      const onMouseUp = (e: maplibregl.MapMouseEvent) => {
        if (!drawStartRef.current) return
        const start = drawStartRef.current
        const end = { lng: e.lngLat.lng, lat: e.lngLat.lat }
        const startScreen = drawStartScreenRef.current
        drawStartRef.current = null
        drawStartScreenRef.current = null
        setDrawBox(null)

        const bounds = {
          north: Math.max(start.lat, end.lat),
          south: Math.min(start.lat, end.lat),
          east: Math.max(start.lng, end.lng),
          west: Math.min(start.lng, end.lng)
        }

        // Only complete if the box is meaningful (not a click)
        if (Math.abs(bounds.north - bounds.south) > 0.001 || Math.abs(bounds.east - bounds.west) > 0.001) {
          const mode: ParcelSelectionMode = e.originalEvent.altKey ? 'subtract' : e.originalEvent.shiftKey ? 'add' : 'replace'
          // Primary: select from rendered PMTiles geometry (fast, map-native).
          if (pmtilesReadyRef.current && startScreen) {
            const p0 = startScreen
            const p1 = e.point
            const bbox: [number, number][] = [
              [Math.min(p0.x, p1.x), Math.min(p0.y, p1.y)],
              [Math.max(p0.x, p1.x), Math.max(p0.y, p1.y)]
            ]
            const hits = map.queryRenderedFeatures(bbox as any, { layers: [PMTILES_FILL_LAYER_ID] })
            const byAin = new Map<string, ParcelPolygon>()
            for (const feature of hits) {
              const props = (feature as any).properties ?? {}
              const ain = String(props.AIN ?? '').trim()
              const apn = String(props.APN ?? '').trim()
              if (!ain && !apn) continue
              const key = ain || apn
              if (!byAin.has(key)) {
                byAin.set(key, {
                  ain,
                  apn,
                  address: String(props.SitusFullAddress ?? '').trim(),
                  useCode: String(props.UseCode ?? '').trim(),
                  useType: String(props.UseType ?? '').trim(),
                  geometry: { type: 'Polygon', coordinates: [] } as any,
                  centerLat: Number(props.CENTER_LAT ?? 0) || 0,
                  centerLon: Number(props.CENTER_LON ?? 0) || 0
                })
              }
            }
            const polys = [...byAin.values()]
            if (polys.length > 0) {
              onGroupSelect(polys, mode)
              return
            }
          }

          // Fallback: service-based selection refinement.
          window.rentSeeker.getParcelsInBounds(bounds)
            .then(polys => onGroupSelect(polys, mode))
            .catch(() => onGroupSelect([], mode))
        }
      }

      map.on('mousedown', onMouseDown)
      map.on('mousemove', onMouseMove)
      map.on('mouseup', onMouseUp)

      return () => {
        map.off('mousedown', onMouseDown)
        map.off('mousemove', onMouseMove)
        map.off('mouseup', onMouseUp)
        map.getCanvas().style.cursor = ''
        setDrawBox(null)
      }
    } else {
      map.getCanvas().style.cursor = ''
    }
  }, [isDrawing, onGroupSelect])

  const geoCount = parcels.filter(p => p.latitude != null && p.latitude !== 0).length
  const targetCount = parcels.filter(p => targetIds.includes(p.assessorId) && p.latitude != null).length

  return (
    <div className="pe-map-container" ref={containerRef}>
      <div className="pe-map-overlay">
        <div className="pe-map-stat">
          <div className="pe-map-stat-dot accent" />
          {targetCount} targets
        </div>
        <div className="pe-map-stat">
          <div className="pe-map-stat-dot cyan" />
          {geoCount} on map
        </div>
      </div>
      {visualSettings.showTopoOverlay && terrainMetrics && (
        <div className="pe-map-topo-overlay">
          <span>{terrainMetrics.bestFitSlopePct.toFixed(1)}% slope</span>
          <span>{terrainMetrics.demRelief.toFixed(0)}ft relief</span>
        </div>
      )}
      {hoverTooltip && (
        <div
          className="pe-parcel-hover-tooltip"
          style={{ transform: `translate(${hoverTooltip.x + 14}px, ${hoverTooltip.y + 14}px)` }}
        >
          <strong>{hoverTooltip.label}</strong>
          <span>{hoverTooltip.sublabel}</span>
        </div>
      )}
      {drawBox && (
        <div
          className="pe-map-draw-box"
          style={{
            transform: `translate(${drawBox.x}px, ${drawBox.y}px)`,
            width: drawBox.width,
            height: drawBox.height
          }}
        />
      )}
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════
   CONFIRMATION MODAL
   ═══════════════════════════════════════════════════════════ */

function ConfirmModal({ count, onConfirm, onCancel }: { count: number; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="pe-modal-backdrop">
      <div className="pe-modal">
        <div className="pe-modal-icon">⚠</div>
        <h3>Large Query Warning</h3>
        <p>
          This filter will return <strong>{count.toLocaleString()}</strong> parcels.
          Loading this many records may take a while.
        </p>
        <div className="pe-modal-actions">
          <button className="pe-modal-btn cancel" onClick={onCancel}>Cancel</button>
          <button className="pe-modal-btn confirm" onClick={onConfirm}>Load Anyway</button>
        </div>
      </div>
    </div>
  )
}

function SelectionGroupPanel({
  polygons,
  selectedIds,
  records,
  onActivate,
  onClear
}: {
  polygons: ParcelPolygon[]
  selectedIds: Set<string>
  records: ParcelRecord[]
  onActivate: (key: string, polygon?: ParcelPolygon | null) => void
  onClear: () => void
}) {
  const selectedRecords = records.filter(record => parcelRecordKeys(record).some(key => selectedIds.has(key)))
  const totalValue = selectedRecords.reduce((sum, record) => sum + record.totalValue, 0)
  const ownerCoverage = polygons.length > 0
    ? Math.round((polygons.filter(poly => poly.ain).length / polygons.length) * 100)
    : 0
  const permitCoverage = selectedRecords.length > 0
    ? Math.round((selectedRecords.filter(record => (
      (record.buildingPermitCount ?? 0) > 0 ||
      (record.electricalPermitCount ?? 0) > 0 ||
      (record.submittedBuildingPermitCount ?? 0) > 0 ||
      (record.inspectionCount ?? 0) > 0
    )).length / selectedRecords.length) * 100)
    : 0

  if (selectedIds.size === 0 || polygons.length === 0) return null

  return (
    <div className="pe-selection-group-panel">
      <div className="pe-selection-group-head">
        <span>{polygons.length.toLocaleString()} selected parcels</span>
        <button onClick={onClear}>Clear</button>
      </div>
      <div className="pe-selection-group-stats">
        <div><strong>{formatCurrency(totalValue)}</strong><span>loaded assessed value</span></div>
        <div><strong>{ownerCoverage}%</strong><span>SBF/APN coverage</span></div>
        <div><strong>{permitCoverage}%</strong><span>permit coverage</span></div>
      </div>
      <div className="pe-selection-group-list">
        {polygons.slice(0, 24).map(poly => {
          const key = poly.ain || poly.apn
          return (
            <button key={`${key}-${poly.centerLat}-${poly.centerLon}`} onClick={() => onActivate(key, poly)}>
              {poly.apn || poly.ain}
            </button>
          )
        })}
        {polygons.length > 24 && <span>+{(polygons.length - 24).toLocaleString()} more</span>}
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════
   MAIN COMPONENT — PARCEL EXPLORER
   ═══════════════════════════════════════════════════════════ */

export function ParcelExplorer() {
  const api = typeof window !== 'undefined' ? window.rentSeeker : undefined
  const [result, setResult] = useState<ParcelQueryResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedParcel, setSelectedParcel] = useState<ParcelRecord | null>(null)
  const [searchText, setSearchText] = useState('')
  const [showCofO, setShowCofO] = useState(true)
  const [showBuildingPermits, setShowBuildingPermits] = useState(true)
  const [showElectricalPermits, setShowElectricalPermits] = useState(true)
  const [showSubmittedPermits, setShowSubmittedPermits] = useState(true)
  const [showInspections, setShowInspections] = useState(true)
  const [showPolygons, setShowPolygons] = useState(true)
  const [isDrawing, setIsDrawing] = useState(false)
  const [pendingCount, setPendingCount] = useState<number | null>(null)
  const [pendingFilter, setPendingFilter] = useState<ParcelFilterQuery | null>(null)
  const [is3D, setIs3D] = useState(false)
  const [clayMode, setClayMode] = useState(false)
  const [showSun, setShowSun] = useState(false)
  const [showView, setShowView] = useState(false)
  const [showBuild, setShowBuild] = useState(false)
  const [showAnalytics, setShowAnalytics] = useState(false)
  const [showPropstreamGrid, setShowPropstreamGrid] = useState(false)
  const [showVisualSettings, setShowVisualSettings] = useState(false)
  const [visualSettings, setVisualSettings] = useState<VisualSettings>(DEFAULT_VISUAL_SETTINGS)
  const [selectedOwnerName, setSelectedOwnerName] = useState<string | null>(null)
  const [ownerParcelAins, setOwnerParcelAins] = useState<Set<string>>(new Set())
  const [heatCells, setHeatCells] = useState<HeatMapCell[]>([])
  const [slopeHover, setSlopeHover] = useState<{ deg: number | null; pos: { x: number; y: number } | null }>({ deg: null, pos: null })
  const [terrainMetrics, setTerrainMetrics] = useState<TerrainMetrics | null>(null)
  const [terrainStatus, setTerrainStatus] = useState<{ computed: boolean; reason?: string } | null>(null)
  const [sunAnalysisForShadow, setSunAnalysisForShadow] = useState<SunAnalysis | null>(null)
  const [topoOverlayData, setTopoOverlayData] = useState<any | null>(null)
  const [selectedParcelGeometry, setSelectedParcelGeometry] = useState<Geometry | null>(null)
  const [analysisBundle, setAnalysisBundle] = useState<ParcelAnalysisBundleResponse | null>(null)
  const [dossierProvenance, setDossierProvenance] = useState<ParcelDossierProvenance | null>(null)
  const [mapInstance, setMapInstance] = useState<maplibregl.Map | null>(null)
  const [loadProgress, setLoadProgress] = useState<DataLoadProgress | null>(null)
  const [factSourceManifest, setFactSourceManifest] = useState<ParcelFactSourceManifestEntry[]>([])
  const [pmtilesInfo, setPmtilesInfo] = useState<ParcelPmtilesInfo | null>(null)
  const [pmtilesSourceLayer, setPmtilesSourceLayer] = useState<string>(PMTILES_VECTOR_LAYER_ID)
  const [pmtilesReady, setPmtilesReady] = useState(false)
  const [sourceBlobStats, setSourceBlobStats] = useState<ParcelSourceBlobStats | null>(null)
  const [viewportRefreshCount, setViewportRefreshCount] = useState(0)
  const [polygonInteractionOk, setPolygonInteractionOk] = useState(false)
  const [buildRuns, setBuildRuns] = useState<BuildRunOutput[]>([])
  const [visibleBoundaryCount, setVisibleBoundaryCount] = useState(0)
  const [renderedBoundaryCount, setRenderedBoundaryCount] = useState(0)
  const [boundaryComplete, setBoundaryComplete] = useState(true)
  const [boundariesSuppressedForDensity, setBoundariesSuppressedForDensity] = useState(false)
  const [boundaryRefreshState, setBoundaryRefreshState] = useState<'idle' | 'moving' | 'settling'>('idle')
  const [selectedParcelIds, setSelectedParcelIds] = useState<Set<string>>(new Set())
  const [selectedGroupPolygons, setSelectedGroupPolygons] = useState<ParcelPolygon[]>([])
  const warmParcelPoolRef = useRef<Map<string, ParcelRecord>>(new Map())
  const [importingData, setImportingData] = useState(false)
  const [dropActive, setDropActive] = useState(false)

  // Plan 03: real app-assembly loader tied to actual readiness gates.
  const assemblyStartedAtRef = useRef<number>(performance.now())
  const [assemblySteps, setAssemblySteps] = useState<DataLoadStep[]>([
    { datasetName: 'Basemap', color: '#ffffff', status: 'loading', rowCount: 0, elapsedMs: 0 },
    { datasetName: 'Parcel Boundary Lines', color: '#abff02', status: 'pending', rowCount: 0, elapsedMs: 0 },
    { datasetName: 'Parcel Records', color: '#00d4ff', status: 'pending', rowCount: 0, elapsedMs: 0 },
    { datasetName: 'Owner Index (SBF)', color: '#ffde59', status: 'pending', rowCount: 0, elapsedMs: 0 },
    { datasetName: 'Panels', color: '#ffffff', status: 'pending', rowCount: 0, elapsedMs: 0 }
  ])
  const [assembling, setAssembling] = useState(true)
  const [runtimeGateStage, setRuntimeGateStage] = useState<'basemap' | 'boundaries' | 'records' | 'owner' | 'done'>('basemap')
  const [startupMode, setStartupMode] = useState<'default' | 'empty' | 'custom'>('default')
  const [startupActionPending, setStartupActionPending] = useState(false)
  const [pmtilesStats, setPmtilesStats] = useState<{ tiles: number; totalMs: number; lastMs: number } | null>(null)
  const [pmtilesStatsDetailed, setPmtilesStatsDetailed] = useState<any | null>(null)
  const captureOnceRef = useRef<{ boundaries?: boolean; records?: boolean }>({})
  const startupModeRef = useRef<'default' | 'empty' | 'custom'>('default')
  const startupEpochRef = useRef(0)

  const markAssembly = useCallback((name: string, patch: Partial<DataLoadStep>) => {
    const elapsedMs = Math.max(0, performance.now() - assemblyStartedAtRef.current)
    setAssemblySteps((current) => current.map((step) => (
      step.datasetName === name ? { ...step, ...patch, elapsedMs } : step
    )))
  }, [])

  const completeManualStartup = useCallback((mode: 'empty' | 'custom') => {
    startupModeRef.current = mode
    startupEpochRef.current += 1
    setStartupMode(mode)
    setLoading(false)
    setRuntimeGateStage('done')
    setAssemblySteps((current) => current.map((step) => ({
      ...step,
      status: step.datasetName === 'Basemap'
        ? (step.status === 'done' ? 'done' : 'loading')
        : 'done',
      rowCount: step.datasetName === 'Basemap' ? step.rowCount : 0,
      errorMsg: undefined
    })))
    setSelectedParcel(null)
    setSelectedParcelIds(new Set())
    setSelectedGroupPolygons([])
    setResult(null)
    setBuildRuns([])
    setTerrainMetrics(null)
    setTerrainStatus(null)
    setSunAnalysisForShadow(null)
    setTopoOverlayData(null)
    setDossierProvenance(null)
    setOwnerParcelAins(new Set())
    setShowPolygons(false)
    setVisibleBoundaryCount(0)
    setRenderedBoundaryCount(0)
    setFilter((current) => ({
      ...current,
      bounds: undefined,
      targetParcels: undefined,
      randomSample: false,
      limit: 500
    }))
    window.setTimeout(() => setAssembling(false), 120)
  }, [])

  // Keep elapsed time "live" for loading steps so the overlay reflects reality (no stale UI).
  useEffect(() => {
    if (!assembling) return
    const id = window.setInterval(() => {
      const elapsedMs = Math.max(0, performance.now() - assemblyStartedAtRef.current)
      setAssemblySteps((current) => current.map((step) => (
        step.status === 'loading' ? { ...step, elapsedMs } : step
      )))
    }, 200)
    return () => window.clearInterval(id)
  }, [assembling])

  const sequentializedSteps = useMemo(() => {
    // User requirement: do not "start" showing step N+1 until step N is actually done/error.
    let blocked = false
    return assemblySteps.map((step) => {
      if (blocked) return { ...step, status: 'pending' as const, rowCount: 0 }
      if (step.status === 'done' || step.status === 'error') return step
      blocked = true
      return step
    })
  }, [assemblySteps])

  const [filter, setFilter] = useState<ParcelFilterQuery>(() => {
    const saved = getSavedMapState()
    const fallbackBounds = saved?.bounds ?? {
      north: SANTA_MONICA_MOUNTAINS_CENTER[1] + 0.06,
      south: SANTA_MONICA_MOUNTAINS_CENTER[1] - 0.06,
      east: SANTA_MONICA_MOUNTAINS_CENTER[0] + 0.08,
      west: SANTA_MONICA_MOUNTAINS_CENTER[0] - 0.08
    }
    return ({
    limit: 500,
    randomSample: true,
    bounds: fallbackBounds,
    includeCofO: true,
    includeBuildingPermits: true,
    includeElectricalPermits: true,
    includeSubmittedPermits: true,
    includeInspections: true,
    sortField: 'assessorId',
    sortDir: 'asc'
    })
  })

  // PMTiles telemetry for diagnosing slow boundary line load.
  useEffect(() => {
    const onStats = (e: any) => {
      const stats = e?.detail ?? null
      setPmtilesStats(stats)
    }
    window.addEventListener('rentseeker:pmtiles:stats', onStats as any)
    return () => window.removeEventListener('rentseeker:pmtiles:stats', onStats as any)
  }, [])

  // Fetch main-process PMTiles stats (I/O vs gunzip vs cache) while boundaries are loading.
  useEffect(() => {
    if (!api) return
    const boundaries = assemblySteps.find(s => s.datasetName === 'Parcel Boundary Lines')
    if (!assembling || !boundaries || boundaries.status !== 'loading') return
    let alive = true
    const tick = async () => {
      try {
        const stats = await api.getParcelPmtilesStats()
        if (alive) setPmtilesStatsDetailed(stats as any)
      } catch {
        // ignore
      }
    }
    void tick()
    const id = window.setInterval(() => void tick(), 500)
    return () => { alive = false; window.clearInterval(id) }
  }, [api, assembling, assemblySteps])

  const { dotRef, ringRef, hovering, setHovering } = useCustomCursor()
  const firstLoadRef = useRef(true)
  const viewportReloadRef = useRef<number | null>(null)
  const sbfRepairAttemptedRef = useRef(false)
  const loadInFlightRef = useRef(false)
  const queuedLoadRef = useRef<{ filterQuery: ParcelFilterQuery; showAssembly: boolean } | null>(null)
  const activeLoadSignatureRef = useRef<string | null>(null)
  const lastCompletedLoadSignatureRef = useRef<string | null>(null)

  const parcelLoadSignature = useCallback((filterQuery: ParcelFilterQuery) => {
    return JSON.stringify({
      apnPrefix: filterQuery.apnPrefix ?? '',
      bounds: filterQuery.bounds ? {
        north: filterQuery.bounds.north,
        south: filterQuery.bounds.south,
        east: filterQuery.bounds.east,
        west: filterQuery.bounds.west
      } : null,
      includeCofO: filterQuery.includeCofO !== false,
      includeBuildingPermits: filterQuery.includeBuildingPermits !== false,
      includeElectricalPermits: filterQuery.includeElectricalPermits !== false,
      includeSubmittedPermits: filterQuery.includeSubmittedPermits !== false,
      includeInspections: filterQuery.includeInspections !== false,
      limit: filterQuery.limit ?? 500,
      randomSample: filterQuery.randomSample === true,
      searchText: filterQuery.searchText ?? '',
      sortField: filterQuery.sortField ?? '',
      sortDir: filterQuery.sortDir ?? '',
      targetParcels: filterQuery.targetParcels ?? '',
      useType: filterQuery.useType ?? '',
      valueMin: filterQuery.valueMin ?? null,
      valueMax: filterQuery.valueMax ?? null,
      yearBuiltMin: filterQuery.yearBuiltMin ?? null,
      yearBuiltMax: filterQuery.yearBuiltMax ?? null,
      hasCofO: filterQuery.hasCofO ?? null
    })
  }, [])

  const collectDroppedPaths = useCallback(async (dt: DataTransfer): Promise<string[]> => {
    const paths = new Set<string>()

    const walkEntry = async (entry: any): Promise<void> => {
      if (!entry) return
      if (entry.isFile) {
        await new Promise<void>((resolve) => {
          entry.file((file: File) => {
            const path = (file as any).path
            if (path) paths.add(path)
            resolve()
          })
        })
        return
      }
      if (!entry.isDirectory) return
      const reader = entry.createReader()
      const readBatch = async (): Promise<void> => {
        const entries: any[] = await new Promise((resolve) => reader.readEntries(resolve))
        if (!entries.length) return
        for (const child of entries) await walkEntry(child)
        await readBatch()
      }
      await readBatch()
    }

    const items = Array.from(dt.items ?? [])
    for (const item of items) {
      const entry = (item as any).webkitGetAsEntry?.()
      if (entry) {
        await walkEntry(entry)
      }
    }

    if (paths.size === 0) {
      for (const file of Array.from(dt.files ?? [])) {
        const path = (file as any).path
        if (path) paths.add(path)
      }
    }

    return [...paths]
  }, [])

  const ingestPaths = useCallback(async (paths: string[]) => {
    if (!api || paths.length === 0) return
    setImportingData(true)
    try {
      const result = await api.ingestDataPaths({ paths })
      const next = await api.getDataLoadProgress().catch(() => null)
      if (next) setLoadProgress(next)
      if (!result.ok) {
        console.warn('[import] failed:', result.error ?? 'unknown error')
      } else {
        console.log('[import]', result.summary)
      }
    } finally {
      setImportingData(false)
    }
  }, [api])

  const handleLoadDefaultStartup = useCallback(() => {
    startupEpochRef.current += 1
    startupModeRef.current = 'default'
    setStartupMode('default')
    setShowPolygons(true)
    setAssembling(true)
    assemblyStartedAtRef.current = performance.now()
    setAssemblySteps([
      { datasetName: 'Basemap', color: '#ffffff', status: 'loading', rowCount: 0, elapsedMs: 0 },
      { datasetName: 'Parcel Boundary Lines', color: '#abff02', status: 'pending', rowCount: 0, elapsedMs: 0 },
      { datasetName: 'Parcel Records', color: '#00d4ff', status: 'pending', rowCount: 0, elapsedMs: 0 },
      { datasetName: 'Owner Index (SBF)', color: '#ffde59', status: 'pending', rowCount: 0, elapsedMs: 0 },
      { datasetName: 'Panels', color: '#ffffff', status: 'pending', rowCount: 0, elapsedMs: 0 }
    ])
    setRuntimeGateStage('basemap')
    setFilter((current) => ({
      ...current,
      bounds: getSavedMapState()?.bounds ?? {
        north: SANTA_MONICA_MOUNTAINS_CENTER[1] + 0.06,
        south: SANTA_MONICA_MOUNTAINS_CENTER[1] - 0.06,
        east: SANTA_MONICA_MOUNTAINS_CENTER[0] + 0.08,
        west: SANTA_MONICA_MOUNTAINS_CENTER[0] - 0.08
      },
      randomSample: true,
      limit: 500
    }))
  }, [])

  const handleStartEmpty = useCallback(() => {
    completeManualStartup('empty')
  }, [completeManualStartup])

  const handleChooseStartupSources = useCallback(async () => {
    if (!api) return
    setStartupActionPending(true)
    startupModeRef.current = 'custom'
    setStartupMode('custom')
    try {
      const folders = await api.pickImportFolder().catch(() => [])
      if (folders.length > 0) {
        await ingestPaths(folders)
      }
      completeManualStartup('custom')
    } finally {
      setStartupActionPending(false)
    }
  }, [api, completeManualStartup, ingestPaths])

  const pickImportFolder = useCallback(async () => {
    if (!api) return
    const folders = await api.pickImportFolder().catch(() => [])
    if (folders.length === 0) return
    await ingestPaths(folders)
  }, [api, ingestPaths])

  const handleDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDropActive(true)
  }, [])

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDropActive(false)
  }, [])

  const handleDrop = useCallback(async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDropActive(false)
    const paths = await collectDroppedPaths(event.dataTransfer)
    await ingestPaths(paths)
  }, [collectDroppedPaths, ingestPaths])

  useEffect(() => {
    if (!api) return
    // Strict sequencing: don't even start dataset manifest scans until the core runtime gates are done.
    if (runtimeGateStage !== 'done') return
    if (startupModeRef.current !== 'default' && !importingData) return
    let alive = true
    api.getDataLoadProgress().then(progress => {
      if (alive) setLoadProgress(progress)
    }).catch(() => undefined)
    const off = api.onDataLoadProgress((progress) => setLoadProgress(progress))
    return () => {
      alive = false
      off()
    }
  }, [api, runtimeGateStage, importingData])

  // Mirror dataset-file readiness into the loader as real steps.
  useEffect(() => {
    if (!loadProgress) return
    if (runtimeGateStage !== 'done') return
    if (startupModeRef.current !== 'default' && !importingData) return
    setAssemblySteps((current) => {
      const baseNames = new Set(current.map((s) => s.datasetName))
      const next = [...current]
      for (const step of loadProgress.steps) {
        const name = `Dataset: ${step.datasetName}`
        if (!baseNames.has(name)) {
          next.push({ ...step, datasetName: name })
          baseNames.add(name)
        } else {
          const idx = next.findIndex((s) => s.datasetName === name)
          if (idx >= 0) next[idx] = { ...next[idx], ...step, datasetName: name }
        }
      }
      return next
    })
  }, [loadProgress, runtimeGateStage, importingData])

  // Inspect PMTiles layers/fields (drives the progress checklist + inspector UI).
  useEffect(() => {
    if (!api) return
    api.getParcelPmtilesInfo()
      .then((info) => {
        setPmtilesInfo(info)
        const layer = info?.ok && info.vectorLayers?.some(l => l.id === PMTILES_VECTOR_LAYER_ID)
          ? PMTILES_VECTOR_LAYER_ID
          : (info?.vectorLayers?.[0]?.id ?? PMTILES_VECTOR_LAYER_ID)
        setPmtilesSourceLayer(layer)
      })
      .catch(() => undefined)
  }, [api])

  useEffect(() => {
    if (!api) return
    api.getSourceBlobStats()
      .then((stats) => setSourceBlobStats(stats))
      .catch(() => setSourceBlobStats(null))
  }, [api])

  useEffect(() => {
    if (!api) return
    api.getParcelFactSourceManifest()
      .then((entries) => setFactSourceManifest(Array.isArray(entries) ? entries : []))
      .catch(() => setFactSourceManifest([]))
  }, [api])

  // Prepare the SBF owner index only after records are loaded (sequential loader behavior).
  useEffect(() => {
    if (!api) return
    if (runtimeGateStage !== 'owner') return
    if (startupModeRef.current !== 'default') return
    markAssembly('Owner Index (SBF)', { status: 'loading' })
    api.prepareOwnerIndex()
      .then((resp) => {
        if (resp?.ok) {
          markAssembly('Owner Index (SBF)', { status: 'done', rowCount: Number(resp.rowCount ?? 0) || 0 })
          setRuntimeGateStage('done')
        } else {
          markAssembly('Owner Index (SBF)', { status: 'error', rowCount: 0, errorMsg: resp?.error ?? 'Owner index unavailable' })
          setRuntimeGateStage('done')
        }
      })
      .catch((err) => {
        markAssembly('Owner Index (SBF)', { status: 'error', rowCount: 0, errorMsg: err instanceof Error ? err.message : String(err) })
        setRuntimeGateStage('done')
      })
  }, [api, markAssembly, runtimeGateStage])

  // If SBF CSVs are missing, attempt the one-time XLSX -> CSV conversion automatically.
  useEffect(() => {
    if (!api || !loadProgress || sbfRepairAttemptedRef.current) return
    const sbfStep = loadProgress.steps.find(step => step.datasetName.toLowerCase().includes('secured basic file'))
      ?? loadProgress.steps.find(step => step.datasetName.toLowerCase().includes('(sbf)'))
    if (!sbfStep || sbfStep.status !== 'error') return
    sbfRepairAttemptedRef.current = true
    api.convertSbfXlsxToCsv()
      .then(async (result) => {
        if (result?.ok) {
          const next = await api.getDataLoadProgress().catch(() => null)
          if (next) setLoadProgress(next)
          // Now that CSVs exist, rebuild/prepare the owner index.
          markAssembly('Owner Index (SBF)', { status: 'loading', rowCount: 0 })
          api.prepareOwnerIndex()
            .then((resp) => {
              if (resp?.ok) markAssembly('Owner Index (SBF)', { status: 'done', rowCount: Number(resp.rowCount ?? 0) || 0 })
              else markAssembly('Owner Index (SBF)', { status: 'error', errorMsg: resp?.error ?? 'Owner index unavailable' })
            })
            .catch((err) => markAssembly('Owner Index (SBF)', { status: 'error', errorMsg: err instanceof Error ? err.message : String(err) }))
        }
      })
      .catch(() => undefined)
  }, [api, loadProgress, markAssembly])

  useEffect(() => () => {
    if (viewportReloadRef.current != null) window.clearTimeout(viewportReloadRef.current)
  }, [])

  // 3D Photorealistic Tiles overlay with ALL 3DBuild.md features
  useDeck3DOverlay({
    map: mapInstance,
    enabled: is3D,
    clayMode,
    selectedParcelGeometry,
    buildRuns,
    sunAnalysis: sunAnalysisForShadow,
    onSlopeHover: (deg, pos) => setSlopeHover({ deg, pos })
  })

  // Fetch terrain metrics when a parcel is selected
  useEffect(() => {
    if (api && selectedParcel?.latitude && selectedParcel?.longitude) {
      api.getTerrainMetrics(
        selectedParcel.assessorId,
        selectedParcel.latitude,
        selectedParcel.longitude,
        selectedParcel.squareFootage || 5000,
        selectedParcelGeometry
      )
        .then((resp: TerrainMetricsResponse) => {
          setTerrainMetrics(resp.metrics ?? null)
          setTerrainStatus(resp.computed ? { computed: true } : { computed: false, reason: resp.reason })
        })
        .catch((err) => {
          setTerrainMetrics(null)
          setTerrainStatus({ computed: false, reason: err instanceof Error ? err.message : String(err) })
        })
    }
  }, [api, selectedParcel?.assessorId, selectedParcelGeometry])

  // Plan 03: topographic overlay over the 2D map using the persisted terrain surface grid.
  useEffect(() => {
    if (!api || !visualSettings.showTopoOverlay || !selectedParcel) {
      setTopoOverlayData(null)
      return
    }
    const parcelId = selectedParcel.ain || selectedParcel.assessorId.replace(/[^0-9]/g, '')
    api.getTerrainProduct(parcelId)
      .then((product) => setTopoOverlayData(product))
      .catch(() => setTopoOverlayData(null))
  }, [api, visualSettings.showTopoOverlay, selectedParcel?.assessorId, selectedParcel?.ain])

  // Sun analysis used for shadows v1 (terrain-only, non-fake; cached/persisted in main).
  useEffect(() => {
    if (!api || !showSun || !selectedParcel?.latitude || !selectedParcel?.longitude) {
      setSunAnalysisForShadow(null)
      return
    }
    const year = new Date().getFullYear()
    const date = `${year}-06-21`
    api.getSunAnalysis(selectedParcel.assessorId, selectedParcel.latitude, selectedParcel.longitude, date, selectedParcelGeometry)
      .then((resp: SunAnalysisResponse) => {
        if (resp?.computed && resp.analysis) setSunAnalysisForShadow(resp.analysis)
        else setSunAnalysisForShadow(null)
      })
      .catch(() => setSunAnalysisForShadow(null))
  }, [api, showSun, selectedParcel?.assessorId, selectedParcel?.latitude, selectedParcel?.longitude, selectedParcelGeometry])

  useEffect(() => {
    if (!api || !selectedParcel) return
    api.getBuildRunsForParcel(selectedParcel.assessorId, geometryFingerprint(selectedParcelGeometry ?? null))
      .then(runs => setBuildRuns(runs.slice(0, 25)))
      .catch(() => setBuildRuns([]))
  }, [api, selectedParcel?.assessorId, selectedParcelGeometry])

  useEffect(() => {
    if (!api || !selectedParcel?.ain) {
      setSelectedParcelGeometry(null)
      return
    }
    api.getParcelPolygonByAin(selectedParcel.ain)
      .then((poly) => setSelectedParcelGeometry(poly?.geometry ?? null))
      .catch(() => setSelectedParcelGeometry(null))
  }, [api, selectedParcel?.ain])

  useEffect(() => {
    if (!api || !selectedParcel?.assessorId || !selectedParcel?.latitude || !selectedParcel?.longitude) {
      setAnalysisBundle(null)
      return
    }
    setDossierProvenance(null)
    const request = {
      parcelId: selectedParcel.assessorId,
      lat: selectedParcel.latitude,
      lng: selectedParcel.longitude,
      lotSqft: selectedParcel.squareFootage || 5000,
      date: `${new Date().getFullYear()}-06-21`,
      stories: Math.max(1, Number(selectedParcel.numberOfStories ?? 2) || 2),
      geometry: selectedParcelGeometry,
      parcel: selectedParcel
    }
    api.getParcelAnalysisBundle(request)
      .then((bundle) => {
        setAnalysisBundle(bundle)
        if (bundle.terrain?.metrics) {
          setTerrainMetrics(bundle.terrain.metrics)
          setTerrainStatus(bundle.terrain.computed ? { computed: true } : { computed: false, reason: bundle.terrain.reason })
        }
        if (bundle.sun?.analysis) {
          setSunAnalysisForShadow(bundle.sun.analysis)
        }
        if (bundle.view?.analysis) {
          // view analysis is surfaced in the right-side panel via the dedicated component
        }
        if (Array.isArray(bundle.buildRuns) && bundle.buildRuns.length > 0) {
          setBuildRuns(bundle.buildRuns.slice(0, 25))
        }
        if (bundle.terrainProduct) {
          setTopoOverlayData(bundle.terrainProduct)
        }
        if (bundle.provenance) {
          setDossierProvenance(bundle.provenance)
        }
      })
      .catch(() => setAnalysisBundle(null))
  }, [api, selectedParcel?.assessorId, selectedParcel?.latitude, selectedParcel?.longitude, selectedParcel?.squareFootage, selectedParcel?.numberOfStories, selectedParcelGeometry])

  // Plan 02: geometric sqft + neighbor median sqft triple-check (parcel-polygon-aware, persisted).
  useEffect(() => {
    if (!api || !selectedParcel?.ain) return
    const parcelId = selectedParcel.ain || selectedParcel.assessorId.replace(/[^0-9]/g, '')
    api.getSqftCheck(parcelId, selectedParcel.ain, selectedParcel.squareFootage || 0)
      .then((resp) => {
        setSelectedParcel((current) => {
          if (!current) return current
          return {
            ...current,
            geometricSqft: resp.geometricSqft,
            neighborMedianSqft: resp.neighborMedianSqft,
            sqftCheckStatus: resp.status
          }
        })
      })
      .catch(() => undefined)
  }, [api, selectedParcel?.ain, selectedParcel?.squareFootage, selectedParcel?.assessorId])

  useEffect(() => {
    if (!api) return
    if (!visualSettings.showHeatOverlay) {
      setHeatCells([])
      return
    }
    api.getHeatMapData(2)
      .then((cells) => setHeatCells(Array.isArray(cells) ? cells : []))
      .catch(() => setHeatCells([]))
  }, [api, visualSettings.showHeatOverlay])

  // Load data
  const loadData = useCallback(async (filterQuery: ParcelFilterQuery, showAssembly = true) => {
    if (startupModeRef.current !== 'default') return
    const signature = parcelLoadSignature(filterQuery)
    if (signature === activeLoadSignatureRef.current || signature === lastCompletedLoadSignatureRef.current) {
      return
    }
    if (loadInFlightRef.current) {
      queuedLoadRef.current = { filterQuery, showAssembly }
      return
    }
    const loadEpoch = startupEpochRef.current
    loadInFlightRef.current = true
    activeLoadSignatureRef.current = signature
    if (showAssembly) setLoading(true)
    setError(null)
    markAssembly('Parcel Records', { status: 'loading', rowCount: 0 })
    try {
      if (!api) throw new Error('RentSeeker desktop API is unavailable. Open the Electron app window, not the raw Vite URL.')
      const data = await api.queryParcelFiltered(filterQuery)
      if (startupEpochRef.current !== loadEpoch || startupModeRef.current !== 'default') return
      setResult(data)
      markAssembly('Parcel Records', { status: 'done', rowCount: Number(data?.returnedCount ?? data?.allParcels?.length ?? 0) || 0 })
      if (!captureOnceRef.current.records && api?.captureMainWindow) {
        captureOnceRef.current.records = true
        api.captureMainWindow().then((r) => {
          if (r?.ok && r.path) console.log('[capture] records:', r.path)
        }).catch(() => undefined)
      }
      setRuntimeGateStage('owner')
      if (!selectedParcel && data.allParcels?.length > 0) {
        const first = data.targetParcels[0] ?? data.allParcels[0]
        setSelectedParcel(first)
        setSelectedParcelIds(new Set(parcelRecordKeys(first)))
      }
    } catch (err) {
      if (startupEpochRef.current !== loadEpoch || startupModeRef.current !== 'default') return
      setError(err instanceof Error ? err.message : String(err))
      markAssembly('Parcel Records', { status: 'error', errorMsg: err instanceof Error ? err.message : String(err) })
      setRuntimeGateStage('owner')
    } finally {
      const stale = startupEpochRef.current !== loadEpoch || startupModeRef.current !== 'default'
      if (showAssembly) setLoading(false)
      if (firstLoadRef.current) {
        firstLoadRef.current = false
      }
      loadInFlightRef.current = false
      if (!stale) lastCompletedLoadSignatureRef.current = activeLoadSignatureRef.current
      activeLoadSignatureRef.current = null
      const queued = queuedLoadRef.current
      queuedLoadRef.current = null
      if (!stale && queued) {
        void loadData(queued.filterQuery, queued.showAssembly)
      }
    }
  }, [api, markAssembly, parcelLoadSignature, selectedParcel])

  // Initial load
  useEffect(() => {
    if (!firstLoadRef.current) return
    if (runtimeGateStage !== 'records') return
    void loadData(filter)
  }, [runtimeGateStage])

  // Filter change handler (with count check)
  const handleFilterChange = useCallback(async (newFilter: ParcelFilterQuery) => {
    setFilter(newFilter)
    // Strict sequential startup: do not start querying parcel records until boundaries are visible and
    // the runtime gate has advanced into the records stage (or later).
    if (runtimeGateStage === 'basemap' || runtimeGateStage === 'boundaries') return

    // Check count for large queries
    try {
      if (!api) throw new Error('RentSeeker desktop API is unavailable')
      const count = await api.countParcels(newFilter)
      if (count > 100000) {
        setPendingCount(count)
        setPendingFilter(newFilter)
        return
      }
    } catch {
      // Count failed, just load
    }

    void loadData({
      ...newFilter,
      limit: 500,
      includeCofO: showCofO,
      includeBuildingPermits: showBuildingPermits,
      includeElectricalPermits: showElectricalPermits,
      includeSubmittedPermits: showSubmittedPermits,
      includeInspections: showInspections
    })
  }, [api, loadData, runtimeGateStage, showCofO, showBuildingPermits, showElectricalPermits, showSubmittedPermits, showInspections])

  // Confirm large query
  const confirmLargeQuery = useCallback(() => {
    if (pendingFilter) {
      void loadData({
        ...pendingFilter,
        limit: 500,
        includeCofO: showCofO,
        includeBuildingPermits: showBuildingPermits,
        includeElectricalPermits: showElectricalPermits,
        includeSubmittedPermits: showSubmittedPermits,
        includeInspections: showInspections
      })
    }
    setPendingCount(null)
    setPendingFilter(null)
  }, [pendingFilter, loadData, showCofO, showBuildingPermits, showElectricalPermits, showSubmittedPermits, showInspections])

  // Toggle C-of-O
  const handleToggleCofO = useCallback((v: boolean) => {
    setShowCofO(v)
    if (runtimeGateStage === 'basemap' || runtimeGateStage === 'boundaries') return
    void loadData({ ...filter, includeCofO: v })
  }, [filter, loadData, runtimeGateStage])

  const reloadWithDatasetToggles = useCallback((patch: Partial<ParcelFilterQuery>) => {
    const next = {
      ...filter,
      includeCofO: showCofO,
      includeBuildingPermits: showBuildingPermits,
      includeElectricalPermits: showElectricalPermits,
      includeSubmittedPermits: showSubmittedPermits,
      includeInspections: showInspections,
      ...patch
    }
    setFilter(next)
    if (runtimeGateStage === 'basemap' || runtimeGateStage === 'boundaries') return
    void loadData(next)
  }, [filter, loadData, runtimeGateStage, showCofO, showBuildingPermits, showElectricalPermits, showSubmittedPermits, showInspections])

  const handleBoundaryStats = useCallback((visibleCount: number, renderedCount: number, complete: boolean, suppressed: boolean) => {
    if (startupModeRef.current !== 'default') return
    setBoundariesSuppressedForDensity(suppressed)
    setVisibleBoundaryCount(suppressed ? 0 : visibleCount)
    setRenderedBoundaryCount(renderedCount)
    setBoundaryComplete(complete)
    if (pmtilesReady && (visibleCount > 0 || suppressed)) {
      markAssembly('Parcel Boundary Lines', { status: 'done', rowCount: visibleCount })
      if (!captureOnceRef.current.boundaries && api?.captureMainWindow) {
        captureOnceRef.current.boundaries = true
        api.captureMainWindow().then((r) => {
          if (r?.ok && r.path) console.log('[capture] boundaries:', r.path)
        }).catch(() => undefined)
      }
      if (runtimeGateStage === 'boundaries') {
        markAssembly('Parcel Records', { status: 'loading', rowCount: 0 })
        setRuntimeGateStage('records')
      }
    }
  }, [api, pmtilesReady, markAssembly, runtimeGateStage])

  const refreshViewportRecords = useCallback((bounds: MapBounds) => {
    setViewportRefreshCount((n) => n + 1)
    const next = {
      ...filter,
      bounds,
      targetParcels: undefined,
      limit: 500,
      randomSample: true,
      includeCofO: showCofO,
      includeBuildingPermits: showBuildingPermits,
      includeElectricalPermits: showElectricalPermits,
      includeSubmittedPermits: showSubmittedPermits,
      includeInspections: showInspections
    }
    setFilter(next)
    // Strict sequential startup: do not query records until boundaries are actually visible and the
    // runtime gate has advanced into the records stage (or later).
    if (runtimeGateStage === 'basemap' || runtimeGateStage === 'boundaries') return
    if (viewportReloadRef.current != null) window.clearTimeout(viewportReloadRef.current)
    viewportReloadRef.current = window.setTimeout(() => {
      void loadData(next, false)
    }, 250)
  }, [api, filter, loadData, runtimeGateStage, showCofO, showBuildingPermits, showElectricalPermits, showSubmittedPermits, showInspections])

  const handleSelectParcelByKey = useCallback(async (parcelKey: string, polygon?: ParcelPolygon | null) => {
    if (polygon) setPolygonInteractionOk(true)
    setSelectedParcelIds(new Set(polygon ? parcelPolygonKeys(polygon) : [parcelKey]))
    if (polygon) setSelectedGroupPolygons([polygon])
    try {
      if (!api) throw new Error('RentSeeker desktop API is unavailable')
      const pool = warmParcelPoolRef.current
      const normalized = parcelKey.replace(/[^0-9]/g, '')
      const pooled = pool.get(parcelKey) ?? pool.get(normalized)
      if (pooled) {
        setResult(current => mergeParcelIntoResult(current, pooled))
        setSelectedParcel(pooled)
        setSelectedParcelIds(new Set([...parcelRecordKeys(pooled), ...(polygon ? parcelPolygonKeys(polygon) : [])]))
        return
      }
      const data = await api.queryParcelFiltered({
        targetParcels: parcelKey,
        limit: 1,
        includeCofO: showCofO,
        includeBuildingPermits: showBuildingPermits,
        includeElectricalPermits: showElectricalPermits,
        includeSubmittedPermits: showSubmittedPermits,
        includeInspections: showInspections
      })
      const parcel = data.targetParcels[0] ?? data.allParcels[0]
      if (parcel) {
        setResult(current => mergeParcelIntoResult(current, parcel))
        setSelectedParcel(parcel)
        setSelectedParcelIds(new Set([...parcelRecordKeys(parcel), ...(polygon ? parcelPolygonKeys(polygon) : [])]))
      }
    } catch {
      // Keep the geometry selection even if the enriched dossier lookup fails.
    }
  }, [api, showCofO, showBuildingPermits, showElectricalPermits, showSubmittedPermits, showInspections])

  const handleGroupSelect = useCallback((polygons: ParcelPolygon[], mode: ParcelSelectionMode) => {
    setIsDrawing(false)
    if (polygons.length > 0) setPolygonInteractionOk(true)
    const nextKeys = new Set(polygons.flatMap(parcelPolygonKeys))
    setSelectedParcelIds(current => {
      if (mode === 'add') return new Set([...current, ...nextKeys])
      if (mode === 'subtract') {
        const reduced = new Set(current)
        nextKeys.forEach(key => reduced.delete(key))
        return reduced
      }
      return nextKeys
    })
    setSelectedGroupPolygons(current => {
      if (mode === 'add') {
        const byKey = new Map<string, ParcelPolygon>()
        current.forEach(poly => byKey.set(parcelPolygonKeys(poly)[0], poly))
        polygons.forEach(poly => byKey.set(parcelPolygonKeys(poly)[0], poly))
        return [...byKey.values()]
      }
      if (mode === 'subtract') {
        return current.filter(poly => !parcelPolygonKeys(poly).some(key => nextKeys.has(key)))
      }
      return polygons
    })
    const first = polygons[0]
    if (first && mode !== 'subtract') void handleSelectParcelByKey(first.ain || first.apn, first)
  }, [handleSelectParcelByKey])

  const clearGroupSelection = useCallback(() => {
    setSelectedParcelIds(new Set())
    setSelectedGroupPolygons([])
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsDrawing(false)
        clearGroupSelection()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [clearGroupSelection])

  // Target IDs for map markers
  const targetIds = useMemo(() => {
    if (!result?.targetParcels) return []
    return result.targetParcels.map(p => p.assessorId)
  }, [result])

  // All displayed parcels
  const displayedParcels = useMemo(() => {
    if (!result) return []
    if (!searchText.trim()) return result.allParcels

    const needle = searchText.toLowerCase().replace(/[-\s]/g, '')
    return result.allParcels.filter((p) => {
      const haystack = [
        p.assessorId.replace(/-/g, ''),
        p.ain,
        p.propertyLocation,
        p.street,
        p.city,
        p.parcelLegalDescription,
        p.propertyUseType
      ].join(' ').toLowerCase().replace(/[-\s]/g, '')
      return haystack.includes(needle)
    })
  }, [result, searchText])

  // Dataset counts
  const datasetCounts = useMemo(() => {
    const parcels = displayedParcels
    const hasSource = (parcel: ParcelRecord, source: DataSource) => parcel.dataSources?.includes(source) ?? false
    return {
      parcel: parcels.filter(p => hasSource(p, 'parcel')).length,
      owner: parcels.filter(p => p.ain).length,
      cofo: parcels.filter(p => hasSource(p, 'cofo')).length,
      both: parcels.filter(p => p.dataSource === 'both').length,
      buildingPermit: parcels.filter(p => hasSource(p, 'building_permit')).length,
      electricalPermit: parcels.filter(p => hasSource(p, 'electrical_permit')).length,
      submittedPermit: parcels.filter(p => hasSource(p, 'building_permit_submitted')).length,
      inspection: parcels.filter(p => hasSource(p, 'inspection')).length
    }
  }, [displayedParcels, ownerParcelAins])

  const datasetTotals = useMemo(() => {
    const totals: Record<string, number> = {}
    for (const step of loadProgress?.steps ?? []) totals[step.datasetName] = step.rowCount
    return totals
  }, [loadProgress])

  const totalParcelUniverse = datasetTotals['LA County Assessor Parcels'] ?? result?.totalFound ?? 0
  const loadedRecordCount = result?.returnedCount ?? displayedParcels.length

  // Max value for bar normalization
  const maxTotalValue = useMemo(() => {
    if (!displayedParcels.length) return 1
    return Math.max(...displayedParcels.map(p => p.totalValue), 1)
  }, [displayedParcels])

  // Select handler
  const handleSelectParcel = useCallback((parcel: ParcelRecord) => {
    setSelectedParcel(parcel)
    setSelectedParcelIds(new Set(parcelRecordKeys(parcel)))
    const el = document.getElementById(`card-${parcel.assessorId}`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }, [])

  const handleBuildRunComplete = useCallback((run: BuildRunOutput) => {
    setBuildRuns(prev => [run, ...prev.filter(item => item.runId !== run.runId)].slice(0, 25))
    setIs3D(true)
  }, [])

  const handleSelectOwner = useCallback(async (ownerName: string) => {
    setSelectedOwnerName(ownerName)
    setShowAnalytics(false)
    try {
      if (!api) throw new Error('RentSeeker desktop API is unavailable')
      const portfolio = await api.getOwnerPortfolio(ownerName, 1000)
      const ains = new Set(portfolio.parcels.map((parcel) => parcel.ain).filter(Boolean))
      setOwnerParcelAins(ains)
      const coords = portfolio.parcels
        .map((p) => ({ lat: p.latitude, lng: p.longitude }))
        .filter((p) => typeof p.lat === 'number' && typeof p.lng === 'number' && p.lat !== 0 && p.lng !== 0)
      if (mapInstance && coords.length >= 2) {
        const bounds = new maplibregl.LngLatBounds()
        coords.forEach((p) => bounds.extend([p.lng!, p.lat!]))
        if (!bounds.isEmpty()) {
          mapInstance.fitBounds(bounds, { padding: 92, maxZoom: 14, duration: 900 })
        }
      } else if (mapInstance && coords.length === 1) {
        mapInstance.flyTo({ center: [coords[0].lng!, coords[0].lat!], zoom: Math.max(mapInstance.getZoom(), 13), duration: 900 })
      }
    } catch {
      setOwnerParcelAins(new Set())
    }
  }, [api, mapInstance])

  const assemblyAllDone = useMemo(() => {
    const essential = new Set(['Basemap', 'Parcel Boundary Lines', 'Parcel Records', 'Owner Index (SBF)'])
    const essentialDone = assemblySteps
      .filter(step => essential.has(step.datasetName))
      .every(step => step.status === 'done' || step.status === 'error')
    return essentialDone
  }, [assemblySteps])

  useEffect(() => {
    if (!assemblyAllDone) return
    const panels = assemblySteps.find(step => step.datasetName === 'Panels')
    if (panels && panels.status === 'done') return
    markAssembly('Panels', { status: 'done' })
    // Fade out the assembly overlay quickly once the surface is genuinely ready.
    window.setTimeout(() => setAssembling(false), 280)
  }, [assemblyAllDone, assemblySteps, markAssembly])

  /* ---------- ERROR ---------- */
  if (error && !loading) {
    return (
      <div className="parcel-explorer">
        <div className="pe-error">
          <div className="pe-error-icon">⚠</div>
          <h2>Query Failed</h2>
          <p>{error}</p>
          <button className="pe-error-retry" onClick={() => loadData(filter)}>RETRY QUERY</button>
        </div>
      </div>
    )
  }

  /* ---------- MAIN LAYOUT ---------- */
  return (
    <div
      className={`parcel-explorer ${dropActive ? 'drop-active' : ''} ${importingData ? 'importing-data' : ''}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="pe-ambient-grid" />

      {/* Custom Cursor */}
      <div className="pe-cursor-dot" ref={dotRef} />
      <div className={`pe-cursor-ring ${hovering ? 'hovering' : ''}`} ref={ringRef} />

      {/* HEADER */}
      <div className="pe-header">
        <div className="pe-header-brand">
          <div className="pe-header-logo">GF</div>
          <div className="pe-header-title">
            Rent<span>Seeker</span>
          </div>
        </div>
        <div className="pe-header-center">
          <input
            className="pe-search-input"
            placeholder="Filter by APN, address, legal description..."
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
          />
        </div>
        <div className="pe-header-status">
          <div className="pe-status-pill">
            <div className="pe-status-dot" />
            Total parcels indexed: {formatCompact(totalParcelUniverse)}
          </div>
          <div className="pe-status-pill">
            <div className="pe-status-dot" />
            Visible parcel lines: {visibleBoundaryCount.toLocaleString()}
          </div>
          {boundaryRefreshState !== 'idle' && (
            <div className="pe-time-pill">
              Parcel lines refreshing · {boundaryRefreshState}
            </div>
          )}
          {pmtilesStats && (
            <div className="pe-time-pill">
              PMTiles: {pmtilesStats.tiles.toLocaleString()} tiles · {(pmtilesStats.totalMs / Math.max(1, pmtilesStats.tiles)).toFixed(0)}ms avg
            </div>
          )}
          {pmtilesStatsDetailed && (
            <div className="pe-time-pill">
              PMTiles I/O: {Number(pmtilesStatsDetailed.avgIoMs ?? 0).toFixed(0)}ms · gunzip: {Number(pmtilesStatsDetailed.avgGunzipMs ?? 0).toFixed(0)}ms · cache: {Number(pmtilesStatsDetailed.cacheHitPct ?? 0).toFixed(0)}% · p95: {Number(pmtilesStatsDetailed.p95TotalMs ?? 0).toFixed(0)}ms
            </div>
          )}
          {result && (
            <div className="pe-time-pill">
              Loaded parcel records: {loadedRecordCount.toLocaleString()} · {result.queryTimeMs}ms
            </div>
          )}
          {importingData && (
            <div className="pe-time-pill warning">
              Importing folder data…
            </div>
          )}
          {!boundaryComplete && (
            <div className="pe-time-pill warning">
              {renderedBoundaryCount.toLocaleString()} rendered
            </div>
          )}
        </div>
        <div className="pe-header-right">
          <button
            className={`pe-folder-toggle ${dropActive ? 'active' : ''}`}
            onClick={() => void pickImportFolder()}
            title="Add data folder"
          >
            FOLDER
          </button>
          <button
            className={`pe-visual-toggle ${showVisualSettings ? 'active' : ''}`}
            onClick={() => setShowVisualSettings(current => !current)}
            title="Visual settings"
          >
            VIS
          </button>
          <button
            className={`pe-propstream-toggle ${showPropstreamGrid ? 'active' : ''}`}
            onClick={() => setShowPropstreamGrid(current => !current)}
            title="PropStream grid"
          >
            PROP
          </button>
          <AnalyticsToggleButton active={showAnalytics} onToggle={() => setShowAnalytics(!showAnalytics)} />
          <BuildToggleButton active={showBuild} onToggle={() => setShowBuild(!showBuild)} />
          <SunToggleButton active={showSun} onToggle={() => setShowSun(!showSun)} />
          <ViewToggleButton active={showView} onToggle={() => setShowView(!showView)} />
          <ClayModeToggle clayMode={clayMode} onToggle={() => setClayMode(!clayMode)} visible={is3D} />
          <Toggle3DButton enabled={is3D} onToggle={() => setIs3D(!is3D)} />
        </div>
      </div>

      {showVisualSettings && (
        <VisualSettingsMenu
          settings={visualSettings}
          onChange={setVisualSettings}
        onClose={() => setShowVisualSettings(false)}
        pmtilesInfo={pmtilesInfo}
        pmtilesSourceLayer={pmtilesSourceLayer}
        pmtilesReady={pmtilesReady}
        sourceBlobStats={sourceBlobStats}
      />
      )}

      {/* FILTER BAR (below header) */}
      <FilterBar
        filter={filter}
        onFilterChange={handleFilterChange}
        onDrawBoundary={() => setIsDrawing(!isDrawing)}
        isDrawing={isDrawing}
        resultCount={result?.totalFound ?? 0}
        queryTimeMs={result?.queryTimeMs ?? 0}
      />

      {/* DATASET LEGEND (top right, floats over map) */}
      <DatasetLegend
        showCofO={showCofO}
        onToggleCofO={handleToggleCofO}
        showBuilding={showBuildingPermits}
        onToggleBuilding={(v) => { setShowBuildingPermits(v); reloadWithDatasetToggles({ includeBuildingPermits: v }) }}
        showElectrical={showElectricalPermits}
        onToggleElectrical={(v) => { setShowElectricalPermits(v); reloadWithDatasetToggles({ includeElectricalPermits: v }) }}
        showSubmitted={showSubmittedPermits}
        onToggleSubmitted={(v) => { setShowSubmittedPermits(v); reloadWithDatasetToggles({ includeSubmittedPermits: v }) }}
        showInspections={showInspections}
        onToggleInspections={(v) => { setShowInspections(v); reloadWithDatasetToggles({ includeInspections: v }) }}
        showPolygons={showPolygons}
        onTogglePolygons={setShowPolygons}
        parcelCount={datasetCounts.parcel}
        ownerCount={datasetCounts.owner}
        cofOCount={datasetCounts.cofo}
        bothCount={datasetCounts.both}
        buildingPermitCount={datasetCounts.buildingPermit}
        electricalPermitCount={datasetCounts.electricalPermit}
        submittedPermitCount={datasetCounts.submittedPermit}
        inspectionCount={datasetCounts.inspection}
        datasetTotals={datasetTotals}
        manifestSteps={loadProgress?.steps ?? []}
      />

      <FactSourceManifestPanel entries={factSourceManifest} />

      {/* MAP (main area) */}
      <MapView
        parcels={displayedParcels}
        targetIds={targetIds}
        ownerAins={ownerParcelAins}
        heatCells={heatCells}
        selectedParcelIds={selectedParcelIds}
        showPolygons={showPolygons}
        visualSettings={visualSettings}
        selectedParcel={selectedParcel}
        terrainMetrics={terrainMetrics}
        topoOverlayData={topoOverlayData}
        onSelectParcel={handleSelectParcel}
        onSelectParcelByKey={handleSelectParcelByKey}
        isDrawing={isDrawing}
        onGroupSelect={handleGroupSelect}
        onViewportChange={refreshViewportRecords}
        onBoundaryStats={handleBoundaryStats}
        onBoundaryRefreshStateChange={setBoundaryRefreshState}
        onMapReady={setMapInstance}
        onBasemapReady={() => {
          markAssembly('Basemap', { status: 'done' })
          if (startupModeRef.current !== 'default') {
            markAssembly('Parcel Boundary Lines', { status: 'done', rowCount: 0 })
            markAssembly('Parcel Records', { status: 'done', rowCount: 0 })
            markAssembly('Owner Index (SBF)', { status: 'done', rowCount: 0 })
            markAssembly('Panels', { status: 'done', rowCount: 0 })
            setRuntimeGateStage('done')
            return
          }
          markAssembly('Parcel Boundary Lines', { status: 'loading' })
          setPmtilesReady(false)
          setRuntimeGateStage('boundaries')
        }}
        onBoundariesReady={() => {
          // First tile served. Do not mark "ready" until we can see rendered boundaries in the viewport.
          setPmtilesReady(true)
        }}
      />

      {startupMode !== 'default' && displayedParcels.length === 0 && !assembling && (
        <EmptyWorkspacePanel
          importingData={importingData}
          onChooseSources={() => void handleChooseStartupSources()}
          onLoadDefault={handleLoadDefaultStartup}
        />
      )}

      <SelectionGroupPanel
        polygons={selectedGroupPolygons}
        selectedIds={selectedParcelIds}
        records={displayedParcels}
        onActivate={handleSelectParcelByKey}
        onClear={clearGroupSelection}
      />

      {/* BOTTOM BAR */}
      <div className="pe-bottom-bar">
        <div className="pe-bottom-bar-header">
          <div className="pe-bottom-bar-title">Parcel Conveyor</div>
          <div className="pe-bottom-bar-count">
            Loaded parcel records: {loadedRecordCount.toLocaleString()}
          </div>
        </div>
        <div className="pe-bottom-scroll-area">
          {displayedParcels.map((parcel, index) => (
            <div key={parcel.assessorId} id={`card-${parcel.assessorId}`}>
              <ParcelCard
                parcel={parcel}
                isTarget={targetIds.includes(parcel.assessorId)}
                isSelected={parcel.assessorId === selectedParcel?.assessorId || parcelRecordKeys(parcel).some(key => selectedParcelIds.has(key))}
                isOwnerParcel={ownerParcelAins.has(parcel.ain)}
                index={index}
                maxTotalValue={maxTotalValue}
                onSelect={handleSelectParcel}
                onMouseEnter={() => setHovering(true)}
                onMouseLeave={() => setHovering(false)}
              />
            </div>
          ))}
        </div>
      </div>

      {/* DOSSIER SIDEBAR */}
      <DossierPanel parcel={selectedParcel} onSelectOwner={handleSelectOwner} dossierProvenance={dossierProvenance} />

      {assembling && (
        <LoadingCinema
          steps={sequentializedSteps}
          assembling
          onLoadDefault={handleLoadDefaultStartup}
          onStartEmpty={handleStartEmpty}
          onChooseSources={() => void handleChooseStartupSources()}
          startupMode={startupMode}
          startupActionPending={startupActionPending}
        />
      )}

      <PropstreamGridPanel
        api={api}
        visible={showPropstreamGrid}
        onClose={() => setShowPropstreamGrid(false)}
      />

      <AnalyticsSuite
        visible={showAnalytics}
        onClose={() => setShowAnalytics(false)}
        onSelectOwner={handleSelectOwner}
      />

      {selectedOwnerName && ownerParcelAins.size > 0 && (
        <div className="pe-owner-selection-badge">
          Owner focus: {selectedOwnerName} · {ownerParcelAins.size} parcels
          <button onClick={() => { setSelectedOwnerName(null); setOwnerParcelAins(new Set()) }}>Clear</button>
        </div>
      )}

      {/* TERRAIN METRICS in dossier (if available) */}
      {terrainMetrics && selectedParcel && (
        <div className="pe-terrain-badge">
          <span className="pe-terrain-slope">{terrainMetrics.bestFitSlopePct.toFixed(1)}% slope</span>
          <span className="pe-terrain-relief">{terrainMetrics.demRelief.toFixed(0)}ft relief</span>
          <span className="pe-terrain-aspect">{terrainMetrics.aspectDeg.toFixed(0)}° aspect</span>
        </div>
      )}
      {!terrainMetrics && selectedParcel && terrainStatus && terrainStatus.computed === false && (
        <div className="pe-terrain-badge warning">
          <span className="pe-terrain-slope">Terrain: not computed</span>
          <span className="pe-terrain-relief">{terrainStatus.reason ?? 'Unavailable'}</span>
        </div>
      )}

      {selectedParcel && (
        <div className="pe-feature-dock">
          <button className={is3D ? 'active' : ''} onClick={() => setIs3D(current => !current)}>3D</button>
          <button
            className={visualSettings.showTopoOverlay ? 'active' : ''}
            onClick={() => setVisualSettings(current => ({ ...current, showTopoOverlay: !current.showTopoOverlay }))}
          >
            TOPO
          </button>
          <button className={showBuild ? 'active' : ''} onClick={() => setShowBuild(current => !current)}>BUILD</button>
          <button className={showSun ? 'active' : ''} onClick={() => setShowSun(current => !current)}>SUN</button>
          <button className={showView ? 'active' : ''} onClick={() => setShowView(current => !current)}>VIEW</button>
        </div>
      )}

      {/* SUN SIMULATOR OVERLAY */}
      <SunOverlay
        parcelId={selectedParcel?.assessorId ?? null}
        lat={selectedParcel?.latitude ?? null}
        lng={selectedParcel?.longitude ?? null}
        parcelGeometry={selectedParcelGeometry}
        visible={showSun}
        onClose={() => setShowSun(false)}
      />

      {/* VIEW ANALYSIS OVERLAY */}
      <ViewOverlay
        parcelId={selectedParcel?.assessorId ?? null}
        lat={selectedParcel?.latitude ?? null}
        lng={selectedParcel?.longitude ?? null}
        parcelGeometry={selectedParcelGeometry}
        visible={showView}
        onClose={() => setShowView(false)}
      />

      {/* BUILD SIMULATOR PANEL */}
      <BuildPanel
        parcelId={selectedParcel?.assessorId ?? null}
        lat={selectedParcel?.latitude ?? null}
        lng={selectedParcel?.longitude ?? null}
        useCode={selectedParcel?.propertyUseCode ?? null}
        squareFootage={selectedParcel?.squareFootage ?? null}
        terrainMetrics={terrainMetrics}
        parcelGeometry={selectedParcelGeometry}
        visible={showBuild}
        onClose={() => setShowBuild(false)}
        onRunComplete={handleBuildRunComplete}
      />

      {/* SLOPE TOOLTIP (3D hover) */}
      {is3D && <SlopeTooltip slopeDeg={slopeHover.deg} position={slopeHover.pos} />}

      {/* Confirmation Modal */}
      {pendingCount != null && (
        <ConfirmModal
          count={pendingCount}
          onConfirm={confirmLargeQuery}
          onCancel={() => { setPendingCount(null); setPendingFilter(null) }}
        />
      )}
    </div>
  )
}
