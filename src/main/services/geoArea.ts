import type { Geometry, Position } from 'geojson'

const R = 6378137 // WebMercator sphere radius (meters)
const DEG = Math.PI / 180
const SQFT_PER_M2 = 10.763910416709722

function projectWebMercator(lng: number, lat: number): { x: number; y: number } {
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat))
  const x = R * lng * DEG
  const y = R * Math.log(Math.tan(Math.PI / 4 + (clampedLat * DEG) / 2))
  return { x, y }
}

function ringAreaM2(ring: Position[]): number {
  if (ring.length < 3) return 0
  let sum = 0
  for (let i = 0; i < ring.length; i++) {
    const [lng1, lat1] = ring[i]
    const [lng2, lat2] = ring[(i + 1) % ring.length]
    const p1 = projectWebMercator(Number(lng1), Number(lat1))
    const p2 = projectWebMercator(Number(lng2), Number(lat2))
    sum += p1.x * p2.y - p2.x * p1.y
  }
  return Math.abs(sum) / 2
}

export function geometryAreaSqft(geometry: Geometry | null | undefined): number {
  if (!geometry) return 0
  if (geometry.type === 'Polygon') {
    const rings = geometry.coordinates as Position[][]
    if (!Array.isArray(rings) || rings.length === 0) return 0
    // Exterior ring minus holes (if any).
    let area = ringAreaM2(rings[0])
    for (let i = 1; i < rings.length; i++) area -= ringAreaM2(rings[i])
    return Math.max(0, area) * SQFT_PER_M2
  }
  if (geometry.type === 'MultiPolygon') {
    const polys = geometry.coordinates as Position[][][]
    let area = 0
    for (const poly of polys) {
      if (!poly?.length) continue
      area += ringAreaM2(poly[0])
      for (let i = 1; i < poly.length; i++) area -= ringAreaM2(poly[i])
    }
    return Math.max(0, area) * SQFT_PER_M2
  }
  return 0
}

export function geometryBounds(geometry: Geometry | null | undefined): { west: number; south: number; east: number; north: number } | null {
  if (!geometry) return null
  const coords: Position[] = []
  const pushRing = (ring: Position[]) => { for (const p of ring) coords.push(p) }
  if (geometry.type === 'Polygon') {
    for (const ring of geometry.coordinates as Position[][]) pushRing(ring)
  } else if (geometry.type === 'MultiPolygon') {
    for (const poly of geometry.coordinates as Position[][][]) for (const ring of poly) pushRing(ring)
  } else {
    return null
  }
  if (coords.length === 0) return null
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity
  for (const [lng, lat] of coords) {
    const x = Number(lng); const y = Number(lat)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    west = Math.min(west, x)
    east = Math.max(east, x)
    south = Math.min(south, y)
    north = Math.max(north, y)
  }
  if (!Number.isFinite(west) || !Number.isFinite(south) || !Number.isFinite(east) || !Number.isFinite(north)) return null
  return { west, south, east, north }
}

