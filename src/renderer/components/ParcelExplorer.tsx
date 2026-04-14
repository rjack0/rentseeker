/**
 * ParcelExplorer — Map-Centric Industrial Theatre
 *
 * Architecture:
 *   - Full-screen dark map (MapLibre GL + CartoDB Dark Matter tiles)
 *   - Parcel markers plotted by lat/lng with target pulse effects
 *   - Bottom horizontal strip of compact parcel cards
 *   - Right sidebar dossier panel showing full 51-column detail
 *   - Glassmorphic header with search and status
 *   - Custom cursor system
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { ParcelRecord, ParcelQueryResult } from '@shared/types'

/* ═══════════════════════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════════════════════ */

const CSV_PATH = '/Users/rjack/Desktop/almanac/Docs/Parcel_Data_0 2.csv'
const TARGET_PARCELS = '5560002009, 5560003013, 5556007007, 5556028011'
const MAX_SURROUNDING = 100

// CartoDB Dark Matter — perfect for industrial aesthetic
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

// Default center: Los Angeles
const LA_CENTER: [number, number] = [-118.25, 34.05]
const DEFAULT_ZOOM = 12

/* ═══════════════════════════════════════════════════════════
   FORMATTERS
   ═══════════════════════════════════════════════════════════ */

function formatCurrency(value: number): string {
  if (value === 0) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0
  }).format(value)
}

function formatNumber(value: number): string {
  if (value === 0) return '—'
  return new Intl.NumberFormat('en-US').format(value)
}

function formatAddress(parcel: ParcelRecord): string {
  if (parcel.propertyLocation && parcel.propertyLocation.trim()) {
    return parcel.propertyLocation
  }
  const parts = [
    parcel.addressHouseNumber,
    parcel.addressHouseNumberFraction,
    parcel.direction,
    parcel.street,
    parcel.unitNumber ? `#${parcel.unitNumber}` : '',
    parcel.city
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : 'No address on record'
}

function formatCoord(val: number | null): string {
  if (val === null || val === undefined) return '—'
  return val.toFixed(6)
}

function normalizeParcelDisplay(assessorId: string): string {
  return assessorId.replace(/-/g, ' ')
}

/* ═══════════════════════════════════════════════════════════
   COMPACT PARCEL CARD (Bottom Bar)
   ═══════════════════════════════════════════════════════════ */

interface ParcelCardProps {
  parcel: ParcelRecord
  isTarget: boolean
  isSelected: boolean
  index: number
  maxTotalValue: number
  onSelect: (parcel: ParcelRecord) => void
  onMouseEnter: () => void
  onMouseLeave: () => void
}

function ParcelCard({
  parcel, isTarget, isSelected, index, maxTotalValue,
  onSelect, onMouseEnter, onMouseLeave
}: ParcelCardProps) {
  const className = [
    'pe-card',
    isTarget ? 'target' : '',
    isSelected ? 'selected' : ''
  ].filter(Boolean).join(' ')

  const valueRatio = maxTotalValue > 0 ? parcel.totalValue / maxTotalValue : 0

  return (
    <div
      className={className}
      style={{ animationDelay: `${Math.min(index * 25, 1200)}ms` }}
      onClick={() => onSelect(parcel)}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* TOPLINE */}
      <div className="pe-card-topline">
        <div className="pe-card-id">{normalizeParcelDisplay(parcel.assessorId)}</div>
        {isTarget ? (
          <div className="pe-card-badge target-badge">TARGET</div>
        ) : (
          <div className="pe-card-badge node">NODE</div>
        )}
      </div>

      <div className="pe-card-address">{formatAddress(parcel)}</div>

      {parcel.propertyUseType && (
        <div className="pe-card-use-type">
          {parcel.propertyUseType}
          {parcel.useCode3 ? ` · ${parcel.useCode3}` : ''}
        </div>
      )}

      {/* DATA BODY */}
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
        <div className="pe-value-bar-bg">
          <div
            className="pe-value-bar-fill amber"
            style={{ transform: `scaleX(${valueRatio})` }}
          />
        </div>
      </div>

      {/* FOOTER */}
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

interface DossierPanelProps {
  parcel: ParcelRecord | null
}

function DossierPanel({ parcel }: DossierPanelProps) {
  if (!parcel) {
    return (
      <aside className="pe-dossier">
        <div className="pe-dossier-empty">
          <div className="pe-dossier-empty-icon">⌘</div>
          <h3>Parcel Dossier</h3>
          <p>
            Click any parcel marker on the map or card in the bottom
            strip to load its full dossier into this panel. All 51
            columns from the LA County Assessor dataset are displayed.
          </p>
        </div>
      </aside>
    )
  }

  return (
    <aside className="pe-dossier">
      <div className="pe-dossier-content" key={parcel.assessorId}>
        {/* Header */}
        <div className="pe-dossier-header">
          <div className="pe-dossier-kicker">Full Dossier</div>
          <h2 className="pe-dossier-title">{normalizeParcelDisplay(parcel.assessorId)}</h2>
          <div className="pe-dossier-subtitle">{formatAddress(parcel)}</div>
        </div>

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

        {/* Identity */}
        <div className="pe-dossier-section">
          <div className="pe-dossier-section-title">Identity</div>
          <DossierFact label="Assessor ID" value={parcel.assessorId} />
          <DossierFact label="AIN" value={parcel.ain} />
          <DossierFact label="Roll Year" value={String(parcel.rollYear)} />
          <DossierFact label="Row ID" value={parcel.rowId} />
          <DossierFact label="Object ID" value={parcel.objectId} />
        </div>

        {/* Location */}
        <div className="pe-dossier-section">
          <div className="pe-dossier-section-title">Location</div>
          <DossierFact label="Property Location" value={parcel.propertyLocation} />
          <DossierFact label="House #" value={parcel.addressHouseNumber} />
          <DossierFact label="Direction" value={parcel.direction} />
          <DossierFact label="Street" value={parcel.street} />
          <DossierFact label="Unit #" value={parcel.unitNumber} />
          <DossierFact label="City" value={parcel.city} />
          <DossierFact label="Zip Code" value={parcel.zipCodeFull || parcel.zipCode} />
          <DossierFact label="Latitude" value={formatCoord(parcel.latitude)} />
          <DossierFact label="Longitude" value={formatCoord(parcel.longitude)} />
        </div>

        {/* Use Classification */}
        <div className="pe-dossier-section">
          <div className="pe-dossier-section-title">Use Classification</div>
          <DossierFact label="Use Type" value={parcel.propertyUseType} />
          <DossierFact label="Use Code" value={parcel.propertyUseCode} />
          <DossierFact label="1st Digit" value={parcel.useCode1} />
          <DossierFact label="2nd Digit" value={parcel.useCode2} />
          <DossierFact label="3rd Digit" value={parcel.useCode3} />
          <DossierFact label="4th Digit" value={parcel.useCode4} />
        </div>

        {/* Structure */}
        <div className="pe-dossier-section">
          <div className="pe-dossier-section-title">Structure</div>
          <DossierFact label="# Buildings" value={String(parcel.numberOfBuildings)} />
          <DossierFact label="Year Built" value={String(parcel.yearBuilt)} />
          <DossierFact label="Effective Year" value={String(parcel.effectiveYear)} />
          <DossierFact label="Square Footage" value={formatNumber(parcel.squareFootage)} />
          <DossierFact label="Bedrooms" value={String(parcel.numberOfBedrooms)} />
          <DossierFact label="Bathrooms" value={String(parcel.numberOfBathrooms)} />
          <DossierFact label="Units" value={String(parcel.numberOfUnits)} />
        </div>

        {/* Valuation */}
        <div className="pe-dossier-section">
          <div className="pe-dossier-section-title">Valuation</div>
          <DossierFact label="Land Value" value={formatCurrency(parcel.landValue)} isCurrency />
          <DossierFact label="Land Base Year" value={String(parcel.landBaseYear)} />
          <DossierFact label="Improvement Value" value={formatCurrency(parcel.improvementValue)} isCurrency />
          <DossierFact label="Improvement Base Yr" value={String(parcel.improvementBaseYear)} />
          <DossierFact label="Land+Improvement" value={formatCurrency(parcel.totalValueLandImprovement)} isCurrency />
        </div>

        {/* Exemptions */}
        <div className="pe-dossier-section">
          <div className="pe-dossier-section-title">Exemptions</div>
          <DossierFact label="Homeowner Exempt" value={formatCurrency(parcel.homeOwnersExemption)} isCurrency />
          <DossierFact label="Real Estate Exempt" value={formatCurrency(parcel.realEstateExemption)} isCurrency />
          <DossierFact label="Fixture Value" value={formatCurrency(parcel.fixtureValue)} isCurrency />
          <DossierFact label="Fixture Exempt" value={formatCurrency(parcel.fixtureExemption)} isCurrency />
          <DossierFact label="Personal Prop Val" value={formatCurrency(parcel.personalPropertyValue)} isCurrency />
          <DossierFact label="Personal Prop Exempt" value={formatCurrency(parcel.personalPropertyExemption)} isCurrency />
        </div>

        {/* Tax Roll */}
        <div className="pe-dossier-section">
          <div className="pe-dossier-section-title">Tax Roll</div>
          <DossierFact label="Property Taxable?" value={parcel.propertyTaxable} />
          <DossierFact label="Total Value" value={formatCurrency(parcel.totalValue)} isCurrency />
          <DossierFact label="Total Exemption" value={formatCurrency(parcel.totalExemption)} isCurrency />
          <DossierFact label="Taxable Value" value={formatCurrency(parcel.taxableValue)} isCurrency />
          <DossierFact label="Recording Date" value={parcel.recordingDate} />
        </div>

        {/* Administrative */}
        <div className="pe-dossier-section">
          <div className="pe-dossier-section-title">Administrative</div>
          <DossierFact label="City Tax Rate Area" value={parcel.cityTaxRateArea} />
          <DossierFact label="Tax Rate Area Code" value={parcel.taxRateAreaCode} />
          <DossierFact label="Classification" value={parcel.classification} />
          <DossierFact label="Region #" value={parcel.regionNumber} />
          <DossierFact label="Cluster Code" value={parcel.clusterCode} />
          <DossierFact label="Legal Description" value={parcel.parcelLegalDescription} />
        </div>
      </div>
    </aside>
  )
}

function DossierFact({ label, value, isCurrency }: { label: string; value: string; isCurrency?: boolean }) {
  const displayValue = value === '0' || !value ? '—' : value
  return (
    <div className="pe-dossier-fact">
      <span className="pe-dossier-fact-key">{label}</span>
      <span className={`pe-dossier-fact-value ${isCurrency ? 'currency' : ''}`}>{displayValue}</span>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════
   CUSTOM CURSOR HOOK
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
   MAP COMPONENT
   ═══════════════════════════════════════════════════════════ */

interface MapViewProps {
  parcels: ParcelRecord[]
  targetIds: string[]
  selectedParcel: ParcelRecord | null
  onSelectParcel: (parcel: ParcelRecord) => void
}

function MapView({ parcels, targetIds, selectedParcel, onSelectParcel }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const markersRef = useRef<maplibregl.Marker[]>([])

  // Initialize map
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE as any,
      center: LA_CENTER,
      zoom: DEFAULT_ZOOM,
      attributionControl: false,
      maxZoom: 18,
      minZoom: 8
    })

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left')
    mapRef.current = map

    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  // Plot markers when parcels change
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    // Wait for map to load
    const plotMarkers = () => {
      // Clear old markers
      markersRef.current.forEach(m => m.remove())
      markersRef.current = []

      // Filter parcels with valid coords
      const geolocated = parcels.filter(
        p => p.latitude != null && p.longitude != null &&
             p.latitude !== 0 && p.longitude !== 0
      )

      if (geolocated.length === 0) return

      // Calculate bounds
      const bounds = new maplibregl.LngLatBounds()
      geolocated.forEach(p => {
        bounds.extend([p.longitude!, p.latitude!])
      })

      // Plot each parcel
      geolocated.forEach(p => {
        const isTarget = targetIds.includes(p.assessorId)
        const isSelected = selectedParcel?.assessorId === p.assessorId

        const el = document.createElement('div')
        el.className = `pe-map-marker${isTarget ? ' target' : ''}${isSelected ? ' selected' : ''}`

        // Tooltip
        const tooltip = document.createElement('div')
        tooltip.className = 'pe-map-tooltip'
        tooltip.textContent = `${p.assessorId}${p.propertyLocation ? ' — ' + p.propertyLocation : ''}`
        el.appendChild(tooltip)

        el.addEventListener('click', (e) => {
          e.stopPropagation()
          onSelectParcel(p)
        })

        const marker = new maplibregl.Marker({ element: el })
          .setLngLat([p.longitude!, p.latitude!])
          .addTo(map)

        markersRef.current.push(marker)
      })

      // Fit bounds to show all markers
      if (geolocated.length > 1) {
        map.fitBounds(bounds, { padding: 80, maxZoom: 15, duration: 1200 })
      } else {
        map.flyTo({ center: [geolocated[0].longitude!, geolocated[0].latitude!], zoom: 15, duration: 1200 })
      }
    }

    if (map.loaded()) {
      plotMarkers()
    } else {
      map.on('load', plotMarkers)
    }
  }, [parcels, targetIds, selectedParcel, onSelectParcel])

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

  const geoCount = parcels.filter(p => p.latitude != null && p.latitude !== 0).length
  const targetCount = parcels.filter(p => targetIds.includes(p.assessorId) && p.latitude != null).length

  return (
    <div className="pe-map-container" ref={containerRef}>
      <div className="pe-map-overlay">
        <div className="pe-map-stat">
          <div className="pe-map-stat-dot accent" />
          {targetCount} targets plotted
        </div>
        <div className="pe-map-stat">
          <div className="pe-map-stat-dot cyan" />
          {geoCount} parcels on map
        </div>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════
   MAIN COMPONENT — PARCEL EXPLORER
   ═══════════════════════════════════════════════════════════ */

export function ParcelExplorer() {
  const [result, setResult] = useState<ParcelQueryResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedParcel, setSelectedParcel] = useState<ParcelRecord | null>(null)
  const [searchText, setSearchText] = useState('')

  const { dotRef, ringRef, hovering, setHovering } = useCustomCursor()

  // Load data
  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await window.rentSeeker.queryParcelCsv(
        CSV_PATH,
        TARGET_PARCELS,
        MAX_SURROUNDING
      )
      setResult(data)
      if (data.targetParcels && data.targetParcels.length > 0) {
        setSelectedParcel(data.targetParcels[0])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void loadData() }, [loadData])

  // Target IDs for map markers
  const targetIds = useMemo(() => {
    if (!result?.targetParcels) return []
    return result.targetParcels.map(p => p.assessorId)
  }, [result])

  // Filtered parcels
  const filteredParcels = useMemo(() => {
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

  // Max value for bar normalization
  const maxTotalValue = useMemo(() => {
    if (!filteredParcels.length) return 1
    return Math.max(...filteredParcels.map(p => p.totalValue), 1)
  }, [filteredParcels])

  // Select handler for map
  const handleSelectParcel = useCallback((parcel: ParcelRecord) => {
    setSelectedParcel(parcel)
    // Scroll the bottom bar to show the selected card
    const el = document.getElementById(`card-${parcel.assessorId}`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }, [])

  /* ---------- LOADING ---------- */
  if (loading) {
    return (
      <div className="parcel-explorer">
        <div className="pe-ambient-grid" />
        <div className="pe-loading">
          <div className="pe-loading-spinner" />
          <div className="pe-loading-text">QUERYING 9.6M ROWS</div>
          <div className="pe-loading-subtext">
            DuckDB scanning Assessor CSV for books 5560 & 5556…
          </div>
        </div>
      </div>
    )
  }

  /* ---------- ERROR ---------- */
  if (error) {
    return (
      <div className="parcel-explorer">
        <div className="pe-ambient-grid" />
        <div className="pe-error">
          <div className="pe-error-icon">⚠</div>
          <h2>Query Failed</h2>
          <p>{error}</p>
          <button className="pe-error-retry" onClick={loadData}>RETRY QUERY</button>
        </div>
      </div>
    )
  }

  /* ---------- MAIN LAYOUT ---------- */
  return (
    <div className="parcel-explorer">
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
            placeholder="Filter by APN, address, legal description…"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
          />
        </div>
        <div className="pe-header-status">
          <div className="pe-status-pill">
            <div className="pe-status-dot" />
            {result?.totalFound ?? 0} parcels
          </div>
          {result && (
            <div className="pe-time-pill">
              Query: {result.queryTimeMs}ms
            </div>
          )}
        </div>
      </div>

      {/* MAP (main area) */}
      <MapView
        parcels={filteredParcels}
        targetIds={targetIds}
        selectedParcel={selectedParcel}
        onSelectParcel={handleSelectParcel}
      />

      {/* BOTTOM BAR */}
      <div className="pe-bottom-bar">
        <div className="pe-bottom-bar-header">
          <div className="pe-bottom-bar-title">Parcel Conveyor</div>
          <div className="pe-bottom-bar-count">{filteredParcels.length} records</div>
        </div>
        <div className="pe-bottom-scroll-area">
          {filteredParcels.map((parcel, index) => (
            <div key={parcel.assessorId} id={`card-${parcel.assessorId}`}>
              <ParcelCard
                parcel={parcel}
                isTarget={targetIds.includes(parcel.assessorId)}
                isSelected={parcel.assessorId === selectedParcel?.assessorId}
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
      <DossierPanel parcel={selectedParcel} />
    </div>
  )
}
