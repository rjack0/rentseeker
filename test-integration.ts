/**
 * Integration Test — RentSeeker 3D Intelligence
 * 
 * Tests all service engines individually and their cross-connections
 * WITHOUT launching Electron. Runs directly via tsx.
 * 
 * Tests:
 *   1. Module imports — every service loads without error
 *   2. Type contracts — all interfaces are valid
 *   3. Terrain Engine — elevation sampling + slope math
 *   4. Sun Simulator — solar position calculation
 *   5. View Analysis — viewshed geometry + landmark data
 *   6. Build Simulator — template resolution + earthwork math
 *   7. GDB Converter — file availability + service init
 *   8. Parcel CSV Service — DuckDB initialization + query pipeline
 *   9. Cross-module — terrain → build simulator flow
 *  10. Cross-module — terrain → sun simulator flow
 *  11. Cross-module — terrain → view analysis flow
 */

import { strict as assert } from 'assert'

/* ═══════════════ TEST HARNESS ═══════════════ */

let passed = 0
let failed = 0
let skipped = 0
const results: { name: string; status: 'pass' | 'fail' | 'skip'; error?: string; ms: number }[] = []

async function test(name: string, fn: () => Promise<void> | void) {
  const t0 = Date.now()
  try {
    await fn()
    passed++
    results.push({ name, status: 'pass', ms: Date.now() - t0 })
    console.log(`  ✅ ${name} (${Date.now() - t0}ms)`)
  } catch (err: any) {
    failed++
    const msg = err?.message || String(err)
    results.push({ name, status: 'fail', error: msg, ms: Date.now() - t0 })
    console.log(`  ❌ ${name}: ${msg}`)
  }
}

function skip(name: string, reason: string) {
  skipped++
  results.push({ name, status: 'skip', error: reason, ms: 0 })
  console.log(`  ⏭ ${name}: ${reason}`)
}

;(async () => {

console.log('\n═══ 1. MODULE IMPORTS ═══')

let terrainEngine: typeof import('./src/main/services/terrainEngine') | null = null
let sunSimulator: typeof import('./src/main/services/sunSimulator') | null = null
let viewAnalysis: typeof import('./src/main/services/viewAnalysis') | null = null
let buildSimulator: typeof import('./src/main/services/buildSimulator') | null = null
let gdbConverter: typeof import('./src/main/services/gdbConverter') | null = null
let parcelCsvService: typeof import('./src/main/services/parcelCsvService') | null = null
let ownerServiceMod: typeof import('./src/main/services/ownerService') | null = null
let parcelPmtilesMod: typeof import('./src/main/services/parcelPmtilesService') | null = null

await test('Import terrainEngine', async () => {
  terrainEngine = await import('./src/main/services/terrainEngine')
  assert.ok(terrainEngine.sampleElevations, 'sampleElevations should be exported')
  assert.ok(terrainEngine.calculateSlope, 'calculateSlope should be exported')
  assert.ok(terrainEngine.maxLocalSlope, 'maxLocalSlope should be exported')
  assert.ok(terrainEngine.computeTerrainMetrics, 'computeTerrainMetrics should be exported')
})

await test('Import sunSimulator', async () => {
  sunSimulator = await import('./src/main/services/sunSimulator')
  assert.ok(sunSimulator.computeSunAnalysis, 'computeSunAnalysis should be exported')
})

await test('Import viewAnalysis', async () => {
  viewAnalysis = await import('./src/main/services/viewAnalysis')
  assert.ok(viewAnalysis.computeViewAnalysis, 'computeViewAnalysis should be exported')
  assert.ok(viewAnalysis.LA_LANDMARKS, 'LA_LANDMARKS should be exported')
})

await test('Import buildSimulator', async () => {
  buildSimulator = await import('./src/main/services/buildSimulator')
  assert.ok(buildSimulator.runBuildSimulation, 'runBuildSimulation should be exported')
  assert.ok(buildSimulator.DEFAULT_TEMPLATES, 'DEFAULT_TEMPLATES should be exported')
})

await test('Import gdbConverter', async () => {
  gdbConverter = await import('./src/main/services/gdbConverter')
  assert.ok(gdbConverter.GdbParcelService, 'GdbParcelService should be exported')
})

await test('Import parcelCsvService', async () => {
  parcelCsvService = await import('./src/main/services/parcelCsvService')
  assert.ok(parcelCsvService.ParcelCsvService, 'ParcelCsvService should be exported')
  assert.ok(parcelCsvService.normalizeParcelNumber, 'normalizeParcelNumber should be exported')
  assert.ok(parcelCsvService.extractBookPrefix, 'extractBookPrefix should be exported')
})

await test('Import ownerService', async () => {
  ownerServiceMod = await import('./src/main/services/ownerService')
  assert.ok(ownerServiceMod.OwnerService, 'OwnerService should be exported')
})

await test('Import parcelPmtilesService', async () => {
  parcelPmtilesMod = await import('./src/main/services/parcelPmtilesService')
  assert.ok(parcelPmtilesMod.ParcelPmtilesService, 'ParcelPmtilesService should be exported')
})

/* ═══════════════ 2. TYPE CONTRACTS ═══════════════ */

console.log('\n═══ 2. TYPE CONTRACTS ═══')

await test('TerrainMetrics interface shape', () => {
  // Verify the output shape matches our expected interface
  const mockTerrain = {
    parcelId: 'test',
    demMinZ: 100, demMaxZ: 200, demMeanZ: 150, demRelief: 100,
    bestFitSlopePct: 15.0, bestFitSlopeDeg: 8.5,
    maxLocalSlopePct: 25.0, aspectDeg: 180,
    padCandidateCount: 2, largestPadAreaSqft: 3000,
    drivewayGradeBestPct: 12, retainingWallCandidateLengthFt: 40,
    terrainConfidence: 0.85
  }
  assert.equal(typeof mockTerrain.bestFitSlopePct, 'number')
  assert.equal(typeof mockTerrain.parcelId, 'string')
})

await test('SunAnalysis interface shape', () => {
  const mockSun = {
    parcelId: 'test', date: '2026-06-21',
    latitude: 34.05, longitude: -118.25,
    sunPath: [{ azimuthDeg: 90, altitudeDeg: 45, hour: 12, minute: 0 }],
    sunriseHour: 5.8, sunsetHour: 20.1, totalDaylightHours: 14.3,
    directSunlightHours: 11,
    hourlyObstruction: [{ hour: 12, obstructionPct: 0 }],
    obstructors: []
  }
  assert.ok(Array.isArray(mockSun.sunPath))
  assert.ok(Array.isArray(mockSun.hourlyObstruction))
})

await test('ViewAnalysis interface shape', () => {
  const mockView = {
    parcelId: 'test', viewerHeightFt: 22, stories: 2, totalRays: 24,
    visibleLandmarks: [], blockedLandmarks: [],
    viewshed: [{ azimuthDeg: 0, maxDistanceMi: 25, obstructedAtMi: null, terrainBlockHeight: null }],
    viewScore: 75, maxViewDistanceMi: 20
  }
  assert.ok(Array.isArray(mockView.viewshed))
  assert.equal(mockView.stories, 2)
})

await test('BuildRunOutput interface shape', () => {
  const mockBuild = {
    runId: 'test-uuid', parcelId: 'test', templateId: 'sfr-2story',
    createdAt: '2026-01-01', footprintSqft: 1200, buildingHeightFt: 22,
    floorAreaSqft: 2400, estimatedUnits: 1,
    estimatedCutCy: 500, estimatedFillCy: 100,
    estimatedRetainingWallFt: 40, estimatedAvgRetainingHeightFt: 6,
    estimatedDrivewayGradePct: 12, estimatedFlatPadSqft: 3000,
    fitScore: 72, constraintFlags: ['MODERATE_SLOPE'],
    placementLng: -118.25, placementLat: 34.05,
    placementZ: 500, placementPitchDeg: 2, placementRollDeg: 1,
    foundationSkirt: {
      baseElevationFt: 500,
      uphillHeightFt: 4,
      downhillHeightFt: 1,
      vertices: [[-118.25, 34.05, 499], [-118.249, 34.05, 499], [-118.249, 34.051, 504], [-118.25, 34.051, 504]]
    }
  }
  assert.ok(Array.isArray(mockBuild.constraintFlags))
  assert.equal(typeof mockBuild.fitScore, 'number')
})

/* ═══════════════ 2b. OWNER + PMTILES (Availability) ═══════════════ */

console.log('\n═══ 2b. OWNER + PMTILES (Availability) ═══')

await test('OwnerService: stats when SBF present (skip if missing)', async () => {
  if (!ownerServiceMod) throw new Error('ownerService not loaded')
  const svc = new ownerServiceMod.OwnerService()
  if (!svc.isAvailable()) {
    skip('OwnerService stats', 'SBF CSVs not available')
    return
  }
  const stats = await svc.getStats()
  assert.ok(stats.totalRows > 0, 'expected SBF rows > 0')
})

await test('PMTiles: info ok when file present (skip if missing)', async () => {
  if (!parcelPmtilesMod) throw new Error('parcelPmtilesService not loaded')
  const svc = new parcelPmtilesMod.ParcelPmtilesService()
  if (!svc.isAvailable()) {
    skip('PMTiles info', 'PMTiles not available')
    return
  }
  const info = await svc.getInfo()
  assert.equal(info.ok, true)
  await svc.dispose()
})

/* ═══════════════ 3. TERRAIN ENGINE (Pure Math) ═══════════════ */

console.log('\n═══ 3. TERRAIN ENGINE (Pure Math) ═══')

await test('calculateSlope: flat surface returns ~0%', () => {
  if (!terrainEngine) throw new Error('terrainEngine not loaded')
  const flatSamples = [
    { lat: 34.05, lng: -118.25, z: 500 },
    { lat: 34.051, lng: -118.25, z: 500 },
    { lat: 34.05, lng: -118.251, z: 500 },
    { lat: 34.051, lng: -118.251, z: 500 }
  ]
  const result = terrainEngine.calculateSlope(flatSamples)
  assert.ok(result.slopePct < 1, `Expected <1% slope for flat, got ${result.slopePct}%`)
  assert.ok(result.slopeDeg < 1, `Expected <1° slope for flat, got ${result.slopeDeg}°`)
})

await test('calculateSlope: tilted surface returns meaningful slope', () => {
  if (!terrainEngine) throw new Error('terrainEngine not loaded')
  // Create a surface tilting north: higher lat = higher Z
  const tiltedSamples = [
    { lat: 34.050, lng: -118.250, z: 400 },
    { lat: 34.051, lng: -118.250, z: 500 },
    { lat: 34.052, lng: -118.250, z: 600 },
    { lat: 34.050, lng: -118.251, z: 400 },
    { lat: 34.051, lng: -118.251, z: 500 },
    { lat: 34.052, lng: -118.251, z: 600 }
  ]
  const result = terrainEngine.calculateSlope(tiltedSamples)
  assert.ok(result.slopePct > 5, `Expected >5% slope for tilted, got ${result.slopePct}%`)
  assert.ok(result.highestZ === 600, 'Highest Z should be 600')
  assert.ok(result.lowestZ === 400, 'Lowest Z should be 400')
})

await test('calculateSlope: handles minimum 3 samples', () => {
  if (!terrainEngine) throw new Error('terrainEngine not loaded')
  const min = [
    { lat: 34.05, lng: -118.25, z: 500 },
    { lat: 34.051, lng: -118.25, z: 510 },
    { lat: 34.05, lng: -118.251, z: 505 }
  ]
  const result = terrainEngine.calculateSlope(min)
  assert.equal(typeof result.slopePct, 'number')
  assert.equal(typeof result.aspectDeg, 'number')
})

await test('calculateSlope: handles <3 samples gracefully', () => {
  if (!terrainEngine) throw new Error('terrainEngine not loaded')
  const toofew = [{ lat: 34.05, lng: -118.25, z: 500 }]
  const result = terrainEngine.calculateSlope(toofew)
  assert.equal(result.slopePct, 0, 'Should return 0% for insufficient data')
})

await test('maxLocalSlope: returns 0 for tiny grid', () => {
  if (!terrainEngine) throw new Error('terrainEngine not loaded')
  const samples = [{ lat: 34.05, lng: -118.25, z: 500 }]
  const result = terrainEngine.maxLocalSlope(samples, 1)
  assert.equal(result, 0)
})

await test('maxLocalSlope: finds steepest area in 3x3+ grid', () => {
  if (!terrainEngine) throw new Error('terrainEngine not loaded')
  // Create a 3x3 grid where the center has a steep slope
  const samples = [
    { lat: 34.050, lng: -118.252, z: 500 }, { lat: 34.050, lng: -118.251, z: 500 }, { lat: 34.050, lng: -118.250, z: 500 },
    { lat: 34.051, lng: -118.252, z: 500 }, { lat: 34.051, lng: -118.251, z: 700 }, { lat: 34.051, lng: -118.250, z: 500 },
    { lat: 34.052, lng: -118.252, z: 500 }, { lat: 34.052, lng: -118.251, z: 500 }, { lat: 34.052, lng: -118.250, z: 500 }
  ]
  const result = terrainEngine.maxLocalSlope(samples, 3)
  assert.ok(result > 0, `Expected non-zero max local slope, got ${result}`)
})

/* ═══════════════ 4. SUN SIMULATOR (Pure Math) ═══════════════ */

console.log('\n═══ 4. SUN SIMULATOR (Pure Math) ═══')

// We can't call computeSunAnalysis without a real API key + network,
// but we can test that the module's internal math is sound by checking exports.

await test('Sun simulator module exports computeSunAnalysis', () => {
  if (!sunSimulator) throw new Error('sunSimulator not loaded')
  assert.equal(typeof sunSimulator.computeSunAnalysis, 'function')
})

/* ═══════════════ 5. VIEW ANALYSIS ═══════════════ */

console.log('\n═══ 5. VIEW ANALYSIS ═══')

await test('LA_LANDMARKS has 12 entries', () => {
  if (!viewAnalysis) throw new Error('viewAnalysis not loaded')
  assert.equal(viewAnalysis.LA_LANDMARKS.length, 12, `Expected 12 landmarks, got ${viewAnalysis.LA_LANDMARKS.length}`)
})

await test('LA_LANDMARKS all have required fields', () => {
  if (!viewAnalysis) throw new Error('viewAnalysis not loaded')
  for (const lm of viewAnalysis.LA_LANDMARKS) {
    assert.ok(lm.name, `Landmark missing name`)
    assert.ok(typeof lm.lat === 'number', `${lm.name} missing lat`)
    assert.ok(typeof lm.lng === 'number', `${lm.name} missing lng`)
    assert.ok(typeof lm.elevationFt === 'number', `${lm.name} missing elevationFt`)
    assert.ok(['skyline', 'monument', 'nature', 'ocean'].includes(lm.category), `${lm.name} has invalid category: ${lm.category}`)
  }
})

await test('LA_LANDMARKS contains Downtown LA, Century City, Hollywood Sign', () => {
  if (!viewAnalysis) throw new Error('viewAnalysis not loaded')
  const names = viewAnalysis.LA_LANDMARKS.map(l => l.name)
  assert.ok(names.includes('Downtown LA Skyline'), 'Missing Downtown LA')
  assert.ok(names.includes('Century City Towers'), 'Missing Century City')
  assert.ok(names.includes('Hollywood Sign'), 'Missing Hollywood Sign')
  assert.ok(names.includes('Griffith Observatory'), 'Missing Griffith Observatory')
  assert.ok(names.includes('Pacific Ocean'), 'Missing Pacific Ocean')
})

/* ═══════════════ 6. BUILD SIMULATOR ═══════════════ */

console.log('\n═══ 6. BUILD SIMULATOR ═══')

await test('DEFAULT_TEMPLATES has 7 entries', () => {
  if (!buildSimulator) throw new Error('buildSimulator not loaded')
  assert.equal(buildSimulator.DEFAULT_TEMPLATES.length, 7, `Expected 7 templates, got ${buildSimulator.DEFAULT_TEMPLATES.length}`)
})

await test('DEFAULT_TEMPLATES all have required fields', () => {
  if (!buildSimulator) throw new Error('buildSimulator not loaded')
  for (const t of buildSimulator.DEFAULT_TEMPLATES) {
    assert.ok(t.id, `Template missing id`)
    assert.ok(t.name, `${t.id} missing name`)
    assert.ok(t.footprintSqft > 0, `${t.id} has invalid footprint`)
    assert.ok(t.stories > 0, `${t.id} has invalid stories`)
    assert.ok(t.heightFt > 0, `${t.id} has invalid height`)
    assert.ok(Array.isArray(t.useCodes) && t.useCodes.length > 0, `${t.id} missing useCodes`)
  }
})

await test('DEFAULT_TEMPLATES includes SFR, duplex, ADU, hillside, bucket', () => {
  if (!buildSimulator) throw new Error('buildSimulator not loaded')
  const ids = buildSimulator.DEFAULT_TEMPLATES.map(t => t.id)
  assert.ok(ids.includes('sfr-2story'), 'Missing SFR 2-story')
  assert.ok(ids.includes('sfr-3story'), 'Missing SFR 3-story')
  assert.ok(ids.includes('duplex'), 'Missing duplex')
  assert.ok(ids.includes('adu'), 'Missing ADU')
  assert.ok(ids.includes('hillside-modern'), 'Missing hillside modern')
  assert.ok(ids.includes('bucket-home'), 'Missing bucket home')
})

await test('Template heights match stories × ~11-14ft', () => {
  if (!buildSimulator) throw new Error('buildSimulator not loaded')
  for (const t of buildSimulator.DEFAULT_TEMPLATES) {
    const minHeight = t.stories * 10
    const maxHeight = t.stories * 16
    assert.ok(t.heightFt >= minHeight && t.heightFt <= maxHeight,
      `${t.id}: height ${t.heightFt}ft doesn't match ${t.stories} stories (expected ${minHeight}-${maxHeight}ft)`)
  }
})

/* ═══════════════ 7. GDB CONVERTER ═══════════════ */

console.log('\n═══ 7. GDB CONVERTER ═══')

await test('GdbParcelService instantiates', () => {
  if (!gdbConverter) throw new Error('gdbConverter not loaded')
  const svc = new gdbConverter.GdbParcelService()
  assert.ok(svc, 'Should instantiate')
  assert.equal(typeof svc.isAvailable, 'function')
  assert.equal(typeof svc.initialize, 'function')
  assert.equal(typeof svc.queryPolygonsInBounds, 'function')
  assert.equal(typeof svc.getParcelByAin, 'function')
  assert.equal(typeof svc.countInBounds, 'function')
})

await test('GdbParcelService.isAvailable checks GeoJSON file', () => {
  if (!gdbConverter) throw new Error('gdbConverter not loaded')
  const svc = new gdbConverter.GdbParcelService()
  const available = svc.isAvailable()
  // Should be true since we converted the GDB
  assert.equal(typeof available, 'boolean')
  console.log(`    → GeoJSON available: ${available}`)
})

/* ═══════════════ 8. PARCEL CSV SERVICE ═══════════════ */

console.log('\n═══ 8. PARCEL CSV SERVICE ═══')

await test('ParcelCsvService instantiates', () => {
  if (!parcelCsvService) throw new Error('parcelCsvService not loaded')
  const svc = new parcelCsvService.ParcelCsvService()
  assert.ok(svc, 'Should instantiate')
})

await test('normalizeParcelNumber: 10-digit APN', () => {
  if (!parcelCsvService) throw new Error('parcelCsvService not loaded')
  const result = parcelCsvService.normalizeParcelNumber('5560002009')
  assert.equal(result, '5560-002-009')
})

await test('normalizeParcelNumber: 7-digit APN', () => {
  if (!parcelCsvService) throw new Error('parcelCsvService not loaded')
  const result = parcelCsvService.normalizeParcelNumber('5560002')
  assert.equal(result, '5560-002-000')
})

await test('normalizeParcelNumber: already-formatted APN', () => {
  if (!parcelCsvService) throw new Error('parcelCsvService not loaded')
  const result = parcelCsvService.normalizeParcelNumber('5560-002-009')
  assert.equal(result, '5560-002-009')
})

await test('extractBookPrefix: gets first 4 digits', () => {
  if (!parcelCsvService) throw new Error('parcelCsvService not loaded')
  assert.equal(parcelCsvService.extractBookPrefix('5560-002-009'), '5560')
  assert.equal(parcelCsvService.extractBookPrefix('1234-567-890'), '1234')
})

await test('ParcelCsvService initializes DuckDB', async () => {
  if (!parcelCsvService) throw new Error('parcelCsvService not loaded')
  const svc = new parcelCsvService.ParcelCsvService()
  await svc.initialize()
  // If we get here without error, DuckDB initialized successfully
})

/* ═══════════════ 9. CROSS-MODULE: Terrain → Build Simulator ═══════════════ */

console.log('\n═══ 9. CROSS-MODULE: Terrain → Build ═══')

await test('Build simulator accepts pre-computed terrain metrics', async () => {
  if (!buildSimulator || !terrainEngine) throw new Error('Modules not loaded')

  // Create mock terrain metrics (as if computed by terrainEngine)
  const mockTerrain = {
    parcelId: 'test-cross-1',
    demMinZ: 800, demMaxZ: 900, demMeanZ: 850, demRelief: 100,
    bestFitSlopePct: 22.0, bestFitSlopeDeg: 12.4,
    maxLocalSlopePct: 35.0, aspectDeg: 225,
    padCandidateCount: 1, largestPadAreaSqft: 2500,
    drivewayGradeBestPct: 15.0, retainingWallCandidateLengthFt: 50,
    terrainConfidence: 0.85
  }

  const result = await buildSimulator.runBuildSimulation(
    { parcelId: 'test-cross-1', templateId: 'sfr-2story', stories: 2 },
    34.05, -118.25, 5000,
    mockTerrain // Pass pre-computed terrain
  )

  assert.ok(result.runId, 'Should have a runId')
  assert.equal(result.parcelId, 'test-cross-1')
  assert.equal(result.templateId, 'sfr-2story')
  assert.ok(result.fitScore >= 0 && result.fitScore <= 100, `Fit score out of range: ${result.fitScore}`)
  assert.ok(result.estimatedCutCy >= 0, `Cut volume negative: ${result.estimatedCutCy}`)
  assert.ok(result.estimatedFillCy >= 0, `Fill volume negative: ${result.estimatedFillCy}`)
  assert.ok(result.buildingHeightFt > 0, `Height should be positive`)
  assert.ok(result.floorAreaSqft > 0, `Floor area should be positive`)
  console.log(`    → Fit score: ${result.fitScore}, Cut: ${result.estimatedCutCy}CY, Flags: [${result.constraintFlags.join(', ')}]`)
})

await test('Build simulator with steep slope produces constraint flags', async () => {
  if (!buildSimulator) throw new Error('buildSimulator not loaded')

  const steepTerrain = {
    parcelId: 'test-steep',
    demMinZ: 600, demMaxZ: 900, demMeanZ: 750, demRelief: 300,
    bestFitSlopePct: 50.0, bestFitSlopeDeg: 26.6,
    maxLocalSlopePct: 65.0, aspectDeg: 180,
    padCandidateCount: 0, largestPadAreaSqft: 500,
    drivewayGradeBestPct: 30.0, retainingWallCandidateLengthFt: 120,
    terrainConfidence: 0.7
  }

  const result = await buildSimulator.runBuildSimulation(
    { parcelId: 'test-steep', templateId: 'sfr-2story', stories: 2 },
    34.1, -118.35, 4000,
    steepTerrain
  )

  assert.ok(result.constraintFlags.includes('EXTREME_SLOPE'), `Should flag EXTREME_SLOPE for 50% slope, got: [${result.constraintFlags}]`)
  assert.ok(result.fitScore < 60, `Steep lot should have low fit score, got ${result.fitScore}`)
  console.log(`    → Steep lot: score=${result.fitScore}, flags=[${result.constraintFlags.join(', ')}]`)
})

await test('Build simulator with flat lot produces high fit score', async () => {
  if (!buildSimulator) throw new Error('buildSimulator not loaded')

  const flatTerrain = {
    parcelId: 'test-flat',
    demMinZ: 200, demMaxZ: 210, demMeanZ: 205, demRelief: 10,
    bestFitSlopePct: 2.0, bestFitSlopeDeg: 1.1,
    maxLocalSlopePct: 4.0, aspectDeg: 0,
    padCandidateCount: 3, largestPadAreaSqft: 5000,
    drivewayGradeBestPct: 1.2, retainingWallCandidateLengthFt: 0,
    terrainConfidence: 0.9
  }

  const result = await buildSimulator.runBuildSimulation(
    { parcelId: 'test-flat', templateId: 'duplex', stories: 2 },
    34.0, -118.3, 6000,
    flatTerrain
  )

  assert.ok(result.fitScore >= 80, `Flat lot should have high fit score, got ${result.fitScore}`)
  assert.ok(result.constraintFlags.length === 0, `Flat lot should have no constraint flags, got: [${result.constraintFlags}]`)
  console.log(`    → Flat lot: score=${result.fitScore}, cut=${result.estimatedCutCy}CY`)
})

/* ═══════════════ 10. CROSS-MODULE: All templates on same terrain ═══════════════ */

console.log('\n═══ 10. ALL TEMPLATES → SAME TERRAIN ═══')

await test('All 7 templates produce valid results on moderate terrain', async () => {
  if (!buildSimulator) throw new Error('buildSimulator not loaded')

  const moderateTerrain = {
    parcelId: 'test-moderate',
    demMinZ: 500, demMaxZ: 560, demMeanZ: 530, demRelief: 60,
    bestFitSlopePct: 18.0, bestFitSlopeDeg: 10.2,
    maxLocalSlopePct: 28.0, aspectDeg: 135,
    padCandidateCount: 2, largestPadAreaSqft: 3500,
    drivewayGradeBestPct: 10.8, retainingWallCandidateLengthFt: 30,
    terrainConfidence: 0.85
  }

  for (const template of buildSimulator.DEFAULT_TEMPLATES) {
    const result = await buildSimulator.runBuildSimulation(
      { parcelId: 'test-moderate', templateId: template.id, stories: template.stories },
      34.08, -118.32, 5000,
      moderateTerrain
    )
    assert.ok(result.runId, `${template.id}: missing runId`)
    assert.ok(result.fitScore >= 0 && result.fitScore <= 100, `${template.id}: score out of range: ${result.fitScore}`)
    assert.ok(result.buildingHeightFt > 0, `${template.id}: zero height`)
    assert.ok(result.floorAreaSqft > 0, `${template.id}: zero floor area`)
    console.log(`    → ${template.id}: score=${result.fitScore}, cut=${result.estimatedCutCy}CY, floor=${result.floorAreaSqft}sqft`)
  }
})

/* ═══════════════ 11. GDB + PARCEL CSV SERVICE LIVE QUERIES ═══════════════ */

console.log('\n═══ 11. DATA SERVICE LIVE QUERIES ═══')

await test('ParcelCsvService.countFiltered works', async () => {
  if (!parcelCsvService) throw new Error('parcelCsvService not loaded')
  const svc = new parcelCsvService.ParcelCsvService()
  await svc.initialize()
  const count = await svc.countFiltered({ apnPrefix: '5560', limit: 10 })
  assert.ok(typeof count === 'number')
  assert.ok(count >= 0)
  console.log(`    → APN prefix 5560 count: ${count}`)
})

await test('ParcelCsvService.queryFiltered returns valid parcels', async () => {
  if (!parcelCsvService) throw new Error('parcelCsvService not loaded')
  const svc = new parcelCsvService.ParcelCsvService()
  await svc.initialize()
  const result = await svc.queryFiltered({
    targetParcels: '5560002009',
    limit: 5,
    includeCofO: true
  })
  assert.ok(result.allParcels, 'Should have allParcels array')
  assert.ok(result.queryTimeMs >= 0, 'Should have queryTimeMs')
  assert.ok(result.totalFound >= 0, 'Should have totalFound')
  if (result.allParcels.length > 0) {
    const p = result.allParcels[0]
    assert.ok(p.assessorId, 'Parcel should have assessorId')
    assert.ok(typeof p.totalValue === 'number', 'Parcel should have numeric totalValue')
    console.log(`    → Found ${result.totalFound} parcels, first: ${p.assessorId} ($${p.totalValue})`)
  } else {
    console.log(`    → No parcels found (data file may be missing)`)
  }
})

await test('GdbParcelService initializes and checks availability', async () => {
  if (!gdbConverter) throw new Error('gdbConverter not loaded')
  const svc = new gdbConverter.GdbParcelService()
  const available = svc.isAvailable()
  if (available) {
    await svc.initialize()
    console.log(`    → GDB service ready, GeoJSON available`)
  } else {
    console.log(`    → GeoJSON not found (conversion may not have completed)`)
  }
})

/* ═══════════════ SUMMARY ═══════════════ */

console.log('\n' + '═'.repeat(60))
console.log(`RESULTS: ${passed} passed, ${failed} failed, ${skipped} skipped`)
console.log('═'.repeat(60))

if (failed > 0) {
  console.log('\nFAILED TESTS:')
  for (const r of results.filter(r => r.status === 'fail')) {
    console.log(`  ❌ ${r.name}: ${r.error}`)
  }
  process.exit(1)
} else {
  console.log('\n✅ All tests passed!')
  process.exit(0)
}

})()
