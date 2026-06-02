import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api'

import type { BuildRunInput, BuildRunOutput, DataLoadStep, ParcelRecord, SunAnalysis, TerrainMetrics, ViewAnalysis } from '@shared/types'

const DB_PATH = join('/Users/rjack/Desktop/almanac/RentSeeker', '.rentseeker', 'rentseeker.duckdb')

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

export class RentSeekerStore {
  private instance: DuckDBInstance | null = null
  private connection: DuckDBConnection | null = null
  private schemaReady = false

  async initialize(): Promise<void> {
    if (this.connection && this.schemaReady) return
    mkdirSync(dirname(DB_PATH), { recursive: true })
    if (!this.instance) this.instance = await DuckDBInstance.create(DB_PATH)
    if (!this.connection) this.connection = await this.instance.connect()
    await this.createSchema()
    this.schemaReady = true
  }

  async exec(sql: string): Promise<void> {
    await this.initialize()
    if (!this.connection) throw new Error('RentSeekerStore not initialized')
    await this.connection.run(sql)
  }

  async query(sql: string): Promise<Record<string, unknown>[]> {
    await this.initialize()
    if (!this.connection) throw new Error('RentSeekerStore not initialized')
    const reader = await this.connection.runAndReadAll(sql)
    return reader.getRowObjectsJson() as Record<string, unknown>[]
  }

  async recordSourceStep(step: DataLoadStep & { sourcePath?: string; datasetId?: string }): Promise<void> {
    const sourceId = step.datasetId ?? step.datasetName
    await this.exec(`
      INSERT OR REPLACE INTO source_record (
        source_id, dataset_name, source_path, row_count, load_status, color, updated_at, error_msg
      ) VALUES (
        ${sqlString(sourceId)}, ${sqlString(step.datasetName)},
        ${sqlString(step.sourcePath ?? '')}, ${sqlNumber(step.rowCount)}, ${sqlString(step.status)},
        ${sqlString(step.color)}, now(), ${sqlString(step.errorMsg ?? '')}
      )
    `)
    if (step.sourcePath) {
      await this.exec(`
        INSERT OR REPLACE INTO source_blob (
          blob_id, source_url, local_path, content_hash, byte_size, fetched_at, provenance_json
        ) VALUES (
          ${sqlString(sourceId)}, ${sqlString(step.sourcePath)}, ${sqlString(step.sourcePath)},
          ${sqlString(`${sourceId}:${step.byteSize ?? 0}:${step.rowCount}`)}, ${sqlNumber(step.byteSize ?? 0)},
          now(), ${sqlString(json({ datasetName: step.datasetName, status: step.status }))}
        )
      `)
    }
  }

  async recordParcelIdentity(parcel: ParcelRecord): Promise<void> {
    const apn = parcel.assessorId
    const normalized = apn.replace(/[^0-9]/g, '')
    const value = parcel.totalValue || parcel.totalValueLandImprovement || 0
    await this.exec(`
      INSERT OR REPLACE INTO parcel_master (
        parcel_id, ain, apn, normalized_apn, use_code, use_type, legal_description,
        latitude, longitude, legal_sqft, assessed_value, identity_confidence, updated_at
      ) VALUES (
        ${sqlString(parcel.ain || normalized)}, ${sqlString(parcel.ain)}, ${sqlString(apn)},
        ${sqlString(normalized)}, ${sqlString(parcel.propertyUseCode)}, ${sqlString(parcel.propertyUseType)},
        ${sqlString(parcel.parcelLegalDescription)}, ${sqlNumber(parcel.latitude)}, ${sqlNumber(parcel.longitude)},
        ${sqlNumber(parcel.squareFootage)}, ${sqlNumber(value)}, 0.92, now()
      )
    `)

    await this.exec(`
      INSERT OR REPLACE INTO parcel_address (
        address_id, parcel_id, address, city, zip, latitude, longitude, source_id, confidence
      ) VALUES (
        ${sqlString(`${parcel.ain || normalized}:situs`)}, ${sqlString(parcel.ain || normalized)},
        ${sqlString(parcel.propertyLocation)}, ${sqlString(parcel.city)}, ${sqlString(parcel.zipCodeFull || parcel.zipCode)},
        ${sqlNumber(parcel.latitude)}, ${sqlNumber(parcel.longitude)}, 'assessor_parcels', 0.9
      )
    `)

    if (parcel.cofoNumber) {
      await this.exec(`
        INSERT OR REPLACE INTO co_master (
          co_id, parcel_id, cofo_number, issue_date, status, permit_type, permit_sub_type,
          work_description, valuation, contractor_name, source_id
        ) VALUES (
          ${sqlString(parcel.cofoNumber)}, ${sqlString(parcel.ain || normalized)}, ${sqlString(parcel.cofoNumber)},
          ${sqlString(parcel.cofoIssueDate ?? '')}, ${sqlString(parcel.cofoStatus ?? '')},
          ${sqlString(parcel.permitType ?? '')}, ${sqlString(parcel.permitSubType ?? '')},
          ${sqlString(parcel.workDescription ?? '')}, ${sqlNumber(parcel.cofoValuation?.replace(/[^0-9.-]/g, ''))},
          ${sqlString(parcel.contractorName ?? '')}, 'certificate_of_occupancy'
        )
      `)
    }

    if (parcel.latestBuildingPermit) {
      await this.recordPermit(parcel, 'building_permit', parcel.latestBuildingPermit, parcel.latestBuildingPermitStatus, parcel.latestBuildingPermitDescription, parcel.buildingPermitValuation)
    }
    if (parcel.latestElectricalPermit) {
      await this.recordPermit(parcel, 'electrical_permit', parcel.latestElectricalPermit, parcel.latestElectricalPermitStatus, parcel.latestElectricalPermitDescription, 0)
    }

    if (parcel.sb79Eligible != null || parcel.sb79Tier) {
      await this.exec(`
        INSERT OR REPLACE INTO parcel_sb79 (
          parcel_id, eligible, nearest_stop_name, distance_to_stop_ft, tier, band, evidence_json, updated_at
        ) VALUES (
          ${sqlString(parcel.ain || normalized)}, ${parcel.sb79Eligible ? 'true' : 'false'},
          ${sqlString('nearest major transit anchor')}, ${sqlNumber(parcel.sb79DistanceToStopFt ?? null)},
          ${sqlString(parcel.sb79Tier ?? '')}, ${sqlString(parcel.sb79Eligible ? 'within_screening_radius' : 'outside_screening_radius')},
          ${sqlString(json({ method: 'nearest known LA transit anchor', approximate: true }))}, now()
        )
      `)
    }
  }

  async recordTerrainMetrics(metrics: TerrainMetrics, product: unknown): Promise<void> {
    await this.exec(`
      INSERT OR REPLACE INTO parcel_terrain_metrics (
        parcel_id, dem_min_z, dem_max_z, dem_mean_z, dem_relief, slope_pct, slope_deg,
        max_local_slope_pct, aspect_deg, pad_candidate_count, largest_pad_area_sqft,
        driveway_grade_best_pct, retaining_wall_candidate_length_ft, terrain_confidence, updated_at
      ) VALUES (
        ${sqlString(metrics.parcelId)}, ${sqlNumber(metrics.demMinZ)}, ${sqlNumber(metrics.demMaxZ)},
        ${sqlNumber(metrics.demMeanZ)}, ${sqlNumber(metrics.demRelief)}, ${sqlNumber(metrics.bestFitSlopePct)},
        ${sqlNumber(metrics.bestFitSlopeDeg)}, ${sqlNumber(metrics.maxLocalSlopePct)}, ${sqlNumber(metrics.aspectDeg)},
        ${sqlNumber(metrics.padCandidateCount)}, ${sqlNumber(metrics.largestPadAreaSqft)},
        ${sqlNumber(metrics.drivewayGradeBestPct)}, ${sqlNumber(metrics.retainingWallCandidateLengthFt)},
        ${sqlNumber(metrics.terrainConfidence)}, now()
      )
    `)

    await this.exec(`
      INSERT INTO parcel_terrain_products (product_id, parcel_id, product_type, payload_json, created_at)
      VALUES (${sqlString(`${metrics.parcelId}:${Date.now()}`)}, ${sqlString(metrics.parcelId)}, 'surface_grid', ${sqlString(json(product))}, now())
    `)
  }

  async getTerrainMetrics(parcelId: string): Promise<TerrainMetrics | null> {
    const clean = parcelId.replace(/'/g, "''")
    const rows = await this.query(`
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

  async getLatestTerrainProduct(parcelId: string, productType: string = 'surface_grid'): Promise<any | null> {
    const cleanId = parcelId.replace(/'/g, "''")
    const cleanType = productType.replace(/'/g, "''")
    const rows = await this.query(`
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

  async getSqftCheck(parcelId: string): Promise<{ geometricSqft: number; neighborMedianSqft: number; status: string } | null> {
    const clean = parcelId.replace(/'/g, "''")
    const rows = await this.query(`
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

  async recordSqftCheck(parcelId: string, geometricSqft: number, neighborMedianSqft: number, status: string): Promise<void> {
    await this.exec(`
      UPDATE parcel_master
      SET geometric_sqft = ${sqlNumber(geometricSqft)},
          neighbor_median_sqft = ${sqlNumber(neighborMedianSqft)},
          sqft_check_status = ${sqlString(status)},
          updated_at = now()
      WHERE parcel_id = ${sqlString(parcelId)}
    `)
  }

  async recordBuildRun(input: BuildRunInput, output: BuildRunOutput, terrain: TerrainMetrics): Promise<void> {
    await this.exec(`
      INSERT OR REPLACE INTO build_runs (
        run_id, parcel_id, template_id, stories, input_json, terrain_metric_json, created_at
      ) VALUES (
        ${sqlString(output.runId)}, ${sqlString(input.parcelId)}, ${sqlString(input.templateId)},
        ${sqlNumber(input.stories)}, ${sqlString(json(input))}, ${sqlString(json(terrain))}, ${sqlString(output.createdAt)}
      )
    `)
    await this.exec(`
      INSERT OR REPLACE INTO build_run_outputs (
        run_id, parcel_id, footprint_sqft, building_height_ft, floor_area_sqft, estimated_units,
        estimated_cut_cy, estimated_fill_cy, estimated_retaining_wall_ft, estimated_avg_retaining_height_ft,
        estimated_driveway_grade_pct, estimated_flat_pad_sqft, fit_score, constraint_flags_json,
        placement_lng, placement_lat, placement_z, placement_pitch_deg, placement_roll_deg,
        foundation_skirt_json, output_json
      ) VALUES (
        ${sqlString(output.runId)}, ${sqlString(output.parcelId)}, ${sqlNumber(output.footprintSqft)},
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

  async getBuildRunsForParcel(parcelId: string): Promise<BuildRunOutput[]> {
    const clean = parcelId.replace(/'/g, "''")
    const rows = await this.query(`
      SELECT o.output_json
      FROM build_run_outputs o
      LEFT JOIN build_runs r ON r.run_id = o.run_id
      WHERE o.parcel_id = '${clean}'
      ORDER BY r.created_at DESC NULLS LAST
      LIMIT 50
    `)
    return rows
      .map(row => {
        try {
          return JSON.parse(String(row.output_json ?? 'null')) as BuildRunOutput | null
        } catch {
          return null
        }
      })
      .filter((row): row is BuildRunOutput => row != null)
  }

  async recordSunAnalysis(analysis: SunAnalysis): Promise<void> {
    await this.exec(`
      INSERT OR REPLACE INTO parcel_sun_analysis (
        analysis_id, parcel_id, analysis_date, direct_sunlight_hours, total_daylight_hours,
        analysis_json, updated_at
      ) VALUES (
        ${sqlString(`${analysis.parcelId}:${analysis.date}`)}, ${sqlString(analysis.parcelId)},
        ${sqlString(analysis.date)}, ${sqlNumber(analysis.directSunlightHours)},
        ${sqlNumber(analysis.totalDaylightHours)}, ${sqlString(json(analysis))}, now()
      )
    `)
  }

  async getSunAnalysis(parcelId: string, date: string): Promise<SunAnalysis | null> {
    const rows = await this.query(`
      SELECT analysis_json
      FROM parcel_sun_analysis
      WHERE analysis_id = ${sqlString(`${parcelId}:${date}`)}
      LIMIT 1
    `)
    if (rows.length === 0) return null
    try {
      return JSON.parse(String(rows[0].analysis_json ?? 'null')) as SunAnalysis
    } catch {
      return null
    }
  }

  async recordViewAnalysis(analysis: ViewAnalysis): Promise<void> {
    await this.exec(`
      INSERT OR REPLACE INTO parcel_view_analysis (
        analysis_id, parcel_id, stories, viewer_height_ft, view_score,
        max_view_distance_mi, analysis_json, updated_at
      ) VALUES (
        ${sqlString(`${analysis.parcelId}:${analysis.stories}`)}, ${sqlString(analysis.parcelId)},
        ${sqlNumber(analysis.stories)}, ${sqlNumber(analysis.viewerHeightFt)},
        ${sqlNumber(analysis.viewScore)}, ${sqlNumber(analysis.maxViewDistanceMi)},
        ${sqlString(json(analysis))}, now()
      )
    `)
  }

  async getViewAnalysis(parcelId: string, stories: number): Promise<ViewAnalysis | null> {
    const rows = await this.query(`
      SELECT analysis_json
      FROM parcel_view_analysis
      WHERE analysis_id = ${sqlString(`${parcelId}:${stories}`)}
      LIMIT 1
    `)
    if (rows.length === 0) return null
    try {
      return JSON.parse(String(rows[0].analysis_json ?? 'null')) as ViewAnalysis
    } catch {
      return null
    }
  }

  async recordSpatialTile(tileId: string, bbox: { west: number; south: number; east: number; north: number }, sourceUrl: string): Promise<void> {
    await this.exec(`
      INSERT OR REPLACE INTO spatial_tile_index (tile_id, west, south, east, north, source_url, content_hash, cached_at)
      VALUES (
        ${sqlString(tileId)}, ${sqlNumber(bbox.west)}, ${sqlNumber(bbox.south)}, ${sqlNumber(bbox.east)},
        ${sqlNumber(bbox.north)}, ${sqlString(sourceUrl)}, ${sqlString(`${tileId}:${bbox.west}:${bbox.south}:${bbox.east}:${bbox.north}`)}, now()
      )
    `)
  }

  async recordParcelTileIntersection(parcelId: string, tileId: string, confidence = 0.8): Promise<void> {
    await this.exec(`
      INSERT OR REPLACE INTO parcel_spatial_index (parcel_id, tile_id, intersection_confidence, updated_at)
      VALUES (${sqlString(parcelId)}, ${sqlString(tileId)}, ${sqlNumber(confidence)}, now())
    `)
  }

  private async recordPermit(
    parcel: ParcelRecord,
    source: 'building_permit' | 'electrical_permit',
    permitNumber?: string,
    status?: string,
    workDescription?: string,
    valuation?: number
  ): Promise<void> {
    const parcelId = parcel.ain || parcel.assessorId.replace(/[^0-9]/g, '')
    await this.exec(`
      INSERT OR REPLACE INTO permit_master (
        permit_id, parcel_id, permit_number, permit_kind, status, issue_date, work_description, valuation, source_id
      ) VALUES (
        ${sqlString(`${source}:${permitNumber}`)}, ${sqlString(parcelId)}, ${sqlString(permitNumber)},
        ${sqlString(source)}, ${sqlString(status ?? '')}, NULL, ${sqlString(workDescription ?? '')},
        ${sqlNumber(valuation ?? 0)}, ${sqlString(source)}
      )
    `)
  }

  private async createSchema(): Promise<void> {
    if (!this.connection) throw new Error('RentSeekerStore not initialized')
    const statements = [
      `CREATE TABLE IF NOT EXISTS source_blob (
        blob_id VARCHAR PRIMARY KEY,
        source_url VARCHAR,
        local_path VARCHAR,
        content_hash VARCHAR,
        byte_size BIGINT,
        fetched_at TIMESTAMP,
        provenance_json VARCHAR
      )`,
      `CREATE TABLE IF NOT EXISTS source_record (
        source_id VARCHAR PRIMARY KEY,
        dataset_name VARCHAR,
        source_path VARCHAR,
        row_count BIGINT,
        load_status VARCHAR,
        color VARCHAR,
        updated_at TIMESTAMP,
        error_msg VARCHAR
      )`,
      `CREATE TABLE IF NOT EXISTS parcel_master (
        parcel_id VARCHAR PRIMARY KEY,
        ain VARCHAR,
        apn VARCHAR,
        normalized_apn VARCHAR,
        use_code VARCHAR,
        use_type VARCHAR,
        legal_description VARCHAR,
        latitude DOUBLE,
        longitude DOUBLE,
        legal_sqft DOUBLE,
        geometric_sqft DOUBLE,
        neighbor_median_sqft DOUBLE,
        sqft_check_status VARCHAR,
        assessed_value DOUBLE,
        identity_confidence DOUBLE,
        updated_at TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS parcel_address (
        address_id VARCHAR PRIMARY KEY,
        parcel_id VARCHAR,
        address VARCHAR,
        city VARCHAR,
        zip VARCHAR,
        latitude DOUBLE,
        longitude DOUBLE,
        source_id VARCHAR,
        confidence DOUBLE
      )`,
      `CREATE TABLE IF NOT EXISTS entity_link (
        link_id VARCHAR PRIMARY KEY,
        source_entity_id VARCHAR,
        target_entity_id VARCHAR,
        link_type VARCHAR,
        confidence DOUBLE,
        evidence_json VARCHAR,
        updated_at TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS permit_master (
        permit_id VARCHAR PRIMARY KEY,
        parcel_id VARCHAR,
        permit_number VARCHAR,
        permit_kind VARCHAR,
        status VARCHAR,
        issue_date VARCHAR,
        work_description VARCHAR,
        valuation DOUBLE,
        source_id VARCHAR
      )`,
      `CREATE TABLE IF NOT EXISTS co_master (
        co_id VARCHAR PRIMARY KEY,
        parcel_id VARCHAR,
        cofo_number VARCHAR,
        issue_date VARCHAR,
        status VARCHAR,
        permit_type VARCHAR,
        permit_sub_type VARCHAR,
        work_description VARCHAR,
        valuation DOUBLE,
        contractor_name VARCHAR,
        source_id VARCHAR
      )`,
      `CREATE TABLE IF NOT EXISTS parcel_sb79 (
        parcel_id VARCHAR PRIMARY KEY,
        eligible BOOLEAN,
        nearest_stop_name VARCHAR,
        distance_to_stop_ft DOUBLE,
        tier VARCHAR,
        band VARCHAR,
        evidence_json VARCHAR,
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
      )`,
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
        input_json VARCHAR,
        terrain_metric_json VARCHAR,
        created_at TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS build_run_outputs (
        run_id VARCHAR PRIMARY KEY,
        parcel_id VARCHAR,
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
        updated_at TIMESTAMP
      )`
    ]

    for (const statement of statements) {
      await this.connection.run(statement)
    }
  }
}

export const rentSeekerStore = new RentSeekerStore()
