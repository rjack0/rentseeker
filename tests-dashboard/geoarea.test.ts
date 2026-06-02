import { describe, it, expect } from 'vitest'
import { geometryAreaSqft } from '../src/main/services/geoArea'

describe('geoArea', () => {
  it('computes polygon area in sqft', () => {
    const geom = {
      type: 'Polygon',
      coordinates: [[
        [-118.0, 34.0],
        [-118.0, 34.001],
        [-117.999, 34.001],
        [-117.999, 34.0],
        [-118.0, 34.0]
      ]]
    } as any
    const area = geometryAreaSqft(geom)
    expect(area).toBeGreaterThan(0)
    // Rough magnitude sanity: a 0.001° square is big; just assert it's not tiny.
    expect(area).toBeGreaterThan(10000)
  })
})

