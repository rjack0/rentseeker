import type { BuildRunInput, BuildRunOutput, ParcelRecord, SunAnalysis, TerrainMetrics, ViewAnalysis } from '@shared/types'

export interface ParcelAnalysisDb {
  exec(sql: string): Promise<void>
  query(sql: string): Promise<Record<string, unknown>[]>
}

function sqlString(value: unknown): string {
  if (value == null) return 'NULL'
  return `'${String(value).replace(/'/g, "''")}'`
}

function sqlNumber(value: unknown): string {
  const n = Number(value)
  return Number.isFinite(n) ? String(n) : 'NULL'
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null)
}

export const PARCEL_ANALYSIS_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS parcel_terrain_metrics (
    parcel_id VARCHAR PRIMARY KEY,
    dem_min_z DOUBLE,
    dem_max_z DOUBLE,
    dem_mean_z DOUBLE,
    dem_relief DOUBLE,
    slope_pct DOUBLE,
    slope_deg DOUBLE,
    max_local_slope_pct DOUBLE,
    aspect_deg DOUBLE,
    pad_candidate_count INTEGER,
    largest_pad_area_sqft DOUBLE,
    driveway_grade_best_pct DOUBLE,
    retaining_wall_candidate_length_ft DOUBLE,
    terrain_confidence DOUBLE,
    geometry_hash VARCHAR,
    updated_at TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS parcel_terrain_products (
    product_id VARCHAR PRIMARY KEY,
    parcel_id VARCHAR,
    product_type VARCHAR,
    payload_json VARCHAR,
    created_at TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS build_runs (
    run_id VARCHAR PRIMARY KEY,
    parcel_id VARCHAR,
    template_id VARCHAR,
    stories INTEGER,
    geometry_hash VARCHAR,
    input_json VARCHAR,
    terrain_metric_json VARCHAR,
    created_at TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS build_run_outputs (
    run_id VARCHAR PRIMARY KEY,
    parcel_id VARCHAR,
    geometry_hash VARCHAR,
    footprint_sqft DOUBLE,
    building_height_ft DOUBLE,
    floor_area_sqft DOUBLE,
    estimated_units INTEGER,
    estimated_cut_cy DOUBLE,
    estimated_fill_cy DOUBLE,
    estimated_retaining_wall_ft DOUBLE,
    estimated_avg_retaining_height_ft DOUBLE,
    estimated_driveway_grade_pct DOUBLE,
    estimated_flat_pad_sqft DOUBLE,
    fit_score DOUBLE,
    constraint_flags_json VARCHAR,
    placement_lng DOUBLE,
    placement_lat DOUBLE,
    placement_z DOUBLE,
    placement_pitch_deg DOUBLE,
    placement_roll_deg DOUBLE,
    foundation_skirt_json VARCHAR,
    output_json VARCHAR
  )`,
  `CREATE TABLE IF NOT EXISTS parcel_sun_analysis (
    analysis_id VARCHAR PRIMARY KEY,
    parcel_id VARCHAR,
    analysis_date VARCHAR,
    direct_sunlight_hours DOUBLE,
    total_daylight_hours DOUBLE,
    analysis_json VARCHAR,
    geometry_hash VARCHAR,
    updated_at TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS parcel_view_analysis (
    analysis_id VARCHAR PRIMARY KEY,
    parcel_id VARCHAR,
    stories INTEGER,
    viewer_height_ft DOUBLE,
    view_score DOUBLE,
    max_view_distance_mi DOUBLE,
    analysis_json VARCHAR,
    geometry_hash VARCHAR,
    updated_at TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS spatial_tile_index (
    tile_id VARCHAR PRIMARY KEY,
    west DOUBLE,
    south DOUBLE,
    east DOUBLE,
    north DOUBLE,
    source_url VARCHAR,
    content_hash VARCHAR,
    cached_at TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS parcel_spatial_index (
    parcel_id VARCHAR,
    tile_id VARCHAR,
    intersection_confidence DOUBLE,
    updated_at TIMESTAMP,
    PRIMARY KEY (parcel_id, tile_id)
  )`
]

export const PARCEL_ANALYSIS_SCHEMA_ALTER_SQL = [
  `ALTER TABLE parcel_terrain_metrics ADD COLUMN IF NOT EXISTS geometry_hash VARCHAR`,
  `ALTER TABLE parcel_sun_analysis ADD COLUMN IF NOT EXISTS geometry_hash VARCHAR`,
  `ALTER TABLE parcel_view_analysis ADD COLUMN IF NOT EXISTS geometry_hash VARCHAR`,
  `ALTER TABLE build_runs ADD COLUMN IF NOT EXISTS geometry_hash VARCHAR`,
  `ALTER TABLE build_run_outputs ADD COLUMN IF NOT EXISTS geometry_hash VARCHAR`
]

export async function recordTerrainMetrics(
  db: ParcelAnalysisDb,
  metrics: TerrainMetrics,
  product: unknown,
  geometryHash = ''
): Promise<void> {
  await db.exec(`
    INSERT OR REPLACE INTO parcel_terrain_metrics (
      parcel_id, dem_min_z, dem_max_z, dem_mean_z, dem_relief, slope_pct, slope_deg,
      max_local_slope_pct, aspect_deg, pad_candidate_count, largest_pad_area_sqft,
      driveway_grade_best_pct, retaining_wall_candidate_length_ft, terrain_confidence, geometry_hash, updated_at
    ) VALUES (
      ${sqlString(metrics.parcelId)}, ${sqlNumber(metrics.demMinZ)}, ${sqlNumber(metrics.demMaxZ)},
      ${sqlNumber(metrics.demMeanZ)}, ${sqlNumber(metrics.demRelief)}, ${sqlNumber(metrics.bestFitSlopePct)},
      ${sqlNumber(metrics.bestFitSlopeDeg)}, ${sqlNumber(metrics.maxLocalSlopePct)}, ${sqlNumber(metrics.aspectDeg)},
      ${sqlNumber(metrics.padCandidateCount)}, ${sqlNumber(metrics.largestPadAreaSqft)},
      ${sqlNumber(metrics.drivewayGradeBestPct)}, ${sqlNumber(metrics.retainingWallCandidateLengthFt)},
      ${sqlNumber(metrics.terrainConfidence)}, ${sqlString(geometryHash)}, now()
    )
  `)

  await db.exec(`
    INSERT INTO parcel_terrain_products (product_id, parcel_id, product_type, payload_json, created_at)
    VALUES (${sqlString(`${metrics.parcelId}:${Date.now()}`)}, ${sqlString(metrics.parcelId)}, 'surface_grid', ${sqlString(json(product))}, now())
  `)
}

export async function getTerrainMetrics(db: ParcelAnalysisDb, parcelId: string, geometryHash = ''): Promise<TerrainMetrics | null> {
  const clean = parcelId.replace(/'/g, "''")
  const rows = await db.query(`
    SELECT
      parcel_id,
      dem_min_z,
      dem_max_z,
      dem_mean_z,
      dem_relief,
      slope_pct,
      slope_deg,
      max_local_slope_pct,
      aspect_deg,
      pad_candidate_count,
      largest_pad_area_sqft,
      driveway_grade_best_pct,
      retaining_wall_candidate_length_ft,
      terrain_confidence
    FROM parcel_terrain_metrics
    WHERE parcel_id = '${clean}'
      ${geometryHash ? `AND COALESCE(geometry_hash, '') = '${geometryHash.replace(/'/g, "''")}'` : ''}
    LIMIT 1
  `)
  if (rows.length === 0) return null
  const row = rows[0]
  return {
    parcelId: String(row.parcel_id ?? parcelId),
    demMinZ: Number(row.dem_min_z ?? 0) || 0,
    demMaxZ: Number(row.dem_max_z ?? 0) || 0,
    demMeanZ: Number(row.dem_mean_z ?? 0) || 0,
    demRelief: Number(row.dem_relief ?? 0) || 0,
    bestFitSlopePct: Number(row.slope_pct ?? 0) || 0,
    bestFitSlopeDeg: Number(row.slope_deg ?? 0) || 0,
    maxLocalSlopePct: Number(row.max_local_slope_pct ?? 0) || 0,
    aspectDeg: Number(row.aspect_deg ?? 0) || 0,
    padCandidateCount: Number(row.pad_candidate_count ?? 0) || 0,
    largestPadAreaSqft: Number(row.largest_pad_area_sqft ?? 0) || 0,
    drivewayGradeBestPct: Number(row.driveway_grade_best_pct ?? 0) || 0,
    retainingWallCandidateLengthFt: Number(row.retaining_wall_candidate_length_ft ?? 0) || 0,
    terrainConfidence: Number(row.terrain_confidence ?? 0) || 0
  }
}

export async function getLatestTerrainProduct(db: ParcelAnalysisDb, parcelId: string, productType = 'surface_grid'): Promise<any | null> {
  const cleanId = parcelId.replace(/'/g, "''")
  const cleanType = productType.replace(/'/g, "''")
  const rows = await db.query(`
    SELECT payload_json
    FROM parcel_terrain_products
    WHERE parcel_id = '${cleanId}' AND product_type = '${cleanType}'
    ORDER BY created_at DESC
    LIMIT 1
  `)
  if (rows.length === 0) return null
  const text = String(rows[0]?.payload_json ?? '')
  try { return JSON.parse(text) } catch { return null }
}

export async function getSqftCheck(db: ParcelAnalysisDb, parcelId: string): Promise<{ geometricSqft: number; neighborMedianSqft: number; status: string } | null> {
  const clean = parcelId.replace(/'/g, "''")
  const rows = await db.query(`
    SELECT geometric_sqft, neighbor_median_sqft, sqft_check_status
    FROM parcel_master
    WHERE parcel_id = '${clean}'
    LIMIT 1
  `)
  if (rows.length === 0) return null
  const row = rows[0]
  const geometricSqft = Number(row.geometric_sqft ?? 0) || 0
  const neighborMedianSqft = Number(row.neighbor_median_sqft ?? 0) || 0
  const status = String(row.sqft_check_status ?? '').trim()
  if (!geometricSqft && !neighborMedianSqft && !status) return null
  return { geometricSqft, neighborMedianSqft, status }
}

export async function recordSqftCheck(db: ParcelAnalysisDb, parcelId: string, geometricSqft: number, neighborMedianSqft: number, status: string): Promise<void> {
  await db.exec(`
    UPDATE parcel_master
    SET geometric_sqft = ${sqlNumber(geometricSqft)},
        neighbor_median_sqft = ${sqlNumber(neighborMedianSqft)},
        sqft_check_status = ${sqlString(status)},
        updated_at = now()
    WHERE parcel_id = ${sqlString(parcelId)}
  `)
}

export async function recordBuildRun(db: ParcelAnalysisDb, input: BuildRunInput, output: BuildRunOutput, terrain: TerrainMetrics, geometryHash = ''): Promise<void> {
  await db.exec(`
    INSERT OR REPLACE INTO build_runs (
      run_id, parcel_id, template_id, stories, geometry_hash, input_json, terrain_metric_json, created_at
    ) VALUES (
      ${sqlString(output.runId)}, ${sqlString(input.parcelId)}, ${sqlString(input.templateId)},
      ${sqlNumber(input.stories)}, ${sqlString(geometryHash)},
      ${sqlString(json(input))}, ${sqlString(json(terrain))}, ${sqlString(output.createdAt)}
    )
  `)
  await db.exec(`
    INSERT OR REPLACE INTO build_run_outputs (
      run_id, parcel_id, geometry_hash, footprint_sqft, building_height_ft, floor_area_sqft, estimated_units,
      estimated_cut_cy, estimated_fill_cy, estimated_retaining_wall_ft, estimated_avg_retaining_height_ft,
      estimated_driveway_grade_pct, estimated_flat_pad_sqft, fit_score, constraint_flags_json,
      placement_lng, placement_lat, placement_z, placement_pitch_deg, placement_roll_deg,
      foundation_skirt_json, output_json
    ) VALUES (
      ${sqlString(output.runId)}, ${sqlString(output.parcelId)}, ${sqlString(geometryHash)},
      ${sqlNumber(output.footprintSqft)},
      ${sqlNumber(output.buildingHeightFt)}, ${sqlNumber(output.floorAreaSqft)}, ${sqlNumber(output.estimatedUnits)},
      ${sqlNumber(output.estimatedCutCy)}, ${sqlNumber(output.estimatedFillCy)}, ${sqlNumber(output.estimatedRetainingWallFt)},
      ${sqlNumber(output.estimatedAvgRetainingHeightFt)}, ${sqlNumber(output.estimatedDrivewayGradePct)},
      ${sqlNumber(output.estimatedFlatPadSqft)}, ${sqlNumber(output.fitScore)},
      ${sqlString(json(output.constraintFlags))}, ${sqlNumber(output.placementLng)}, ${sqlNumber(output.placementLat)},
      ${sqlNumber(output.placementZ)}, ${sqlNumber(output.placementPitchDeg)}, ${sqlNumber(output.placementRollDeg)},
      ${sqlString(json(output.foundationSkirt))}, ${sqlString(json(output))}
    )
  `)
}

export async function getBuildRunsForParcel(db: ParcelAnalysisDb, parcelId: string, geometryHash = ''): Promise<BuildRunOutput[]> {
  const clean = parcelId.replace(/'/g, "''")
  const rows = await db.query(`
    SELECT o.output_json, r.stories AS stories
    FROM build_run_outputs o
    LEFT JOIN build_runs r ON r.run_id = o.run_id
    WHERE o.parcel_id = '${clean}'
      ${geometryHash ? `AND COALESCE(o.geometry_hash, '') = '${geometryHash.replace(/'/g, "''")}'` : ''}
    ORDER BY r.created_at DESC NULLS LAST
    LIMIT 50
  `)
  return rows
    .map(row => {
      try {
        const parsed = JSON.parse(String(row.output_json ?? 'null')) as BuildRunOutput | null
        if (parsed && (parsed.stories == null || Number.isNaN(Number(parsed.stories)))) {
          parsed.stories = Number(row.stories ?? 0) || 0
        }
        return parsed
      } catch {
        return null
      }
    })
    .filter((row): row is BuildRunOutput => row != null)
}

export async function recordSunAnalysis(db: ParcelAnalysisDb, analysis: SunAnalysis, geometryHash = ''): Promise<void> {
  await db.exec(`
    INSERT OR REPLACE INTO parcel_sun_analysis (
      analysis_id, parcel_id, analysis_date, direct_sunlight_hours, total_daylight_hours,
      analysis_json, geometry_hash, updated_at
    ) VALUES (
      ${sqlString(`${analysis.parcelId}:${analysis.date}`)}, ${sqlString(analysis.parcelId)},
      ${sqlString(analysis.date)}, ${sqlNumber(analysis.directSunlightHours)},
      ${sqlNumber(analysis.totalDaylightHours)}, ${sqlString(json(analysis))}, ${sqlString(geometryHash)}, now()
    )
  `)
}

export async function getSunAnalysis(db: ParcelAnalysisDb, parcelId: string, date: string, geometryHash = ''): Promise<SunAnalysis | null> {
  const rows = await db.query(`
    SELECT analysis_json
    FROM parcel_sun_analysis
    WHERE analysis_id = ${sqlString(`${parcelId}:${date}`)}
      ${geometryHash ? `AND COALESCE(geometry_hash, '') = '${geometryHash.replace(/'/g, "''")}'` : ''}
    LIMIT 1
  `)
  if (rows.length === 0) return null
  try {
    return JSON.parse(String(rows[0].analysis_json ?? 'null')) as SunAnalysis
  } catch {
    return null
  }
}

export async function recordViewAnalysis(db: ParcelAnalysisDb, analysis: ViewAnalysis, geometryHash = ''): Promise<void> {
  await db.exec(`
    INSERT OR REPLACE INTO parcel_view_analysis (
      analysis_id, parcel_id, stories, viewer_height_ft, view_score,
      max_view_distance_mi, analysis_json, geometry_hash, updated_at
    ) VALUES (
      ${sqlString(`${analysis.parcelId}:${analysis.stories}`)}, ${sqlString(analysis.parcelId)},
      ${sqlNumber(analysis.stories)}, ${sqlNumber(analysis.viewerHeightFt)},
      ${sqlNumber(analysis.viewScore)}, ${sqlNumber(analysis.maxViewDistanceMi)},
      ${sqlString(json(analysis))}, ${sqlString(geometryHash)}, now()
    )
  `)
}

export async function getViewAnalysis(db: ParcelAnalysisDb, parcelId: string, stories: number, geometryHash = ''): Promise<ViewAnalysis | null> {
  const rows = await db.query(`
    SELECT analysis_json
    FROM parcel_view_analysis
    WHERE analysis_id = ${sqlString(`${parcelId}:${stories}`)}
      ${geometryHash ? `AND COALESCE(geometry_hash, '') = '${geometryHash.replace(/'/g, "''")}'` : ''}
    LIMIT 1
  `)
  if (rows.length === 0) return null
  try {
    return JSON.parse(String(rows[0].analysis_json ?? 'null')) as ViewAnalysis
  } catch {
    return null
  }
}

export async function recordSpatialTile(db: ParcelAnalysisDb, tileId: string, bbox: { west: number; south: number; east: number; north: number }, sourceUrl: string): Promise<void> {
  await db.exec(`
    INSERT OR REPLACE INTO spatial_tile_index (tile_id, west, south, east, north, source_url, content_hash, cached_at)
    VALUES (
      ${sqlString(tileId)}, ${sqlNumber(bbox.west)}, ${sqlNumber(bbox.south)}, ${sqlNumber(bbox.east)},
      ${sqlNumber(bbox.north)}, ${sqlString(sourceUrl)}, ${sqlString(`${tileId}:${bbox.west}:${bbox.south}:${bbox.east}:${bbox.north}`)}, now()
    )
  `)
}

export async function recordParcelTileIntersection(db: ParcelAnalysisDb, parcelId: string, tileId: string, confidence = 0.8): Promise<void> {
  await db.exec(`
    INSERT OR REPLACE INTO parcel_spatial_index (parcel_id, tile_id, intersection_confidence, updated_at)
    VALUES (${sqlString(parcelId)}, ${sqlString(tileId)}, ${sqlNumber(confidence)}, now())
  `)
}
