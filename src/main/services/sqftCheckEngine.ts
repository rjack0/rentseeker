import type { ParcelPolygon, MapBounds } from '@shared/types'
import { geometryAreaSqft, geometryBounds } from './geoArea'
import { rentSeekerStore } from './rentSeekerStore'

function median(values: number[]): number {
  const v = values.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b)
  if (v.length === 0) return 0
  const mid = Math.floor(v.length / 2)
  return v.length % 2 === 0 ? (v[mid - 1] + v[mid]) / 2 : v[mid]
}

function expandBounds(bounds: MapBounds, padDeg: number): MapBounds {
  return {
    north: bounds.north + padDeg,
    south: bounds.south - padDeg,
    east: bounds.east + padDeg,
    west: bounds.west - padDeg
  }
}

export async function getOrComputeSqftCheck(args: {
  parcelId: string
  assessorSqft: number
  parcelPolygon: ParcelPolygon | null
  getNeighbors: (bounds: MapBounds, limit?: number) => Promise<ParcelPolygon[]>
}): Promise<{ geometricSqft: number; neighborMedianSqft: number; status: string }> {
  const cached = await rentSeekerStore.getSqftCheck(args.parcelId).catch(() => null)
  if (cached) return cached

  const geometricSqft = geometryAreaSqft(args.parcelPolygon?.geometry ?? null)

  // Neighbors: use polygon bounds if possible, else fall back to a small window.
  const gb = geometryBounds(args.parcelPolygon?.geometry ?? null)
  const baseBounds: MapBounds = gb
    ? { north: gb.north, south: gb.south, east: gb.east, west: gb.west }
    : { north: (args.parcelPolygon?.centerLat ?? 34) + 0.01, south: (args.parcelPolygon?.centerLat ?? 34) - 0.01, east: (args.parcelPolygon?.centerLon ?? -118) + 0.01, west: (args.parcelPolygon?.centerLon ?? -118) - 0.01 }

  const neighbors = await args.getNeighbors(expandBounds(baseBounds, 0.01), 250).catch(() => [])
  const neighborAreas = neighbors
    .map((p) => geometryAreaSqft(p.geometry as any))
    .filter((a) => a > 0)

  const neighborMedianSqft = median(neighborAreas)

  const legal = Number(args.assessorSqft ?? 0) || 0
  const g = geometricSqft
  const ratio = (legal > 0 && g > 0) ? g / legal : 0
  let status = 'unknown'
  if (legal > 0 && g > 0) {
    const diffPct = Math.abs(1 - ratio) * 100
    if (diffPct <= 15) status = 'ok'
    else if (diffPct <= 40) status = 'warn'
    else status = 'flag'
  }

  await rentSeekerStore.recordSqftCheck(args.parcelId, g, neighborMedianSqft, status).catch(() => undefined)
  return { geometricSqft: g, neighborMedianSqft, status }
}

