/**
 * GdbConverter — Serves parcel polygon boundaries from GeoJSON
 * 
 * The full LACounty GDB has been converted to GeoJSON via ogr2ogr.
 * This service loads parcel polygons on demand for a given viewport,
 * enabling parcel boundary rendering on the map.
 * 
 * For performance, uses DuckDB's spatial extension to query the
 * GeoJSON file directly without loading it into memory.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api'
import { existsSync } from 'fs'
import type { Feature, FeatureCollection, Geometry } from 'geojson'
import { rentSeekerStore } from './rentSeekerStore'
import type { MapBounds, ParcelBoundaryTile, ParcelBoundaryTileResponse } from '@shared/types'

// Path to the converted GeoJSON — 2.4M parcels in WGS84
const GEOJSON_PATH = '/Users/rjack/Desktop/almanac/Docs/RE Data/parcel_geojson/LACounty_Parcels_WGS84.geojson'
const GDB_PATH = '/Users/rjack/Desktop/almanac/Docs/RE Data/LACounty_Parcels.gdb'
const GDB_LAYER = 'LACounty_Parcels'
const OGR2OGR = existsSync('/opt/homebrew/bin/ogr2ogr') ? '/opt/homebrew/bin/ogr2ogr' : 'ogr2ogr'
const OGRINFO = existsSync('/opt/homebrew/bin/ogrinfo') ? '/opt/homebrew/bin/ogrinfo' : 'ogrinfo'
const execFileAsync = promisify(execFile)
const MAX_POLYGONS_PER_TILE = 8000
const MAX_TILE_DEPTH = 3

export interface ParcelPolygon {
  ain: string
  apn: string
  address: string
  useCode: string
  useType: string
  geometry: Geometry
  centerLat: number
  centerLon: number
}

export class GdbParcelService {
  private instance: DuckDBInstance | null = null
  private connection: DuckDBConnection | null = null
  private spatialLoaded = false
  private boundaryTileCache = new Map<string, ParcelBoundaryTile>()

  async initialize(): Promise<void> {
    if (this.connection) return
    this.instance = await DuckDBInstance.create(':memory:')
    this.connection = await this.instance.connect()
    await this.exec('SET threads = 4')
  }

  private async exec(sql: string): Promise<void> {
    if (!this.connection) throw new Error('Not initialized')
    await this.connection.run(sql)
  }

  private async loadSpatial(): Promise<void> {
    if (this.spatialLoaded) return
    try {
      await this.exec('INSTALL spatial')
      await this.exec('LOAD spatial')
      this.spatialLoaded = true
    } catch {
      console.warn('[GdbParcelService] Spatial extension not available — will use basic queries')
    }
  }

  private async query(sql: string): Promise<Record<string, unknown>[]> {
    if (!this.connection) throw new Error('Not initialized')
    const reader = await this.connection.runAndReadAll(sql)
    return reader.getRowObjectsJson() as Record<string, unknown>[]
  }

  /**
   * Check if the GeoJSON file exists and is ready
   */
  isAvailable(): boolean {
    return existsSync(GDB_PATH) || existsSync(GEOJSON_PATH)
  }

  /**
   * Query parcel polygons within a viewport bounding box.
   * Returns simplified geometries for rendering.
   */
  async queryPolygonsInBounds(
    north: number,
    south: number,
    east: number,
    west: number,
    limit: number = 5000,
    simplifyTolerance = 0
  ): Promise<ParcelPolygon[]> {
    await this.initialize()

    if (!this.isAvailable()) {
      console.warn('[GdbParcelService] GeoJSON not available at:', GEOJSON_PATH)
      return []
    }

    try {
      const tileId = `center-bounds:${west.toFixed(5)},${south.toFixed(5)},${east.toFixed(5)},${north.toFixed(5)}`
      await rentSeekerStore.recordSpatialTile(tileId, { west, south, east, north }, GDB_PATH).catch(() => undefined)
      const where = `CENTER_LAT >= ${south} AND CENTER_LAT <= ${north} AND CENTER_LON >= ${west} AND CENTER_LON <= ${east}`
      const collection = await this.extractGeoJson(where, limit, simplifyTolerance)
      const polygons = collection.features.map(feature => this.featureToPolygon(feature)).filter(Boolean) as ParcelPolygon[]
      await Promise.allSettled(polygons.map(poly => rentSeekerStore.recordParcelTileIntersection(poly.ain || poly.apn, tileId)))
      return polygons
    } catch (err) {
      console.error('[GdbParcelService] Query error:', err)
      return []
    }
  }

  /**
   * Get a specific parcel by AIN with full geometry
   */
  async getParcelByAin(ain: string): Promise<ParcelPolygon | null> {
    await this.initialize()
    if (!this.isAvailable()) return null

    try {
      const cleanAin = ain.replace(/[^0-9]/g, '')
      const collection = await this.extractGeoJson(`AIN = '${cleanAin.replace(/'/g, "''")}'`, 1)
      return collection.features[0] ? this.featureToPolygon(collection.features[0]) : null
    } catch (err) {
      console.error('[GdbParcelService] AIN query error:', err)
      return null
    }
  }

  /**
   * Get count of parcels in a bounding box (for confirmation dialog)
   */
  async countInBounds(
    north: number,
    south: number,
    east: number,
    west: number
  ): Promise<number> {
    await this.initialize()
    if (!this.isAvailable()) return 0

    try {
      const where = `CENTER_LAT >= ${south} AND CENTER_LAT <= ${north} AND CENTER_LON >= ${west} AND CENTER_LON <= ${east}`
      if (existsSync(GDB_PATH) || existsSync(GEOJSON_PATH)) {
        const args = existsSync(GDB_PATH)
          ? ['-ro', '-so', '-where', where, GDB_PATH, GDB_LAYER]
          : ['-ro', '-so', '-where', where, GEOJSON_PATH]
        const { stdout } = await execFileAsync(OGRINFO, args, { maxBuffer: 1024 * 1024 * 4 })
        const match = stdout.match(/Feature Count:\s*(\d+)/)
        if (match) return Number(match[1])
      }
      const collection = await this.extractGeoJson(`CENTER_LAT >= ${south} AND CENTER_LAT <= ${north} AND CENTER_LON >= ${west} AND CENTER_LON <= ${east}`, 100001)
      return collection.features.length
    } catch {
      return 0
    }
  }

  async getParcelBoundaryTiles(bounds: MapBounds, zoom: number): Promise<ParcelBoundaryTileResponse> {
    const start = Date.now()
    const tiles = await this.loadBoundaryTiles(bounds, zoom, 0)
    const polygons = tiles.flatMap(tile => tile.polygons)
    const visibleBoundaryCount = tiles.reduce((sum, tile) => sum + tile.count, 0)

    return {
      tiles,
      polygons,
      visibleBoundaryCount,
      renderedBoundaryCount: polygons.length,
      complete: tiles.every(tile => tile.complete),
      queryTimeMs: Date.now() - start
    }
  }

  async countParcelBoundaries(bounds: MapBounds): Promise<number> {
    return this.countInBounds(bounds.north, bounds.south, bounds.east, bounds.west)
  }

  async getParcelsInBounds(bounds: MapBounds, limit?: number): Promise<ParcelPolygon[]> {
    const count = await this.countParcelBoundaries(bounds)
    const targetLimit = limit ?? Math.max(1, count)
    return this.queryPolygonsInBounds(bounds.north, bounds.south, bounds.east, bounds.west, targetLimit, 0)
  }

  async getParcelByPoint(lng: number, lat: number): Promise<ParcelPolygon | null> {
    await this.initialize()
    if (!this.isAvailable()) return null

    for (const delta of [0.00035, 0.001, 0.003, 0.008]) {
      const candidates = await this.queryPolygonsInBounds(
        lat + delta,
        lat - delta,
        lng + delta,
        lng - delta,
        500,
        0
      )
      const containing = candidates.find(parcel => pointInGeometry(lng, lat, parcel.geometry))
      if (containing) return containing
    }

    return null
  }

  private async loadBoundaryTiles(bounds: MapBounds, zoom: number, depth: number): Promise<ParcelBoundaryTile[]> {
    const id = boundaryTileId(bounds, zoom, depth)
    const cached = this.boundaryTileCache.get(id)
    if (cached) return [cached]

    const count = await this.countParcelBoundaries(bounds)
    if (count > MAX_POLYGONS_PER_TILE && depth < MAX_TILE_DEPTH) {
      const childTiles: ParcelBoundaryTile[] = []
      for (const childBounds of splitBounds(bounds)) {
        childTiles.push(...await this.loadBoundaryTiles(childBounds, zoom, depth + 1))
      }
      return childTiles
    }

    const limit = Math.max(1, count)
    const simplifyTolerance = simplifyToleranceForZoom(zoom)
    const polygons = count === 0
      ? []
      : await this.queryPolygonsInBounds(bounds.north, bounds.south, bounds.east, bounds.west, limit, simplifyTolerance)
    const tile: ParcelBoundaryTile = {
      id,
      bounds,
      zoom,
      count,
      complete: polygons.length >= count,
      simplified: simplifyTolerance > 0,
      polygons
    }

    this.boundaryTileCache.set(id, tile)
    this.trimBoundaryTileCache()
    return [tile]
  }

  private trimBoundaryTileCache(): void {
    while (this.boundaryTileCache.size > 96) {
      const oldest = this.boundaryTileCache.keys().next().value
      if (!oldest) return
      this.boundaryTileCache.delete(oldest)
    }
  }

  private async extractGeoJson(where: string, limit: number, simplifyTolerance = 0): Promise<FeatureCollection> {
    if (existsSync(GDB_PATH)) {
      const args = [
        '-f',
        'GeoJSON',
        '/vsistdout/',
        GDB_PATH,
        GDB_LAYER,
        '-where',
        where,
        '-t_srs',
        'EPSG:4326'
      ]
      if (simplifyTolerance > 0) {
        args.push('-simplify', String(simplifyTolerance))
      }
      args.push('-limit', String(Math.max(1, limit)))
      const { stdout } = await execFileAsync(OGR2OGR, args, { maxBuffer: 1024 * 1024 * 256 })
      return JSON.parse(stdout) as FeatureCollection
    }

    if (existsSync(GEOJSON_PATH)) {
      const args = [
        '-f',
        'GeoJSON',
        '/vsistdout/',
        GEOJSON_PATH,
        '-where',
        where
      ]
      if (simplifyTolerance > 0) {
        args.push('-simplify', String(simplifyTolerance))
      }
      args.push('-limit', String(Math.max(1, limit)))
      const { stdout } = await execFileAsync(OGR2OGR, args, { maxBuffer: 1024 * 1024 * 256 })
      return JSON.parse(stdout) as FeatureCollection
    }

    return { type: 'FeatureCollection', features: [] }
  }

  private featureToPolygon(feature: Feature): ParcelPolygon | null {
    const props = feature.properties ?? {}
    const centerLat = Number(props.CENTER_LAT ?? props.centerLat ?? props.centerlat ?? 0)
    const centerLon = Number(props.CENTER_LON ?? props.centerLon ?? props.centerlon ?? 0)
    if (!feature.geometry) return null
    return {
      ain: String(props.AIN ?? props.ain ?? ''),
      apn: String(props.APN ?? props.apn ?? ''),
      address: String(props.SitusFullAddress ?? props.address ?? ''),
      useCode: String(props.UseCode ?? props.useCode ?? props.usecode ?? ''),
      useType: String(props.UseType ?? props.useType ?? props.usetype ?? ''),
      centerLat,
      centerLon,
      geometry: feature.geometry as Geometry
    }
  }
}

function boundaryTileId(bounds: MapBounds, zoom: number, depth: number): string {
  const z = Math.max(0, Math.round(zoom * 2) / 2).toFixed(1)
  return [
    'boundary',
    z,
    depth,
    bounds.west.toFixed(5),
    bounds.south.toFixed(5),
    bounds.east.toFixed(5),
    bounds.north.toFixed(5)
  ].join(':')
}

function splitBounds(bounds: MapBounds): MapBounds[] {
  const midLat = (bounds.north + bounds.south) / 2
  const midLng = (bounds.east + bounds.west) / 2
  return [
    { north: bounds.north, south: midLat, west: bounds.west, east: midLng },
    { north: bounds.north, south: midLat, west: midLng, east: bounds.east },
    { north: midLat, south: bounds.south, west: bounds.west, east: midLng },
    { north: midLat, south: bounds.south, west: midLng, east: bounds.east }
  ]
}

function simplifyToleranceForZoom(zoom: number): number {
  if (zoom >= 16) return 0
  if (zoom >= 15) return 0.000001
  if (zoom >= 14) return 0.000003
  if (zoom >= 13) return 0.000007
  if (zoom >= 12) return 0.000015
  return 0.00003
}

function pointInGeometry(lng: number, lat: number, geometry: Geometry): boolean {
  if (geometry.type === 'Polygon') {
    return pointInPolygon(lng, lat, geometry.coordinates)
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some(polygon => pointInPolygon(lng, lat, polygon))
  }
  return false
}

function pointInPolygon(lng: number, lat: number, rings: number[][][]): boolean {
  if (rings.length === 0) return false
  if (!pointInRing(lng, lat, rings[0])) return false
  return !rings.slice(1).some(ring => pointInRing(lng, lat, ring))
}

function pointInRing(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = Number(ring[i][0])
    const yi = Number(ring[i][1])
    const xj = Number(ring[j][0])
    const yj = Number(ring[j][1])
    const intersects = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi || Number.EPSILON) + xi
    if (intersects) inside = !inside
  }
  return inside
}
