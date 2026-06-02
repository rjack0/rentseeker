import { describe, it, expect } from 'vitest'
import { ParcelPmtilesService } from '../src/main/services/parcelPmtilesService'

function lonLatToTile(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z
  const x = Math.floor(((lon + 180) / 360) * n)
  const latRad = (lat * Math.PI) / 180
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n)
  return { x, y }
}

describe('PMTiles parcel boundaries', () => {
  it('exposes vector layer metadata', async () => {
    const svc = new ParcelPmtilesService()
    if (!svc.isAvailable()) {
      // Local data not present in this environment; skip rather than fail.
      return
    }
    const info = await svc.getInfo()
    expect(info.ok).toBe(true)
    expect(info.vectorLayers?.some(l => l.id === 'parcels')).toBe(true)
    await svc.dispose()
  })

  it('returns decompressed MVT tiles (not gzipped)', async () => {
    const svc = new ParcelPmtilesService()
    if (!svc.isAvailable()) return
    const info = await svc.getInfo()
    expect(info.ok).toBe(true)
    const center = info.center
    expect(center).toBeTruthy()
    const z = (center?.[2] ?? info.minZoom ?? 10) as number
    const lon = (center?.[0] ?? -118.4) as number
    const lat = (center?.[1] ?? 34.1) as number
    const tileZ = Math.max(10, Math.min(15, Math.floor(z)))
    const { x, y } = lonLatToTile(lon, lat, tileZ)
    const bytes = await svc.getTile(tileZ, x, y)
    expect(bytes).toBeTruthy()
    if (!bytes) return
    // If gzipped, first bytes would be 0x1f, 0x8b.
    expect(bytes[0]).not.toBe(0x1f)
    expect(bytes[1]).not.toBe(0x8b)
    await svc.dispose()
  })
})
