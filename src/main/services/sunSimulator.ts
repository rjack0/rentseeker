/**
 * SunSimulator — Solar position and shadow analysis per parcel
 * 
 * Implements the Solar Position Algorithm (SPA) to compute sun path
 * for any date at any LA County parcel. Then uses terrain elevation
 * data to determine which hours have direct sunlight vs shadow.
 * 
 * The sun is the ONE bright element in the dark Industrial Theatre UI.
 */

import type { SunAnalysis, SunPosition } from '@shared/types'
import { sampleElevations } from './terrainEngine'
import { rentSeekerStore } from './rentSeekerStore'

/* ═══════════════ SOLAR POSITION MATH ═══════════════ */

// Simplified Solar Position Algorithm for LA County
// Based on NOAA's solar calculator formulas

const DEG_TO_RAD = Math.PI / 180
const RAD_TO_DEG = 180 / Math.PI

/**
 * Calculate Julian Day Number from a date
 */
function julianDay(year: number, month: number, day: number, hour: number = 12): number {
  if (month <= 2) {
    year -= 1
    month += 12
  }
  const A = Math.floor(year / 100)
  const B = 2 - A + Math.floor(A / 4)
  return Math.floor(365.25 * (year + 4716)) + Math.floor(30.6001 * (month + 1)) + day + hour / 24 + B - 1524.5
}

/**
 * Calculate solar declination and equation of time
 */
function solarParams(jd: number): { declination: number; eqTime: number } {
  const T = (jd - 2451545.0) / 36525.0 // Julian centuries since J2000.0

  // Mean longitude of sun
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360
  // Mean anomaly of sun
  const M = (357.52911 + T * (35999.05029 - T * 0.0001537)) % 360
  const Mrad = M * DEG_TO_RAD

  // Equation of center
  const C = (1.914602 - T * (0.004817 + 0.000014 * T)) * Math.sin(Mrad)
    + (0.019993 - 0.000101 * T) * Math.sin(2 * Mrad)
    + 0.000289 * Math.sin(3 * Mrad)

  // Sun's true longitude
  const theta = L0 + C
  // Obliquity of ecliptic
  const epsilon = 23.439291 - T * 0.0130042

  // Solar declination
  const declination = Math.asin(Math.sin(epsilon * DEG_TO_RAD) * Math.sin(theta * DEG_TO_RAD)) * RAD_TO_DEG

  // Equation of time (minutes)
  const y = Math.tan(epsilon * DEG_TO_RAD / 2) ** 2
  const L0rad = L0 * DEG_TO_RAD
  const eqTime = 4 * RAD_TO_DEG * (
    y * Math.sin(2 * L0rad)
    - 2 * 0.016709 * Math.sin(Mrad)
    + 4 * 0.016709 * y * Math.sin(Mrad) * Math.cos(2 * L0rad)
    - 0.5 * y * y * Math.sin(4 * L0rad)
    - 1.25 * 0.016709 * 0.016709 * Math.sin(2 * Mrad)
  )

  return { declination, eqTime }
}

/**
 * Calculate sun position (azimuth, altitude) at a given hour
 */
function sunPositionAtHour(
  lat: number,
  lng: number,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number = 0,
  tzOffset: number = -8 // PST
): SunPosition {
  const jd = julianDay(year, month, day, 12)
  const { declination, eqTime } = solarParams(jd)

  // True solar time
  const solarTimeFix = eqTime + 4 * lng - 60 * tzOffset
  const trueSolarTime = hour * 60 + minute + solarTimeFix

  // Hour angle
  let hourAngle = trueSolarTime / 4 - 180
  if (hourAngle < -180) hourAngle += 360

  const latRad = lat * DEG_TO_RAD
  const decRad = declination * DEG_TO_RAD
  const haRad = hourAngle * DEG_TO_RAD

  // Solar altitude (elevation angle)
  const sinAlt = Math.sin(latRad) * Math.sin(decRad) + Math.cos(latRad) * Math.cos(decRad) * Math.cos(haRad)
  const altitudeDeg = Math.asin(Math.max(-1, Math.min(1, sinAlt))) * RAD_TO_DEG

  // Solar azimuth
  const cosAz = (Math.sin(decRad) - Math.sin(latRad) * sinAlt) / (Math.cos(latRad) * Math.cos(altitudeDeg * DEG_TO_RAD))
  let azimuthDeg = Math.acos(Math.max(-1, Math.min(1, cosAz))) * RAD_TO_DEG
  if (hourAngle > 0) azimuthDeg = 360 - azimuthDeg

  return { azimuthDeg, altitudeDeg, hour, minute }
}

/**
 * Calculate sunrise and sunset hours for a date at a location
 */
function calculateDaylight(lat: number, year: number, month: number, day: number): { sunrise: number; sunset: number } {
  const jd = julianDay(year, month, day, 12)
  const { declination } = solarParams(jd)

  const latRad = lat * DEG_TO_RAD
  const decRad = declination * DEG_TO_RAD

  // Hour angle at sunrise/sunset (when altitude = 0, accounting for refraction)
  const cosHA = (-0.01454 - Math.sin(latRad) * Math.sin(decRad)) / (Math.cos(latRad) * Math.cos(decRad))

  if (cosHA > 1) return { sunrise: 12, sunset: 12 } // No sunrise (polar night)
  if (cosHA < -1) return { sunrise: 0, sunset: 24 } // No sunset (polar day)

  const haRise = Math.acos(cosHA) * RAD_TO_DEG
  const solarNoon = 720 // Approximate solar noon in minutes

  return {
    sunrise: (solarNoon - haRise * 4) / 60,
    sunset: (solarNoon + haRise * 4) / 60
  }
}

/* ═══════════════ SHADOW ANALYSIS ═══════════════ */

/**
 * Check if terrain blocks the sun at a given azimuth and altitude.
 * Casts a ray from the parcel center in the sun's direction and
 * checks if any surrounding terrain is higher than the sun angle.
 */
async function checkTerrainObstruction(
  lat: number,
  lng: number,
  sunAzimuth: number,
  sunAltitude: number
): Promise<{ obstructed: boolean; description: string }> {
  if (sunAltitude <= 0) return { obstructed: true, description: 'Below horizon' }

  // Sample terrain in the direction the sun is coming FROM
  // (opposite of azimuth, since azimuth is where the sun IS)
  const fromAzimuth = (sunAzimuth + 180) % 360
  const fromRad = fromAzimuth * DEG_TO_RAD

  // Check at distances: 100m, 300m, 500m, 1000m
  const distances = [100, 300, 500, 1000]
  const METERS_PER_DEG_LAT = 111139
  const METERS_PER_DEG_LNG = 92383

  for (const dist of distances) {
    const checkLat = lat + (dist * Math.cos(fromRad)) / METERS_PER_DEG_LAT
    const checkLng = lng + (dist * Math.sin(fromRad)) / METERS_PER_DEG_LNG

    const samples = await sampleElevations(checkLat, checkLng, 20, 3)
    if (samples.length === 0) continue

    const maxBlockZ = Math.max(...samples.map(s => s.z))
    const parcelSamples = await sampleElevations(lat, lng, 10, 3)
    const parcelZ = parcelSamples.length > 0
      ? parcelSamples.reduce((s, p) => s + p.z, 0) / parcelSamples.length
      : 0

    // Calculate the angle to this terrain obstacle
    const heightDiff = maxBlockZ - parcelZ
    const distFt = dist * 3.28084
    const blockAngle = Math.atan2(heightDiff, distFt) * RAD_TO_DEG

    if (blockAngle > sunAltitude) {
      return {
        obstructed: true,
        description: `Ridge/hill at ${dist}m (${Math.round(fromAzimuth)}°) blocks sun (terrain angle ${blockAngle.toFixed(1)}° > sun altitude ${sunAltitude.toFixed(1)}°)`
      }
    }
  }

  return { obstructed: false, description: '' }
}

/* ═══════════════ MAIN API ═══════════════ */

/**
 * Compute full sun analysis for a parcel on a given date.
 */
export async function computeSunAnalysis(
  parcelId: string,
  lat: number,
  lng: number,
  dateStr: string // YYYY-MM-DD
): Promise<SunAnalysis> {
  const [year, month, day] = dateStr.split('-').map(Number)
  const tzOffset = -8 // PST (could be -7 for PDT)

  // Calculate sun path for every 30 minutes from 5am to 8pm
  const sunPath: SunPosition[] = []
  for (let h = 5; h <= 20; h++) {
    for (const m of [0, 30]) {
      const pos = sunPositionAtHour(lat, lng, year, month, day, h, m, tzOffset)
      if (pos.altitudeDeg > -5) { // Include civil twilight
        sunPath.push(pos)
      }
    }
  }

  // Calculate sunrise/sunset
  const daylight = calculateDaylight(lat, year, month, day)

  // If elevation is unavailable, do not return fake outputs.
  await sampleElevations(lat, lng, 10, 3)

  // Check terrain obstruction for each hour of sunlight
  const hourlyObstruction: { hour: number; obstructionPct: number }[] = []
  const obstructors: { azimuthDeg: number; elevationDeg: number; description: string }[] = []
  let directSunHours = 0

  // Sample fewer hours to stay within API limits
  const checkHours = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]
  for (const h of checkHours) {
    if (h < daylight.sunrise || h > daylight.sunset) {
      hourlyObstruction.push({ hour: h, obstructionPct: 1 })
      continue
    }

    const pos = sunPositionAtHour(lat, lng, year, month, day, h, 0, tzOffset)
    if (pos.altitudeDeg <= 0) {
      hourlyObstruction.push({ hour: h, obstructionPct: 1 })
      continue
    }

    const check = await checkTerrainObstruction(lat, lng, pos.azimuthDeg, pos.altitudeDeg)
    if (check.obstructed) {
      hourlyObstruction.push({ hour: h, obstructionPct: 1 })
      obstructors.push({
        azimuthDeg: pos.azimuthDeg,
        elevationDeg: pos.altitudeDeg,
        description: check.description
      })
    } else {
      hourlyObstruction.push({ hour: h, obstructionPct: 0 })
      directSunHours++
    }
  }

  const analysis = {
    parcelId,
    date: dateStr,
    latitude: lat,
    longitude: lng,
    sunPath,
    sunriseHour: daylight.sunrise,
    sunsetHour: daylight.sunset,
    totalDaylightHours: daylight.sunset - daylight.sunrise,
    directSunlightHours: directSunHours,
    hourlyObstruction,
    obstructors
  }
  await rentSeekerStore.recordSunAnalysis(analysis).catch((err) => {
    console.error('[SunSimulator] Failed to persist sun analysis:', err)
  })
  return analysis
}
