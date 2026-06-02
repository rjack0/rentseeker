/**
 * Deck3DOverlay — Google Photorealistic 3D Tiles + Analysis Features
 *
 * Uses deck.gl interleaved with MapLibre via MapboxOverlay.
 *
 * Implements:
 *   - Tile3DLayer with refineStrategy: REPLACE, high pointBudget
 *   - Clay/texture mode toggle
 *   - Selected parcel glow in 3D (polygon-first, centroid fallback)
 *   - Build-run massing visualization (from persisted outputs)
 *
 * Notes:
 * - Slope-on-hover is best-effort: picked normals are not always exposed.
 */

import { useEffect, useRef, useCallback, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import type { Geometry } from 'geojson'
import type { BuildRunOutput, SunAnalysis } from '@shared/types'
import { MapboxOverlay } from '@deck.gl/mapbox'
import { Tile3DLayer } from '@deck.gl/geo-layers'
import { PolygonLayer, ScatterplotLayer } from '@deck.gl/layers'

/* ═══════════════ CONFIG ═══════════════ */

const GOOGLE_API_KEY = 'AIzaSyBLdVBeMnUEkSEO7fzA9tkr8h6MTEikDAE'
const TILES_ROOT = `https://tile.googleapis.com/v1/3dtiles/root.json?key=${GOOGLE_API_KEY}`

// Budget cap: max tile requests per session
const MAX_TILE_REQUESTS = 8000
let tileRequestCount = 0

/* ═══════════════ HOOK ═══════════════ */

interface UseDeck3DOptions {
  map: maplibregl.Map | null
  enabled: boolean
  clayMode?: boolean
  selectedParcelLngLat?: [number, number] | null
  selectedParcelGeometry?: Geometry | null
  buildRuns?: BuildRunOutput[]
  sunAnalysis?: SunAnalysis | null
  shadowHeightFt?: number
  onSlopeHover?: (slopeDeg: number | null, position: { x: number; y: number } | null) => void
}

export function useDeck3DOverlay({
  map,
  enabled,
  clayMode = false,
  selectedParcelLngLat,
  selectedParcelGeometry,
  buildRuns = [],
  sunAnalysis,
  shadowHeightFt = 20,
  onSlopeHover
}: UseDeck3DOptions) {
  const overlayRef = useRef<MapboxOverlay | null>(null)
  const wasEnabled = useRef(false)
  const prevClayMode = useRef(clayMode)
  const [deckReady, setDeckReady] = useState(false)
  const slopeReqRef = useRef<{ id: number; t: number } | null>(null)
  const onSlopeHoverRef = useRef(onSlopeHover)

  useEffect(() => {
    onSlopeHoverRef.current = onSlopeHover
  }, [onSlopeHover])

  const buildLayers = useCallback(() => {
    const layers: any[] = []

    layers.push(new Tile3DLayer({
      id: 'google-3d-tiles',
      data: TILES_ROOT,
      // Per 3DBuild.md: REPLACE strategy prevents low-res/high-res ghosting
      // pointBudget forces browser to keep high-res tiles in memory
      refineStrategy: 'REPLACE',
      pointBudget: 3500000,
      loadOptions: {
        '3d-tiles': {
          loadGLTF: true,
          decodeQuantizedPositions: true,
          maxDetail: true
        }
      },
      beforeId: 'parcel-boundaries-line',
      onTileLoad: (tile: any) => {
        tileRequestCount++
        if (tileRequestCount >= MAX_TILE_REQUESTS) {
          console.warn(`[Deck3D] Budget exhausted (${MAX_TILE_REQUESTS}).`)
        }

        // Clay mode: strip textures from loaded tiles
        if (clayMode && tile?.content?.gltf) {
          try {
            const materials = tile.content.gltf.materials || []
            for (const mat of materials) {
              if (mat.pbrMetallicRoughness) {
                mat.pbrMetallicRoughness.baseColorTexture = undefined
                mat.pbrMetallicRoughness.baseColorFactor = [0.75, 0.75, 0.75, 1.0]
                mat.pbrMetallicRoughness.metallicFactor = 0.1
                mat.pbrMetallicRoughness.roughnessFactor = 0.8
              }
            }
          } catch {
            // Silently skip if material manipulation fails
          }
        }
      },
      onTileError: (_tile: any, error: any) => {
        console.debug('[Deck3D] Tile error:', error?.message || error)
      },
      opacity: 0.92,
      pointSize: 1.5,
      pickable: true,
      // Slope-on-hover: read the surface normal under the cursor
      onHover: (info: any) => {
        const onSlopeHoverCurrent = onSlopeHoverRef.current
        if (!onSlopeHoverCurrent) return
        if (info?.object && info.coordinate) {
          const [lng, lat] = info.coordinate as [number, number]
          onSlopeHoverCurrent(null, { x: info.x, y: info.y })
          const now = Date.now()
          const prev = slopeReqRef.current
          if (prev && now - prev.t < 250) return
          const id = (prev?.id ?? 0) + 1
          slopeReqRef.current = { id, t: now }
          const api = (window as any).rentSeeker
          api?.getSlopeAtPoint?.(lat, lng)
            .then((resp: any) => {
              if (slopeReqRef.current?.id !== id) return
              const deg = Number(resp?.slopeDeg)
              if (!Number.isFinite(deg)) return
              onSlopeHoverCurrent(deg, { x: info.x, y: info.y })
            })
            .catch(() => undefined)
        } else {
          onSlopeHoverCurrent(null, null)
        }
      }
    }))

    // Selected parcel glow (polygon-first, centroid fallback)
    if (selectedParcelGeometry) {
      const asPolygons: Array<number[][]> = []
      if (selectedParcelGeometry.type === 'Polygon') {
        const ring = (selectedParcelGeometry.coordinates?.[0] ?? []) as any
        asPolygons.push(ring.map(([lng, lat]: any) => [lng, lat]))
      } else if (selectedParcelGeometry.type === 'MultiPolygon') {
        for (const poly of selectedParcelGeometry.coordinates ?? []) {
          const ring = (poly?.[0] ?? []) as any
          asPolygons.push(ring.map(([lng, lat]: any) => [lng, lat]))
        }
      }
      if (asPolygons.length > 0) {
        layers.push(new PolygonLayer({
          id: 'selected-parcel-glow-3d',
          data: asPolygons.map((coords) => ({ coords })),
          getPolygon: (d: any) => d.coords,
          stroked: true,
          filled: true,
          getFillColor: [0, 255, 200, 70],
          getLineColor: [171, 255, 2, 255],
          getLineWidth: 3,
          lineWidthUnits: 'meters',
          extruded: false,
          pickable: false,
          beforeId: 'parcel-boundaries-line',
          parameters: { depthTest: false }
        }))
      }
    } else if (selectedParcelLngLat) {
      layers.push(new ScatterplotLayer({
        id: 'selected-parcel-glow-3d-fallback',
        data: [{ position: [...selectedParcelLngLat, 0] }],
        getPosition: (d: any) => d.position,
        getRadius: 40,
        radiusUnits: 'meters',
        getFillColor: [0, 255, 200, 90],
        getLineColor: [171, 255, 2, 230],
        stroked: true,
        filled: true,
        getLineWidth: 2,
        lineWidthUnits: 'meters',
        beforeId: 'parcel-boundaries-line',
        parameters: { depthTest: false }
      }))
    }

    // Sun shadows v1: project a simple ground shadow from the selected parcel polygon.
    // This is real math using the cached SunAnalysis; it does not claim a full shadow map.
    if (sunAnalysis && selectedParcelGeometry) {
      const noon = sunAnalysis.sunPath.find(p => p.hour === 12 && p.minute === 0)
        ?? [...sunAnalysis.sunPath].sort((a, b) => b.altitudeDeg - a.altitudeDeg)[0]
      if (noon && noon.altitudeDeg > 2) {
        const altRad = (noon.altitudeDeg * Math.PI) / 180
        const azRad = (((noon.azimuthDeg + 180) % 360) * Math.PI) / 180 // cast away from the sun
        const heightM = shadowHeightFt * 0.3048
        const shadowLenM = heightM / Math.tan(altRad)
        const dxE = Math.sin(azRad) * shadowLenM
        const dyN = Math.cos(azRad) * shadowLenM

        // Convert meters to degrees around the parcel latitude.
        const lat0 = sunAnalysis.latitude
        const mPerDegLat = 111320
        const mPerDegLng = 111320 * Math.cos((lat0 * Math.PI) / 180)
        const dLng = mPerDegLng ? dxE / mPerDegLng : 0
        const dLat = dyN / mPerDegLat

        const extractRings = (): number[][][] => {
          const rings: number[][][] = []
          if (selectedParcelGeometry.type === 'Polygon') {
            const ring = (selectedParcelGeometry.coordinates?.[0] ?? []) as any
            rings.push(ring.map(([lng, lat]: any) => [lng, lat]))
          } else if (selectedParcelGeometry.type === 'MultiPolygon') {
            for (const poly of selectedParcelGeometry.coordinates ?? []) {
              const ring = (poly?.[0] ?? []) as any
              rings.push(ring.map(([lng, lat]: any) => [lng, lat]))
            }
          }
          return rings
        }

        const rings = extractRings()
        const shadowPolys = rings
          .filter((r) => r.length >= 3)
          .map((r) => {
            const shifted = r.map(([lng, lat]) => [lng + dLng, lat + dLat])
            // Bridge polygon between original and shifted (simple quad-strip fill).
            const bridge = [...r, ...shifted.slice().reverse()]
            return [{ coords: shifted }, { coords: bridge }]
          })
          .flat()

        if (shadowPolys.length > 0) {
          layers.push(new PolygonLayer({
            id: 'selected-parcel-shadow-v1',
            data: shadowPolys,
            getPolygon: (d: any) => d.coords,
            stroked: false,
            filled: true,
            extruded: false,
            getFillColor: [0, 0, 0, 64],
            pickable: false,
            beforeId: 'parcel-boundaries-line',
            parameters: { depthTest: false }
          }))
        }
      }
    }

    // Build-run massing/footprints (from persisted outputs)
    if (buildRuns.length > 0) {
      layers.push(new PolygonLayer({
        id: 'build-simulation-footprints',
        data: buildRuns,
        getPolygon: (d: BuildRunOutput) => d.foundationSkirt.vertices.map(([lng, lat]) => [lng, lat]),
        getFillColor: (d: BuildRunOutput) => d.fitScore >= 75 ? [0, 255, 200, 90] : d.fitScore >= 50 ? [255, 207, 92, 90] : [255, 107, 107, 90],
        getLineColor: [255, 255, 255, 220],
        getLineWidth: 2,
        lineWidthUnits: 'meters',
        extruded: true,
        getElevation: (d: BuildRunOutput) => d.buildingHeightFt * 0.3048,
        wireframe: true,
        pickable: true,
        beforeId: 'parcel-boundaries-line',
        parameters: { depthTest: true }
      }))
    }

    return layers
  }, [buildRuns, clayMode, selectedParcelGeometry, selectedParcelLngLat, sunAnalysis, shadowHeightFt])

  // Activate 3D mode
  const activate3D = useCallback(async () => {
    if (!map) return

    // Pitch the camera for 3D perspective
    map.easeTo({
      pitch: 60,
      bearing: map.getBearing(),
      duration: 1000
    })

    // Create deck.gl overlay if not exists.
    if (!overlayRef.current) {
      const overlay = new MapboxOverlay({
        interleaved: true,
        layers: []
      })
      map.addControl(overlay)
      overlayRef.current = overlay
    }
    overlayRef.current.setProps({ layers: buildLayers() })
    setDeckReady(true)
  }, [map, buildLayers])

  // Deactivate 3D mode
  const deactivate3D = useCallback(() => {
    if (!map) return

    map.easeTo({
      pitch: 0,
      duration: 800
    })

    if (overlayRef.current) {
      overlayRef.current.setProps({ layers: [] })
    }
    setDeckReady(false)
  }, [map])

  // React to enabled state changes
  useEffect(() => {
    if (enabled && !wasEnabled.current) {
      void activate3D()
    } else if (!enabled && wasEnabled.current) {
      deactivate3D()
    }
    wasEnabled.current = enabled
  }, [enabled, activate3D, deactivate3D])

  // React to clay mode / selected parcel changes while enabled
  useEffect(() => {
    if (!enabled || !deckReady || !overlayRef.current) return
    overlayRef.current.setProps({ layers: buildLayers() })
    prevClayMode.current = clayMode
  }, [enabled, deckReady, clayMode, selectedParcelLngLat, selectedParcelGeometry, buildRuns, buildLayers])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (overlayRef.current && map) {
        try {
          map.removeControl(overlayRef.current)
        } catch {
          // Map may already be destroyed
        }
        overlayRef.current = null
      }
    }
  }, [map])

  return { tileRequestCount, deckReady }
}

/* ═══════════════ 3D TOGGLE BUTTON ═══════════════ */

interface Toggle3DProps {
  enabled: boolean
  onToggle: () => void
}

export function Toggle3DButton({ enabled, onToggle }: Toggle3DProps) {
  return (
    <button
      className={`pe-3d-toggle ${enabled ? 'active' : ''}`}
      onClick={onToggle}
      title={enabled ? 'Switch to 2D' : 'Switch to 3D'}
    >
      <span className="pe-3d-toggle-label">{enabled ? '3D' : '2D'}</span>
      <span className="pe-3d-toggle-indicator" />
    </button>
  )
}

/* ═══════════════ CLAY MODE TOGGLE ═══════════════ */

interface ClayToggleProps {
  clayMode: boolean
  onToggle: () => void
  visible: boolean
}

export function ClayModeToggle({ clayMode, onToggle, visible }: ClayToggleProps) {
  if (!visible) return null
  return (
    <button
      className={`pe-clay-toggle ${clayMode ? 'active' : ''}`}
      onClick={onToggle}
      title={clayMode ? 'Show textures' : 'Clay mode (no textures)'}
    >
      <span className="pe-clay-icon">{clayMode ? '◻' : '◼'}</span>
      <span className="pe-clay-label">{clayMode ? 'CLAY' : 'PHOTO'}</span>
    </button>
  )
}

/* ═══════════════ SLOPE TOOLTIP ═══════════════ */

interface SlopeTooltipProps {
  slopeDeg: number | null
  position: { x: number; y: number } | null
}

export function SlopeTooltip({ slopeDeg, position }: SlopeTooltipProps) {
  if (slopeDeg === null || position === null) return null
  const slopePct = Math.tan(slopeDeg * (Math.PI / 180)) * 100
  return (
    <div
      className="pe-slope-tooltip"
      style={{
        left: position.x + 16,
        top: position.y - 12,
        position: 'absolute',
        pointerEvents: 'none'
      }}
    >
      <span className="pe-slope-value">{slopeDeg.toFixed(1)}°</span>
      <span className="pe-slope-pct">{slopePct.toFixed(0)}%</span>
    </div>
  )
}
