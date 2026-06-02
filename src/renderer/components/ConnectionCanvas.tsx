import { useEffect, useMemo, useRef, useState } from 'react'
import type { Map as MapLibreMap, StyleSpecification } from 'maplibre-gl'
import maplibregl from 'maplibre-gl'

import type { ConnectionGraph } from '@shared/types'
import { buildSpatialCollections } from '@renderer/lib/workbench'

// deck.gl loaded from CDN at runtime (to avoid vite 8/rolldown MISSING_EXPORT errors)
const DECKGL_CDN = 'https://unpkg.com/deck.gl@9.0.38/dist.min.js'
let deckLoadPromise: Promise<boolean> | null = null
function loadDeckGL(): Promise<boolean> {
  if (deckLoadPromise) return deckLoadPromise
  if ((window as any).deck) return Promise.resolve(true)
  deckLoadPromise = new Promise((resolve) => {
    const script = document.createElement('script')
    script.src = DECKGL_CDN
    script.async = true
    script.onload = () => resolve(true)
    script.onerror = () => resolve(false)
    document.head.appendChild(script)
  })
  return deckLoadPromise
}

const LOCAL_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [
    {
      id: 'background',
      type: 'background',
      paint: {
        'background-color': '#08111a'
      }
    }
  ]
}

interface ConnectionCanvasProps {
  graph: ConnectionGraph
  selectedId?: string
  onSelect: (nodeId: string) => void
}

function useNodePositions(graph: ConnectionGraph) {
  return useMemo(() => {
    const positions = new Map<string, { x: number; y: number }>()
    if (graph.nodes.length === 0) {
      return positions
    }

    if (graph.focusId) {
      positions.set(graph.focusId, { x: 50, y: 50 })
      const orbiters = graph.nodes.filter((node) => node.id !== graph.focusId)
      orbiters.forEach((node, index) => {
        const angle = (Math.PI * 2 * index) / Math.max(1, orbiters.length)
        const radius = 26 + (index % 2) * 8
        positions.set(node.id, {
          x: 50 + Math.cos(angle) * radius,
          y: 50 + Math.sin(angle) * radius
        })
      })
      return positions
    }

    graph.nodes.forEach((node, index) => {
      const column = index % 3
      const row = Math.floor(index / 3)
      positions.set(node.id, {
        x: 22 + column * 28,
        y: 24 + row * 24
      })
    })
    return positions
  }, [graph])
}

function SpatialLens({
  graph,
  selectedId,
  onSelect
}: {
  graph: ConnectionGraph
  selectedId?: string
  onSelect: (nodeId: string) => void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const overlayRef = useRef<any>(null)
  const { pointFeatures, lineFeatures, nodeData, arcData } = useMemo(
    () => buildSpatialCollections(graph, selectedId),
    [graph, selectedId]
  )
  const spatialNodes = pointFeatures.features.length

  useEffect(() => {
    if (!containerRef.current || mapRef.current) {
      return
    }

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: LOCAL_STYLE,
      center: [-118.2437, 34.0522],
      zoom: 9.5,
      attributionControl: false
    })
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    const initDeck = async () => {
      const loaded = await loadDeckGL()
      if (!loaded || !(window as any).deck) return
      const deckgl = (window as any).deck
      const overlay = new deckgl.MapboxOverlay({
        interleaved: false,
        layers: []
      })
      map.addControl(overlay)
      overlayRef.current = overlay
    }
    void initDeck()

    mapRef.current = map

    return () => {
      overlayRef.current?.finalize?.()
      overlayRef.current = null
      map.remove()
      mapRef.current = null
    }
  }, [onSelect])

  useEffect(() => {
    const overlay = overlayRef.current
    if (!overlay) {
      return
    }

    overlay.setProps({
      getCursor: ({ isHovering }: any) => (isHovering ? 'pointer' : 'grab'),
      layers: [
        new ((window as any).deck.ArcLayer)({
          id: 'spatial-arc-layer',
          data: arcData,
          pickable: false,
          getSourcePosition: (item: any) => item.sourcePosition,
          getTargetPosition: (item: any) => item.targetPosition,
          getWidth: (item: any) => Math.max(1, item.strength * 1.4),
          getSourceColor: [255, 138, 61, 150],
          getTargetColor: [115, 194, 251, 180],
          greatCircle: false
        }),
        new ((window as any).deck.ScatterplotLayer)({
          id: 'spatial-node-layer',
          data: nodeData,
          pickable: true,
          stroked: true,
          filled: true,
          radiusUnits: 'pixels',
          getPosition: (item: any) => item.position,
          getRadius: (item: any) => 8 + Math.min(14, item.weight),
          getFillColor: (item: any) => (item.selected ? [255, 207, 92, 230] : [115, 194, 251, 210]),
          getLineColor: [8, 17, 26, 255],
          getLineWidth: 2,
          onClick: (info: any) => {
            if (info.object) {
              onSelect((info.object as { id: string }).id)
            }
          }
        })
      ]
    })
  }, [arcData, nodeData, onSelect])

  useEffect(() => {
    const map = mapRef.current
    if (!map) {
      return
    }

    if (pointFeatures.features.length === 0) {
      return
    }

    const bounds = new maplibregl.LngLatBounds()
    pointFeatures.features.forEach((feature) => {
      bounds.extend(feature.geometry.coordinates as [number, number])
    })

    if (!bounds.isEmpty()) {
      map.fitBounds(bounds, {
        padding: 72,
        maxZoom: pointFeatures.features.length === 1 ? 15 : 12,
        duration: 450
      })
    }
  }, [lineFeatures, pointFeatures])

  useEffect(() => {
    mapRef.current?.resize()
  }, [graph.title])

  return (
    <div className="spatial-shell">
      <div ref={containerRef} className="spatial-map" />
      <div className="spatial-overlay">
        <div className="spatial-overlay-card">
          <span>Spatial Lens</span>
          {spatialNodes > 0 ? (
            <p>
              {spatialNodes} geocoded nodes are active. This view is already using MapLibre and is
              wired for PMTiles-backed parcel or zoning layers as those datasets land.
            </p>
          ) : (
            <p>
              No usable coordinates are present in this selection yet. Upload parcel extracts or
              geocoded rows to light up the spatial surface.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

export function ConnectionCanvas({ graph, selectedId, onSelect }: ConnectionCanvasProps) {
  const [mode, setMode] = useState<'network' | 'spatial'>('network')
  const positions = useNodePositions(graph)
  const spatialNodeCount = graph.nodes.filter((node) => node.lat !== null && node.lng !== null).length

  return (
    <section className="glass-panel connection-panel">
      <div className="panel-header">
        <div>
          <div className="panel-kicker">Connection Workspace</div>
          <h3>{graph.title}</h3>
        </div>
        <div className="segmented-control">
          <button className={mode === 'network' ? 'active' : ''} onClick={() => setMode('network')}>
            Network
          </button>
          <button className={mode === 'spatial' ? 'active' : ''} onClick={() => setMode('spatial')}>
            Spatial
          </button>
        </div>
      </div>

      <div className="connection-stats">
        <div className="connection-stat">
          <span>Nodes</span>
          <strong>{graph.nodes.length}</strong>
        </div>
        <div className="connection-stat">
          <span>Edges</span>
          <strong>{graph.edges.length}</strong>
        </div>
        <div className="connection-stat">
          <span>Spatial</span>
          <strong>{spatialNodeCount}</strong>
        </div>
      </div>

      {mode === 'network' ? (
        <div className="connection-canvas">
          <svg className="connection-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
            {graph.edges.map((edge) => {
              const source = positions.get(edge.source)
              const target = positions.get(edge.target)
              if (!source || !target) {
                return null
              }
              return (
                <line
                  key={edge.id}
                  x1={source.x}
                  y1={source.y}
                  x2={target.x}
                  y2={target.y}
                  stroke={`rgba(255, 138, 61, ${Math.min(0.65, 0.16 + edge.strength * 0.06)})`}
                  strokeWidth={0.35 + Math.min(1.8, edge.strength * 0.08)}
                />
              )
            })}
          </svg>

          {graph.nodes.map((node) => {
            const position = positions.get(node.id)
            if (!position) {
              return null
            }
            return (
              <button
                key={node.id}
                className={`connection-node ${selectedId === node.id ? 'selected' : ''}`}
                style={{
                  left: `${position.x}%`,
                  top: `${position.y}%`
                }}
                onClick={() => onSelect(node.id)}
              >
                <span>{node.label}</span>
                <small>{node.subtitle ?? node.nodeType}</small>
                <strong>{node.weight}</strong>
              </button>
            )
          })}
        </div>
      ) : (
        <SpatialLens graph={graph} selectedId={selectedId} onSelect={onSelect} />
      )}
    </section>
  )
}
