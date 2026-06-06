/**
 * ViewAnalysis — Viewshed computation and landmark visibility
 * 
 * From a parcel at a given building height (stories × 11ft),
 * casts rays outward in 360° and tests against terrain elevation
 * to determine:
 *   - Which LA landmarks are visible
 *   - How far you can see in each direction
 *   - Overall "view score" (0-100)
 * 
 * Uses Google Elevation API for terrain sampling along sight lines.
 */

import type { Geometry } from 'geojson'
import type { ViewAnalysis, ViewRay, Landmark } from '@shared/types'
import { geometryFingerprint } from '@shared/sourceRegistry'
import { rentSeekerStore } from './rentSeekerStore'

const GOOGLE_API_KEY = 'AIzaSyBLdVBeMnUEkSEO7fzA9tkr8h6MTEikDAE'
const ELEVATION_API = 'https://maps.googleapis.com/maps/api/elevation/json'
const FEET_PER_METER = 3.28084
const METERS_PER_DEG_LAT = 111139
const METERS_PER_DEG_LNG = 92383 // At LA latitude ~34°
const FEET_PER_MILE = 5280
const METERS_PER_MILE = 1609.34
const DEG_TO_RAD = Math.PI / 180
const EARTH_RADIUS_FT = 20902231 // Earth radius in feet

/* ═══════════════ LA LANDMARKS ═══════════════ */

export const LA_LANDMARKS: Landmark[] = [
  { name: 'Downtown LA Skyline', lat: 34.0522, lng: -118.2437, elevationFt: 630, category: 'skyline' },
  { name: 'Century City Towers', lat: 34.0577, lng: -118.4132, elevationFt: 770, category: 'skyline' },
  { name: 'Hollywood Sign', lat: 34.1341, lng: -118.3215, elevationFt: 1578, category: 'monument' },
  { name: 'Griffith Observatory', lat: 34.1184, lng: -118.3004, elevationFt: 1135, category: 'monument' },
  { name: 'Pacific Ocean', lat: 33.93, lng: -118.46, elevationFt: 0, category: 'ocean' },
  { name: 'Mount Wilson', lat: 34.2236, lng: -118.0563, elevationFt: 5710, category: 'nature' },
  { name: 'Catalina Island', lat: 33.35, lng: -118.425, elevationFt: 2097, category: 'nature' },
  { name: 'Hollywood Hills', lat: 34.115, lng: -118.34, elevationFt: 1650, category: 'nature' },
  { name: 'Santa Monica Mountains', lat: 34.085, lng: -118.63, elevationFt: 2800, category: 'nature' },
  { name: 'LAX', lat: 33.9425, lng: -118.408, elevationFt: 126, category: 'skyline' },
  { name: 'Dodger Stadium', lat: 34.0739, lng: -118.2400, elevationFt: 515, category: 'monument' },
  { name: 'SoFi Stadium', lat: 33.9535, lng: -118.3392, elevationFt: 96, category: 'skyline' }
]

/* ═══════════════ ELEVATION QUERY ═══════════════ */

interface ElevationPoint {
  lat: number
  lng: number
  elevationFt: number
}

/**
 * Query elevation at specific points via Google Elevation API
 */
async function queryElevations(points: { lat: number; lng: number }[]): Promise<ElevationPoint[]> {
  if (points.length === 0) return []

  const results: ElevationPoint[] = []
  const batchSize = 50
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
          results.push({
            lat: r.location.lat,
            lng: r.location.lng,
            elevationFt: r.elevation * FEET_PER_METER
          })
        }
      } else {
        hadAnyRequestFailure = true
      }
    } catch (err) {
      hadAnyRequestFailure = true
    }
  }

  if (results.length === 0 && hadAnyRequestFailure) {
    throw new Error('Elevation unavailable (network/API)')
  }
  return results
}

/* ═══════════════ GEOMETRY UTILS ═══════════════ */

/**
 * Calculate distance between two lat/lng points in miles
 */
function haversineDistanceMi(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = (lat2 - lat1) * DEG_TO_RAD
  const dLng = (lng2 - lng1) * DEG_TO_RAD
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * Math.sin(dLng / 2) ** 2
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return c * 3963.2 // Earth radius in miles
}

/**
 * Calculate bearing from point 1 to point 2 (degrees, 0=N, 90=E)
 */
function bearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLng = (lng2 - lng1) * DEG_TO_RAD
  const y = Math.sin(dLng) * Math.cos(lat2 * DEG_TO_RAD)
  const x = Math.cos(lat1 * DEG_TO_RAD) * Math.sin(lat2 * DEG_TO_RAD) -
    Math.sin(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * Math.cos(dLng)
  let b = Math.atan2(y, x) * (180 / Math.PI)
  if (b < 0) b += 360
  return b
}

/**
 * Calculate point at a given distance and bearing from origin
 */
function destinationPoint(lat: number, lng: number, bearingDeg: number, distanceMeters: number): { lat: number; lng: number } {
  return {
    lat: lat + (distanceMeters * Math.cos(bearingDeg * DEG_TO_RAD)) / METERS_PER_DEG_LAT,
    lng: lng + (distanceMeters * Math.sin(bearingDeg * DEG_TO_RAD)) / METERS_PER_DEG_LNG
  }
}

function geometryCenter(geometry: Geometry): { lat: number; lng: number } | null {
  const coords: Array<[number, number]> = []
  if (geometry.type === 'Polygon') {
    coords.push(...((geometry.coordinates?.[0] ?? []) as Array<[number, number]>))
  } else if (geometry.type === 'MultiPolygon') {
    for (const poly of geometry.coordinates ?? []) {
      coords.push(...((poly?.[0] ?? []) as Array<[number, number]>))
    }
  }
  if (coords.length === 0) return null
  const sum = coords.reduce((acc, [lng, lat]) => {
    acc.lat += lat
    acc.lng += lng
    return acc
  }, { lat: 0, lng: 0 })
  return { lat: sum.lat / coords.length, lng: sum.lng / coords.length }
}

/**
 * Account for Earth's curvature: how much does the ground "drop" at distance?
 * Returns feet of drop due to curvature.
 */
function earthCurvatureDrop(distanceFt: number): number {
  // h = d² / (2R) where R = Earth radius in feet
  return (distanceFt * distanceFt) / (2 * EARTH_RADIUS_FT)
}

/* ═══════════════ VIEWSHED COMPUTATION ═══════════════ */

/**
 * Cast a single view ray from the parcel and determine max visible distance.
 * Samples terrain along the ray at increasing intervals.
 */
async function castViewRay(
  originLat: number,
  originLng: number,
  originElevFt: number,
  viewerHeightFt: number,
  azimuthDeg: number,
  maxDistanceMi: number = 30
): Promise<ViewRay> {
  const viewerZ = originElevFt + viewerHeightFt

  // Sample at increasing distances: 0.2mi, 0.5mi, 1mi, 2mi, 5mi, 10mi, 20mi
  const sampleDistances = [0.2, 0.5, 1, 2, 3, 5, 8, 12, 20].filter(d => d <= maxDistanceMi)
  const samplePoints = sampleDistances.map(distMi => {
    const distMeters = distMi * METERS_PER_MILE
    return destinationPoint(originLat, originLng, azimuthDeg, distMeters)
  })

  const elevations = await queryElevations(samplePoints)

  let obstructedAtMi: number | null = null
  let terrainBlockHeight: number | null = null

  for (let i = 0; i < elevations.length; i++) {
    const distMi = sampleDistances[i]
    const distFt = distMi * FEET_PER_MILE
    const terrainZ = elevations[i].elevationFt

    // Account for Earth curvature
    const curvatureDrop = earthCurvatureDrop(distFt)

    // Effective terrain height relative to viewer
    const effectiveTerrainZ = terrainZ - curvatureDrop

    // Line of sight: from viewer height, can we see over this terrain?
    // The sight line drops linearly; terrain sticks up from below
    // If terrain is higher than the line of sight at this distance, we're blocked
    if (effectiveTerrainZ > viewerZ) {
      obstructedAtMi = distMi
      terrainBlockHeight = effectiveTerrainZ - viewerZ
      break
    }
  }

  return {
    azimuthDeg,
    maxDistanceMi,
    obstructedAtMi,
    terrainBlockHeight
  }
}

/* ═══════════════ LANDMARK VISIBILITY ═══════════════ */

/**
 * Check if a specific landmark is visible from the parcel.
 * Tests the sight line for terrain obstructions.
 */
async function checkLandmarkVisibility(
  originLat: number,
  originLng: number,
  originElevFt: number,
  viewerHeightFt: number,
  landmark: Landmark
): Promise<{ visible: boolean; distanceMi: number; bearingDeg: number; blockedBy?: string }> {
  const distMi = haversineDistanceMi(originLat, originLng, landmark.lat, landmark.lng)
  const bearingDeg = bearing(originLat, originLng, landmark.lat, landmark.lng)
  const viewerZ = originElevFt + viewerHeightFt
  const targetZ = landmark.elevationFt

  // Sample 5 intermediate points along the sight line
  const numSamples = 5
  const samplePoints: { lat: number; lng: number }[] = []
  for (let i = 1; i <= numSamples; i++) {
    const fraction = i / (numSamples + 1)
    samplePoints.push({
      lat: originLat + (landmark.lat - originLat) * fraction,
      lng: originLng + (landmark.lng - originLng) * fraction
    })
  }

  const elevations = await queryElevations(samplePoints)

  for (let i = 0; i < elevations.length; i++) {
    const fraction = (i + 1) / (numSamples + 1)
    const sightLineZ = viewerZ + (targetZ - viewerZ) * fraction
    const distFt = distMi * FEET_PER_MILE * fraction
    const curvatureDrop = earthCurvatureDrop(distFt)
    const terrainZ = elevations[i].elevationFt - curvatureDrop

    if (terrainZ > sightLineZ) {
      return {
        visible: false,
        distanceMi: distMi,
        bearingDeg,
        blockedBy: `Terrain at ${(distMi * fraction).toFixed(1)}mi (elev ${Math.round(elevations[i].elevationFt)}ft)`
      }
    }
  }

  return { visible: true, distanceMi: distMi, bearingDeg }
}

/* ═══════════════ MAIN API ═══════════════ */

/**
 * Compute full view analysis for a parcel at a given number of stories.
 * Each story = 11 feet.
 */
export async function computeViewAnalysis(
  parcelId: string,
  lat: number,
  lng: number,
  stories: number = 2,
  parcelGeometry: Geometry | null = null
): Promise<ViewAnalysis> {
  const STORY_HEIGHT_FT = 11
  const viewerHeightFt = stories * STORY_HEIGHT_FT
  const origin = parcelGeometry ? geometryCenter(parcelGeometry) ?? { lat, lng } : { lat, lng }
  const originLat = origin.lat
  const originLng = origin.lng

  // Get parcel ground elevation
  const groundSamples = await queryElevations([{ lat: originLat, lng: originLng }])
  if (groundSamples.length === 0) {
    throw new Error('View analysis not computed (elevation unavailable)')
  }
  const groundElevFt = groundSamples[0].elevationFt

  // 1. Check landmark visibility
  const visibleLandmarks: ViewAnalysis['visibleLandmarks'] = []
  const blockedLandmarks: ViewAnalysis['blockedLandmarks'] = []

  for (const landmark of LA_LANDMARKS) {
    const result = await checkLandmarkVisibility(originLat, originLng, groundElevFt, viewerHeightFt, landmark)
    if (result.visible) {
      visibleLandmarks.push({
        landmark,
        distanceMi: result.distanceMi,
        bearingDeg: result.bearingDeg
      })
    } else {
      blockedLandmarks.push({
        landmark,
        blockedByDescription: result.blockedBy ?? 'Unknown obstruction'
      })
    }
  }

  // 2. Cast viewshed rays every 15° (24 rays for quick analysis)
  const viewshed: ViewRay[] = []
  for (let az = 0; az < 360; az += 15) {
    const ray = await castViewRay(originLat, originLng, groundElevFt, viewerHeightFt, az, 25)
    viewshed.push(ray)
  }

  // 3. Calculate overall view score
  // Factors: number of visible landmarks, max view distance, unobstructed percentage
  const unobstructedRays = viewshed.filter(r => r.obstructedAtMi === null).length
  const unobstructedPct = unobstructedRays / viewshed.length
  const landmarkScore = (visibleLandmarks.length / LA_LANDMARKS.length) * 50
  const openScore = unobstructedPct * 30
  const maxDist = viewshed.reduce((max, r) =>
    Math.max(max, r.obstructedAtMi === null ? r.maxDistanceMi : r.obstructedAtMi), 0)
  const distScore = Math.min(20, maxDist / 30 * 20)

  const viewScore = Math.round(landmarkScore + openScore + distScore)

  const analysis = {
    parcelId,
    viewerHeightFt,
    stories,
    totalRays: viewshed.length,
    visibleLandmarks,
    blockedLandmarks,
    viewshed,
    viewScore: Math.min(100, viewScore),
    maxViewDistanceMi: maxDist
  }
  await rentSeekerStore.recordViewAnalysis(analysis, geometryFingerprint(parcelGeometry)).catch((err) => {
    console.error('[ViewAnalysis] Failed to persist view analysis:', err)
  })
  return analysis
}
