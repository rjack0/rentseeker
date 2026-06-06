/**
 * TerrainEngine — Computes terrain metrics per parcel
 * 
 * Uses the Google Elevation API to sample Z-heights within a parcel's
 * footprint, then calculates slope, aspect, pad candidates, and
 * retaining wall requirements.
 * 
 * For parcels with known lat/lng, creates a grid of sample points,
 * queries elevations, and computes:
 *   - Best-fit slope (plane of best fit)
 *   - Max local slope (moving 3x3 window)
 *   - Aspect (compass direction of slope face)
 *   - Pad candidates (flattest usable areas)
 *   - Retaining wall candidate length
 *   - Driveway grade
 */

import type { TerrainMetrics, ElevationSample, SlopeResult } from '@shared/types'
import type { Geometry } from 'geojson'
import { geometryFingerprint } from '@shared/sourceRegistry'
import { rentSeekerStore } from './rentSeekerStore'

const GOOGLE_API_KEY = 'AIzaSyBLdVBeMnUEkSEO7fzA9tkr8h6MTEikDAE'
const ELEVATION_API = 'https://maps.googleapis.com/maps/api/elevation/json'

// At LA latitude, 1 degree ≈ 111,139 meters lat, ≈ 92,383 meters lng
const METERS_PER_DEG_LAT = 111139
const METERS_PER_DEG_LNG_AT_LA = 92383
const FEET_PER_METER = 3.28084

/* ═══════════════ ELEVATION SAMPLING ═══════════════ */

/**
 * Sample elevations across a rectangular grid around a point.
 * Uses Google Elevation API with batched requests.
 */
export async function sampleElevations(
  centerLat: number,
  centerLng: number,
  radiusMeters: number = 50,
  gridSize: number = 7
): Promise<ElevationSample[]> {
  const halfRadLat = radiusMeters / METERS_PER_DEG_LAT
  const halfRadLng = radiusMeters / METERS_PER_DEG_LNG_AT_LA

  const points: { lat: number; lng: number }[] = []
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const lat = centerLat - halfRadLat + (2 * halfRadLat * row) / (gridSize - 1)
      const lng = centerLng - halfRadLng + (2 * halfRadLng * col) / (gridSize - 1)
      points.push({ lat, lng })
    }
  }

  // Batch into groups of 50 (API limit per request)
  const batchSize = 50
  const samples: ElevationSample[] = []
  let hadAnyRequestFailure = false

  for (let i = 0; i < points.length; i += batchSize) {
    const batch = points.slice(i, i + batchSize)
    const locations = batch.map(p => `${p.lat},${p.lng}`).join('|')
    const url = `${ELEVATION_API}?locations=${locations}&key=${GOOGLE_API_KEY}`

    try {
      const response = await fetch(url)
      const data = await response.json() as {
        status: string
        results: { elevation: number; location: { lat: number; lng: number } }[]
      }

      if (data.status === 'OK' && data.results) {
        for (const r of data.results) {
          samples.push({
            lat: r.location.lat,
            lng: r.location.lng,
            z: r.elevation * FEET_PER_METER // Convert to feet
          })
        }
      } else {
        hadAnyRequestFailure = true
      }
    } catch (err) {
      hadAnyRequestFailure = true
    }
  }

  if (samples.length === 0 && hadAnyRequestFailure) {
    throw new Error('Elevation unavailable (network/API)')
  }
  return samples
}

async function sampleElevationsForPoints(points: Array<{ lat: number; lng: number }>): Promise<ElevationSample[]> {
  const batchSize = 250
  const samples: ElevationSample[] = []
  let hadAnyRequestFailure = false
  for (let i = 0; i < points.length; i += batchSize) {
    const batch = points.slice(i, i + batchSize)
    const locations = batch.map(p => `${p.lat},${p.lng}`).join('|')
    const url = `${ELEVATION_API}?locations=${locations}&key=${GOOGLE_API_KEY}`
    try {
      const response = await fetch(url)
      const data = await response.json() as {
        status: string
        results: { elevation: number; location: { lat: number; lng: number } }[]
      }
      if (data.status === 'OK' && data.results) {
        for (const r of data.results) {
          samples.push({
            lat: r.location.lat,
            lng: r.location.lng,
            z: r.elevation * FEET_PER_METER
          })
        }
      } else {
        hadAnyRequestFailure = true
      }
    } catch (err) {
      hadAnyRequestFailure = true
    }
  }
  if (samples.length === 0 && hadAnyRequestFailure) {
    throw new Error('Elevation unavailable (network/API)')
  }
  return samples
}

function geometryBounds(geometry: Geometry): { north: number; south: number; east: number; west: number } | null {
  const coords: any[] = []
  if (geometry.type === 'Polygon') coords.push(...geometry.coordinates.flat())
  if (geometry.type === 'MultiPolygon') coords.push(...geometry.coordinates.flat(2))
  if (coords.length === 0) return null
  let north = -Infinity, south = Infinity, east = -Infinity, west = Infinity
  for (const c of coords) {
    const lng = Number(c?.[0])
    const lat = Number(c?.[1])
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue
    north = Math.max(north, lat)
    south = Math.min(south, lat)
    east = Math.max(east, lng)
    west = Math.min(west, lng)
  }
  if (!Number.isFinite(north) || !Number.isFinite(south) || !Number.isFinite(east) || !Number.isFinite(west)) return null
  return { north, south, east, west }
}

function pointInRing(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1]
    const xj = ring[j][0], yj = ring[j][1]
    const intersect = ((yi > lat) !== (yj > lat)) && (lng < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-12) + xi)
    if (intersect) inside = !inside
  }
  return inside
}

function pointInGeometry(lng: number, lat: number, geometry: Geometry): boolean {
  if (geometry.type === 'Polygon') {
    const outer = geometry.coordinates?.[0] as any
    if (!outer || outer.length < 3) return false
    return pointInRing(lng, lat, outer as number[][])
  }
  if (geometry.type === 'MultiPolygon') {
    for (const poly of geometry.coordinates ?? []) {
      const outer = poly?.[0] as any
      if (outer && outer.length >= 3 && pointInRing(lng, lat, outer as number[][])) return true
    }
  }
  return false
}

/* ═══════════════ SLOPE MATH ═══════════════ */

/**
 * Calculate best-fit plane slope from elevation samples.
 * Uses least-squares plane fitting: z = ax + by + c
 * Slope = arctan(sqrt(a² + b²))
 */
export function calculateSlope(samples: ElevationSample[]): SlopeResult {
  if (samples.length < 3) {
    return { slopePct: 0, slopeDeg: 0, aspectDeg: 0, highestZ: 0, lowestZ: 0, samples }
  }

  // Convert to local coordinates (meters from centroid)
  const meanLat = samples.reduce((s, p) => s + p.lat, 0) / samples.length
  const meanLng = samples.reduce((s, p) => s + p.lng, 0) / samples.length
  const meanZ = samples.reduce((s, p) => s + p.z, 0) / samples.length

  const localPoints = samples.map(p => ({
    x: (p.lng - meanLng) * METERS_PER_DEG_LNG_AT_LA * FEET_PER_METER,
    y: (p.lat - meanLat) * METERS_PER_DEG_LAT * FEET_PER_METER,
    z: p.z
  }))

  // Least squares: solve for a, b in z = ax + by + c
  let sumXX = 0, sumXY = 0, sumXZ = 0
  let sumYY = 0, sumYZ = 0
  for (const p of localPoints) {
    const dx = p.x - 0 // already centered by mean
    const dy = p.y - 0
    const dz = p.z - meanZ
    sumXX += dx * dx
    sumXY += dx * dy
    sumXZ += dx * dz
    sumYY += dy * dy
    sumYZ += dy * dz
  }

  const det = sumXX * sumYY - sumXY * sumXY
  let a = 0, b = 0
  if (Math.abs(det) > 1e-10) {
    a = (sumYY * sumXZ - sumXY * sumYZ) / det
    b = (sumXX * sumYZ - sumXY * sumXZ) / det
  }

  // Slope angle
  const slopeRad = Math.atan(Math.sqrt(a * a + b * b))
  const slopeDeg = slopeRad * (180 / Math.PI)
  const slopePct = Math.sqrt(a * a + b * b) * 100

  // Aspect: compass direction the slope faces (downhill direction)
  let aspectDeg = Math.atan2(-a, -b) * (180 / Math.PI)
  if (aspectDeg < 0) aspectDeg += 360

  const highestZ = Math.max(...samples.map(s => s.z))
  const lowestZ = Math.min(...samples.map(s => s.z))

  return { slopePct, slopeDeg, aspectDeg, highestZ, lowestZ, samples }
}

/**
 * Calculate max local slope using a moving 3x3 window.
 * Returns the steepest local slope found.
 */
export function maxLocalSlope(samples: ElevationSample[], gridSize: number): number {
  if (samples.length < 9 || gridSize < 3) return 0

  let maxSlope = 0

  for (let row = 1; row < gridSize - 1; row++) {
    for (let col = 1; col < gridSize - 1; col++) {
      const window: ElevationSample[] = []
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const idx = (row + dr) * gridSize + (col + dc)
          if (idx >= 0 && idx < samples.length) {
            window.push(samples[idx])
          }
        }
      }
      if (window.length >= 3) {
        const result = calculateSlope(window)
        if (result.slopePct > maxSlope) {
          maxSlope = result.slopePct
        }
      }
    }
  }

  return maxSlope
}

function maxLocalSlopeAdaptive(samples: ElevationSample[]): number {
  if (samples.length < 6) return 0
  const pts = samples.map((s) => ({
    ...s,
    x: s.lng * METERS_PER_DEG_LNG_AT_LA * FEET_PER_METER,
    y: s.lat * METERS_PER_DEG_LAT * FEET_PER_METER
  }))
  let maxSlope = 0
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const neighbors = pts
      .map((b, idx) => {
        const dx = b.x - a.x
        const dy = b.y - a.y
        return { idx, dist: dx * dx + dy * dy }
      })
      .sort((p, q) => p.dist - q.dist)
      .slice(0, 10) // include self + 9 nearest
      .map((p) => samples[p.idx])
    if (neighbors.length >= 3) {
      const local = calculateSlope(neighbors)
      if (local.slopePct > maxSlope) maxSlope = local.slopePct
    }
  }
  return maxSlope
}

/**
 * Vegetation/outlier stripping: removes isolated high Z returns before terrain
 * metrics are computed. This is a lightweight SMRF/CSF-style substitute for the
 * Google Elevation workflow, where we receive sampled ground elevations rather
 * than a raw point cloud.
 */
export function stripVegetationOutliers(samples: ElevationSample[]): ElevationSample[] {
  if (samples.length < 9) return samples
  const sortedZ = samples.map(s => s.z).sort((a, b) => a - b)
  const median = sortedZ[Math.floor(sortedZ.length / 2)]
  const deviations = sortedZ.map(z => Math.abs(z - median)).sort((a, b) => a - b)
  const mad = deviations[Math.floor(deviations.length / 2)] || 1
  const maxGroundZ = median + Math.max(18, mad * 3.5)
  return samples.filter(sample => sample.z <= maxGroundZ)
}

/* ═══════════════ TERRAIN METRICS ═══════════════ */

/**
 * Compute full terrain metrics for a parcel.
 */
export async function computeTerrainMetrics(
  parcelId: string,
  lat: number,
  lng: number,
  lotSqft: number = 5000,
  parcelGeometry: Geometry | null = null
): Promise<TerrainMetrics> {
  // Calculate a sampling radius from lot area when a parcel polygon is unavailable.
  const lotSideMeters = Math.sqrt(lotSqft * 0.0929) // sqft to sqm
  const radius = Math.max(25, lotSideMeters / 2)

  let gridSize = 7 // default: 49 points
  let rawSamples: ElevationSample[] = []
  let usedPolygon = false

  // Plan 02/03: sample inside the real parcel polygon when available.
  if (parcelGeometry && (parcelGeometry.type === 'Polygon' || parcelGeometry.type === 'MultiPolygon')) {
    const bounds = geometryBounds(parcelGeometry)
    if (bounds) {
      const approxGrid = lotSqft >= 20000 ? 11 : lotSqft >= 8000 ? 9 : 7
      gridSize = approxGrid
      const points: Array<{ lat: number; lng: number }> = []
      for (let row = 0; row < gridSize; row++) {
        for (let col = 0; col < gridSize; col++) {
          const pLat = bounds.south + ((bounds.north - bounds.south) * row) / Math.max(1, gridSize - 1)
          const pLng = bounds.west + ((bounds.east - bounds.west) * col) / Math.max(1, gridSize - 1)
          if (pointInGeometry(pLng, pLat, parcelGeometry)) {
            points.push({ lat: pLat, lng: pLng })
          }
        }
      }
      if (points.length >= 12) {
        rawSamples = await sampleElevationsForPoints(points)
        usedPolygon = true
      }
    }
  }

  if (!usedPolygon) rawSamples = await sampleElevations(lat, lng, radius, gridSize)
  const samples = stripVegetationOutliers(rawSamples)
  if (samples.length < 6) {
    throw new Error('Terrain metrics not computed (insufficient elevation samples)')
  }
  const slope = calculateSlope(samples)
  const maxLocal = usedPolygon ? maxLocalSlopeAdaptive(samples) : maxLocalSlope(samples, gridSize)

  // Pad detection: find largest contiguous area with slope < 15%
  let padCount = 0
  let largestPadArea = 0
  const cellArea = (lotSqft / (gridSize * gridSize))
  let currentPadCells = 0

  for (let row = 1; row < gridSize - 1; row++) {
    for (let col = 1; col < gridSize - 1; col++) {
      const window: ElevationSample[] = []
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const idx = (row + dr) * gridSize + (col + dc)
          if (idx < samples.length) window.push(samples[idx])
        }
      }
      const localSlope = calculateSlope(window)
      if (localSlope.slopePct < 15) {
        currentPadCells++
      } else {
        if (currentPadCells > 0) {
          padCount++
          largestPadArea = Math.max(largestPadArea, currentPadCells * cellArea)
          currentPadCells = 0
        }
      }
    }
  }
  if (currentPadCells > 0) {
    padCount++
    largestPadArea = Math.max(largestPadArea, currentPadCells * cellArea)
  }

  // Estimate retaining wall: perimeter cells with slope > 25%
  let retainingWallCells = 0
  const cellWidthFt = Math.sqrt(cellArea)
  for (let i = 0; i < gridSize; i++) {
    // Top/bottom edges
    for (const row of [0, gridSize - 1]) {
      const idx = row * gridSize + i
      if (idx < samples.length && idx > 0) {
        const neighborIdx = row === 0 ? idx + gridSize : idx - gridSize
        if (neighborIdx < samples.length) {
          const localDiff = Math.abs(samples[idx].z - samples[neighborIdx].z)
          if (localDiff / cellWidthFt > 0.25) retainingWallCells++
        }
      }
    }
  }

  // Driveway grade: slope from lowest edge to center
  const centerZ = slope.highestZ / 2 + slope.lowestZ / 2
  const edgeZ = slope.lowestZ
  const driveLength = lotSideMeters * FEET_PER_METER / 2
  const drivewayGrade = driveLength > 0 ? ((centerZ - edgeZ) / driveLength) * 100 : 0

  const metrics = {
    parcelId,
    demMinZ: slope.lowestZ,
    demMaxZ: slope.highestZ,
    demMeanZ: samples.reduce((s, p) => s + p.z, 0) / Math.max(samples.length, 1),
    demRelief: slope.highestZ - slope.lowestZ,
    bestFitSlopePct: slope.slopePct,
    bestFitSlopeDeg: slope.slopeDeg,
    maxLocalSlopePct: maxLocal,
    aspectDeg: slope.aspectDeg,
    padCandidateCount: padCount,
    largestPadAreaSqft: largestPadArea,
    drivewayGradeBestPct: Math.abs(drivewayGrade),
    retainingWallCandidateLengthFt: retainingWallCells * cellWidthFt,
    terrainConfidence: samples.length >= 20 ? 0.85 : samples.length >= 10 ? 0.6 : 0.3
  }

  await rentSeekerStore.recordTerrainMetrics(metrics, {
    source: 'google_elevation',
    center: { lat, lng },
    radiusMeters: radius,
    gridSize,
    usedParcelPolygon: usedPolygon,
    rawSampleCount: rawSamples.length,
    groundSampleCount: samples.length,
    samples
  }, geometryFingerprint(parcelGeometry)).catch((err) => {
    console.error('[TerrainEngine] Failed to persist terrain metrics:', err)
  })

  return metrics
}

export async function computeSlopeAtPoint(lat: number, lng: number): Promise<{ slopeDeg: number; slopePct: number }> {
  // Small local sampling window around the cursor.
  const samples = stripVegetationOutliers(await sampleElevations(lat, lng, 35, 7))
  if (samples.length < 6) throw new Error('Slope not computed (insufficient elevation samples)')
  const slope = calculateSlope(samples)
  return { slopeDeg: slope.slopeDeg, slopePct: slope.slopePct }
}
