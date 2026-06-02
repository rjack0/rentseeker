/**
 * ParcelPmtilesService — Local PMTiles (MVT) reader for LA County parcels.
 *
 * Renderer uses MapLibre vector layers backed by a custom `pmtiles://` protocol.
 * The protocol implementation in the renderer fetches tiles over IPC from this
 * service, so the renderer never needs filesystem access.
 */

import { open, type FileHandle } from 'fs/promises'
import { existsSync } from 'fs'
import { PMTiles, type Source, type RangeResponse, type Header } from 'pmtiles'
import { gunzipSync } from 'zlib'
import { performance } from 'perf_hooks'

import type { ParcelPmtilesStats, ParcelPmtilesTileStat } from '@shared/types'

export interface ParcelPmtilesInfo {
  ok: boolean
  path?: string
  minZoom?: number
  maxZoom?: number
  bounds?: [number, number, number, number]
  center?: [number, number, number]
  vectorLayers?: Array<{ id: string; fields: Record<string, string> }>
  tileType?: number
  tileCompression?: number
  error?: string
}

class NodePathSource implements Source {
  private path: string
  private handle: FileHandle | null = null

  constructor(path: string) {
    this.path = path
  }

  getKey(): string {
    return this.path
  }

  private async ensureHandle(): Promise<FileHandle> {
    if (this.handle) return this.handle
    this.handle = await open(this.path, 'r')
    return this.handle
  }

  async close(): Promise<void> {
    const handle = this.handle
    this.handle = null
    if (handle) {
      try {
        await handle.close()
      } catch {
        // Ignore close errors; best-effort cleanup.
      }
    }
  }

  async getBytes(offset: number, length: number, signal?: AbortSignal): Promise<RangeResponse> {
    if (signal?.aborted) {
      throw Object.assign(new Error('Aborted'), { name: 'AbortError' })
    }
    const handle = await this.ensureHandle()
    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await handle.read(buffer, 0, length, offset)
    const view = bytesRead === buffer.byteLength ? buffer : buffer.subarray(0, bytesRead)
    const arrayBuffer = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)
    if (signal?.aborted) {
      throw Object.assign(new Error('Aborted'), { name: 'AbortError' })
    }
    return { data: arrayBuffer }
  }
}

const PMTILES_PATH = '/Users/rjack/Desktop/almanac/Docs/RE Data/parcel_geojson/LACounty_Parcels.pmtiles'

export class ParcelPmtilesService {
  private pmtiles: PMTiles | null = null
  private header: Header | null = null
  private metadata: any | null = null
  private initializing: Promise<void> | null = null
  private source: NodePathSource | null = null
  private tileCache = new Map<string, Uint8Array>()
  private tileCacheLimit = 2000

  private statsRequests = 0
  private statsCacheHits = 0
  private statsSumTotalMs = 0
  private statsSumIoMs = 0
  private statsSumGunzipMs = 0
  private statsRecent: ParcelPmtilesTileStat[] = []
  private statsRecentLimit = 80

  private async init(): Promise<void> {
    if (this.initializing) return this.initializing
    this.initializing = (async () => {
      if (!existsSync(PMTILES_PATH)) {
        this.pmtiles = null
        this.header = null
        this.metadata = null
        if (this.source) await this.source.close()
        this.source = null
        return
      }
      if (!this.source) this.source = new NodePathSource(PMTILES_PATH)
      this.pmtiles = new PMTiles(this.source)
      this.header = await this.pmtiles.getHeader()
      this.metadata = await this.pmtiles.getMetadata()
    })().finally(() => {
      this.initializing = null
    })
    return this.initializing
  }

  async dispose(): Promise<void> {
    if (this.source) {
      await this.source.close()
      this.source = null
    }
    this.pmtiles = null
    this.header = null
    this.metadata = null
    this.tileCache.clear()
    this.resetStats()
  }

  isAvailable(): boolean {
    return existsSync(PMTILES_PATH)
  }

  async getInfo(): Promise<ParcelPmtilesInfo> {
    if (!this.isAvailable()) {
      return { ok: false, error: `PMTiles file not found at ${PMTILES_PATH}` }
    }
    await this.init()
    if (!this.pmtiles || !this.header) {
      return { ok: false, error: 'PMTiles reader failed to initialize.' }
    }
    const meta = this.metadata ?? {}
    return {
      ok: true,
      path: PMTILES_PATH,
      minZoom: this.header.minZoom,
      maxZoom: this.header.maxZoom,
      bounds: [this.header.minLon, this.header.minLat, this.header.maxLon, this.header.maxLat],
      center: [this.header.centerLon, this.header.centerLat, this.header.centerZoom],
      vectorLayers: Array.isArray(meta.vector_layers)
        ? meta.vector_layers.map((layer: any) => ({ id: String(layer.id), fields: layer.fields ?? {} }))
        : [],
      tileType: this.header.tileType,
      tileCompression: this.header.tileCompression
    }
  }

  async getTile(z: number, x: number, y: number, signal?: AbortSignal): Promise<Uint8Array | null> {
    if (!this.isAvailable()) return null
    await this.init()
    if (!this.pmtiles) return null
    const key = `${z}/${x}/${y}`
    const cached = this.tileCache.get(key)
    if (cached) {
      // refresh LRU
      this.tileCache.delete(key)
      this.tileCache.set(key, cached)
      this.statsRequests += 1
      this.statsCacheHits += 1
      this.recordStat({ z, x, y, bytes: cached.byteLength, cacheHit: true, ioMs: 0, gunzipMs: 0, totalMs: 0, at: Date.now() })
      return cached
    }
    const t0 = performance.now()
    const tIo0 = performance.now()
    const resp = await this.pmtiles.getZxy(z, x, y, signal)
    const ioMs = Math.max(0, performance.now() - tIo0)
    if (!resp) return null
    const raw = new Uint8Array(resp.data)
    // MapLibre expects an uncompressed MVT PBF payload. PMTiles archives commonly store tiles gzipped.
    const compression = this.header?.tileCompression
    const looksGz = raw.byteLength >= 2 && raw[0] === 0x1f && raw[1] === 0x8b
    if (compression === 2 || looksGz) {
      try {
        const tGz0 = performance.now()
        const unz = gunzipSync(Buffer.from(raw))
        const gunzipMs = Math.max(0, performance.now() - tGz0)
        const bytes = new Uint8Array(unz.buffer.slice(unz.byteOffset, unz.byteOffset + unz.byteLength))
        this.tileCache.set(key, bytes)
        if (this.tileCache.size > this.tileCacheLimit) {
          const first = this.tileCache.keys().next().value
          if (first) this.tileCache.delete(first)
        }
        const totalMs = Math.max(0, performance.now() - t0)
        this.statsRequests += 1
        this.statsSumIoMs += ioMs
        this.statsSumGunzipMs += gunzipMs
        this.statsSumTotalMs += totalMs
        this.recordStat({ z, x, y, bytes: bytes.byteLength, cacheHit: false, ioMs, gunzipMs, totalMs, at: Date.now() })
        return bytes
      } catch {
        // If decompression fails, fall back to raw bytes.
        this.tileCache.set(key, raw)
        if (this.tileCache.size > this.tileCacheLimit) {
          const first = this.tileCache.keys().next().value
          if (first) this.tileCache.delete(first)
        }
        const totalMs = Math.max(0, performance.now() - t0)
        this.statsRequests += 1
        this.statsSumIoMs += ioMs
        this.statsSumTotalMs += totalMs
        this.recordStat({ z, x, y, bytes: raw.byteLength, cacheHit: false, ioMs, gunzipMs: 0, totalMs, at: Date.now() })
        return raw
      }
    }
    this.tileCache.set(key, raw)
    if (this.tileCache.size > this.tileCacheLimit) {
      const first = this.tileCache.keys().next().value
      if (first) this.tileCache.delete(first)
    }
    const totalMs = Math.max(0, performance.now() - t0)
    this.statsRequests += 1
    this.statsSumIoMs += ioMs
    this.statsSumTotalMs += totalMs
    this.recordStat({ z, x, y, bytes: raw.byteLength, cacheHit: false, ioMs, gunzipMs: 0, totalMs, at: Date.now() })
    return raw
  }

  private recordStat(stat: ParcelPmtilesTileStat): void {
    this.statsRecent.unshift(stat)
    if (this.statsRecent.length > this.statsRecentLimit) this.statsRecent.length = this.statsRecentLimit
  }

  resetStats(): void {
    this.statsRequests = 0
    this.statsCacheHits = 0
    this.statsSumTotalMs = 0
    this.statsSumIoMs = 0
    this.statsSumGunzipMs = 0
    this.statsRecent = []
  }

  getStats(): ParcelPmtilesStats {
    const req = this.statsRequests
    const cacheHits = this.statsCacheHits
    const cacheHitPct = req > 0 ? (cacheHits / req) * 100 : 0
    const avgTotalMs = req > 0 ? this.statsSumTotalMs / req : 0
    const avgIoMs = req > 0 ? this.statsSumIoMs / req : 0
    const avgGunzipMs = req > 0 ? this.statsSumGunzipMs / req : 0
    const totals = this.statsRecent.map(s => s.totalMs).filter(n => Number.isFinite(n) && n > 0).sort((a, b) => a - b)
    const p95TotalMs = totals.length ? totals[Math.min(totals.length - 1, Math.floor(totals.length * 0.95))] : 0
    return {
      available: this.isAvailable(),
      requests: req,
      cacheHits,
      cacheHitPct,
      avgTotalMs,
      avgIoMs,
      avgGunzipMs,
      p95TotalMs,
      last: [...this.statsRecent]
    }
  }
}
