import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api'

import type { BuildRunInput, BuildRunOutput, DataLoadStep, ParcelRecord, SunAnalysis, TerrainMetrics, ViewAnalysis } from '@shared/types'
import { getSourceRegistryEntries as loadSourceRegistryEntries, recordSourceStep as recordSourceRegistryStep, SOURCE_REGISTRY_SCHEMA_ALTER_SQL, SOURCE_REGISTRY_SCHEMA_SQL } from './sourceRegistryStore'
import { getSourceBlobStats as loadSourceBlobStats, recordSourceBlob as recordSourceBlobEntry, SOURCE_BLOB_SCHEMA_ALTER_SQL, SOURCE_BLOB_SCHEMA_SQL, type SourceBlobRecord, type SourceBlobStats } from './parcelAcquisitionStore'
import {
  PARCEL_ANALYSIS_SCHEMA_ALTER_SQL,
  PARCEL_ANALYSIS_SCHEMA_SQL,
  getAnalysisPersistenceSnapshot as loadAnalysisPersistenceSnapshot,
  getBuildRunsForParcel as loadBuildRunsForParcel,
  getLatestTerrainProduct as loadLatestTerrainProduct,
  getSqftCheck as loadSqftCheck,
  getSunAnalysis as loadSunAnalysis,
  getTerrainMetrics as loadTerrainMetrics,
  getViewAnalysis as loadViewAnalysis,
  recordBuildRun as writeBuildRun,
  recordParcelTileIntersection as writeParcelTileIntersection,
  recordSqftCheck as writeSqftCheck,
  recordSpatialTile as writeSpatialTile,
  recordSunAnalysis as writeSunAnalysis,
  recordTerrainMetrics as writeTerrainMetrics,
  recordViewAnalysis as writeViewAnalysis
} from './parcelAnalysisStore'

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
    await recordSourceRegistryStep(this, step)
  }

  async recordSourceBlob(record: SourceBlobRecord): Promise<void> {
    await recordSourceBlobEntry(this, record)
  }

  async getSourceBlobStats(): Promise<SourceBlobStats> {
    return loadSourceBlobStats(this)
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

  async recordTerrainMetrics(metrics: TerrainMetrics, product: unknown, geometryHash: string = ''): Promise<void> {
    return writeTerrainMetrics(this, metrics, product, geometryHash)
  }

  async getTerrainMetrics(parcelId: string, geometryHash: string = ''): Promise<TerrainMetrics | null> {
    return loadTerrainMetrics(this, parcelId, geometryHash)
  }

  async getLatestTerrainProduct(parcelId: string, productType: string = 'surface_grid'): Promise<any | null> {
    return loadLatestTerrainProduct(this, parcelId, productType)
  }

  async getSqftCheck(parcelId: string): Promise<{ geometricSqft: number; neighborMedianSqft: number; status: string } | null> {
    return loadSqftCheck(this, parcelId)
  }

  async recordSqftCheck(parcelId: string, geometricSqft: number, neighborMedianSqft: number, status: string): Promise<void> {
    return writeSqftCheck(this, parcelId, geometricSqft, neighborMedianSqft, status)
  }

  async recordBuildRun(input: BuildRunInput, output: BuildRunOutput, terrain: TerrainMetrics, geometryHash = ''): Promise<void> {
    return writeBuildRun(this, input, output, terrain, geometryHash)
  }

  async getBuildRunsForParcel(parcelId: string, geometryHash = ''): Promise<BuildRunOutput[]> {
    return loadBuildRunsForParcel(this, parcelId, geometryHash)
  }

  async recordSunAnalysis(analysis: SunAnalysis, geometryHash: string = ''): Promise<void> {
    return writeSunAnalysis(this, analysis, geometryHash)
  }

  async getSunAnalysis(parcelId: string, date: string, geometryHash: string = ''): Promise<SunAnalysis | null> {
    return loadSunAnalysis(this, parcelId, date, geometryHash)
  }

  async recordViewAnalysis(analysis: ViewAnalysis, geometryHash: string = ''): Promise<void> {
    return writeViewAnalysis(this, analysis, geometryHash)
  }

  async getViewAnalysis(parcelId: string, stories: number, geometryHash: string = ''): Promise<ViewAnalysis | null> {
    return loadViewAnalysis(this, parcelId, stories, geometryHash)
  }

  async recordSpatialTile(tileId: string, bbox: { west: number; south: number; east: number; north: number }, sourceUrl: string): Promise<void> {
    return writeSpatialTile(this, tileId, bbox, sourceUrl)
  }

  async recordParcelTileIntersection(parcelId: string, tileId: string, confidence = 0.8): Promise<void> {
    return writeParcelTileIntersection(this, parcelId, tileId, confidence)
  }

  async getAnalysisPersistenceSnapshot(parcelId: string, date: string, stories: number, geometryHash = '') {
    return loadAnalysisPersistenceSnapshot(this, parcelId, date, stories, geometryHash)
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
      ...SOURCE_REGISTRY_SCHEMA_SQL,
      ...SOURCE_BLOB_SCHEMA_SQL,
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
      ...PARCEL_ANALYSIS_SCHEMA_SQL
    ]

    for (const statement of statements) {
      await this.connection.run(statement)
    }

    const alterStatements = [
      ...SOURCE_REGISTRY_SCHEMA_ALTER_SQL,
      ...SOURCE_BLOB_SCHEMA_ALTER_SQL,
      ...PARCEL_ANALYSIS_SCHEMA_ALTER_SQL
    ]
    for (const statement of alterStatements) {
      try { await this.connection.run(statement) } catch { /* ignore */ }
    }
  }

  async getSourceRegistryEntries(): Promise<DataLoadStep[]> {
    return loadSourceRegistryEntries(this)
  }
}

export const rentSeekerStore = new RentSeekerStore()
