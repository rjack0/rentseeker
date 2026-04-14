/**
 * ParcelCsvService — Uses DuckDB's read_csv_auto to query the massive
 * LA County Assessor parcel CSV directly, with flexible APN matching.
 *
 * Handles the 3-part Assessor ID format (e.g. 5560-002-009) whether the
 * user types it with spaces, dashes, or as one continuous number.
 */

import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api'
import { resolve } from 'path'
import { existsSync } from 'fs'

import type { ParcelRecord, ParcelQueryResult } from '@shared/types'

/* ---------- normalizer ---------- */

/**
 * Normalizes a parcel number into the canonical 4-3-3 dash format.
 * Accepts:
 *   "5560 002 009"  → "5560-002-009"
 *   "5560-002-009"  → "5560-002-009"
 *   "5560002009"    → "5560-002-009"
 *   "5560  002  009"→ "5560-002-009"
 */
export function normalizeParcelNumber(raw: string): string {
  // Strip everything that isn't a digit
  const digits = raw.replace(/[^0-9]/g, '')
  if (digits.length < 7) return raw.trim()

  // Try to interpret as 4-3-3
  if (digits.length === 10) {
    return `${digits.slice(0, 4)}-${digits.slice(4, 7)}-${digits.slice(7, 10)}`
  }
  // 7 digits → assume 4-3 with leading zeros for book
  if (digits.length === 7) {
    return `${digits.slice(0, 4)}-${digits.slice(4, 7)}-000`
  }
  return raw.trim()
}

/**
 * Given a full assessor ID like "5560-002-009", extract the book prefix
 * "5560" so we can grab all parcels in that book.
 */
export function extractBookPrefix(assessorId: string): string {
  const parts = assessorId.split('-')
  return parts[0] ?? assessorId.slice(0, 4)
}

/* ---------- service ---------- */

export class ParcelCsvService {
  private instance: DuckDBInstance | null = null
  private connection: DuckDBConnection | null = null

  async initialize(): Promise<void> {
    if (this.connection) return
    this.instance = await DuckDBInstance.create(':memory:')
    this.connection = await this.instance.connect()
    await this.exec('SET threads = 4')
  }

  async queryParcels(
    csvPath: string,
    targetParcelsRaw: string,
    maxSurrounding: number = 100
  ): Promise<ParcelQueryResult> {
    await this.initialize()
    const startTime = Date.now()

    if (!existsSync(csvPath)) {
      throw new Error(`CSV file not found: ${csvPath}`)
    }

    const rawTargets = targetParcelsRaw.split(',').map(s => s.trim()).filter(Boolean)
    const normalizedTargets = rawTargets.map(normalizeParcelNumber)
    const bookPrefixes = [...new Set(normalizedTargets.map(extractBookPrefix))]

    // Build WHERE clause to match all unique prefixes
    const whereConditions = bookPrefixes.map(prefix => `"Assessor ID" LIKE '${prefix}-%'`).join(' OR ')

    // Query DuckDB directly against the CSV
    const sql = `
      WITH ranked AS (
        SELECT *,
          ROW_NUMBER() OVER (PARTITION BY "Assessor ID" ORDER BY "Roll Year" DESC) as rn
        FROM read_csv_auto('${csvPath.replace(/'/g, "''")}', header=true, all_varchar=true)
        WHERE ${whereConditions}
      )
      SELECT
        "Assessor ID"                    AS assessor_id,
        "AIN"                            AS ain,
        COALESCE(TRY_CAST("Roll Year" AS INTEGER), 0) AS roll_year,
        "Zip Code"                       AS zip_code,
        "City Tax Rate Area"             AS city_tax_rate_area,
        "Tax Rate Area Code"             AS tax_rate_area_code,
        "Property Location"              AS property_location,
        "Property Use Type"              AS property_use_type,
        "Property Use Code"              AS property_use_code,
        "Use Code 1st Digit"             AS use_code_1,
        "Use Code 2nd Digit"             AS use_code_2,
        "Use Code 3rd Digit"             AS use_code_3,
        "Use Code 4th Digit"             AS use_code_4,
        COALESCE(TRY_CAST("Number of Buildings" AS INTEGER), 0) AS number_of_buildings,
        COALESCE(TRY_CAST("Year Built" AS INTEGER), 0) AS year_built,
        COALESCE(TRY_CAST("Effective Year" AS INTEGER), 0) AS effective_year,
        COALESCE(TRY_CAST("Square Footage" AS INTEGER), 0) AS square_footage,
        COALESCE(TRY_CAST("Number of Bedrooms" AS INTEGER), 0) AS number_of_bedrooms,
        COALESCE(TRY_CAST("Number of Bathrooms" AS INTEGER), 0) AS number_of_bathrooms,
        COALESCE(TRY_CAST("Number of Units" AS INTEGER), 0) AS number_of_units,
        "Recording Date"                 AS recording_date,
        COALESCE(TRY_CAST("Land Value" AS BIGINT), 0)            AS land_value,
        COALESCE(TRY_CAST("Land Base Year" AS INTEGER), 0)       AS land_base_year,
        COALESCE(TRY_CAST("Improvement Value" AS BIGINT), 0)     AS improvement_value,
        COALESCE(TRY_CAST("Improvement Base Year" AS INTEGER), 0) AS improvement_base_year,
        COALESCE(TRY_CAST("Total Value Land Improvement" AS BIGINT), 0) AS total_value_land_improvement,
        COALESCE(TRY_CAST("Home Owners Exemption" AS BIGINT), 0)   AS home_owners_exemption,
        COALESCE(TRY_CAST("Real Estate Exemption" AS BIGINT), 0)   AS real_estate_exemption,
        COALESCE(TRY_CAST("Fixture Value" AS BIGINT), 0)          AS fixture_value,
        COALESCE(TRY_CAST("Fixture Exemption" AS BIGINT), 0)      AS fixture_exemption,
        COALESCE(TRY_CAST("Personal Property Value" AS BIGINT), 0) AS personal_property_value,
        COALESCE(TRY_CAST("Personal Property Exemption" AS BIGINT), 0) AS personal_property_exemption,
        "Property taxable?"              AS property_taxable,
        COALESCE(TRY_CAST("Total Value" AS BIGINT), 0)            AS total_value,
        COALESCE(TRY_CAST("Total Exemption" AS BIGINT), 0)        AS total_exemption,
        COALESCE(TRY_CAST("Taxable Value" AS BIGINT), 0)          AS taxable_value,
        "Classification"                 AS classification,
        "Region Number"                  AS region_number,
        "Cluster Code"                   AS cluster_code,
        "Parcel Legal Description"       AS parcel_legal_description,
        "Address House Number"           AS address_house_number,
        "Address House Number Fraction"  AS address_house_number_fraction,
        "Direction"                      AS direction,
        "Street"                         AS street,
        "Unit Number"                    AS unit_number,
        "City"                           AS city,
        COALESCE("Zip Code", '')         AS zip_code_full,
        "Row ID"                         AS row_id,
        TRY_CAST("Location Latitude" AS DOUBLE) AS latitude,
        TRY_CAST("Location Longitude" AS DOUBLE) AS longitude,
        "OBJECTID"                       AS object_id
      FROM ranked
      WHERE rn = 1
      ORDER BY "Assessor ID"
    `

    const rows = await this.query(sql)
    const allParcels = rows.map(p => this.rowToParcelRecord(p))
    
    // Pick out the explicit target parcels
    const targetParcels = allParcels.filter(p => normalizedTargets.includes(p.assessorId))

    // Get the surrounding parcels (everything that isn't the target, capped)
    const surroundingParcels = allParcels
      .filter(p => !normalizedTargets.includes(p.assessorId))
      .slice(0, maxSurrounding)

    return {
      targetParcels,
      surroundingParcels,
      allParcels: [...targetParcels, ...surroundingParcels],
      totalFound: targetParcels.length + surroundingParcels.length,
      queryTimeMs: Date.now() - startTime,
      csvPath
    }
  }

  async destroy(): Promise<void> {
    if (this.connection) {
      this.connection = null
    }
    if (this.instance) {
      this.instance = null
    }
  }

  /* ---------- private helpers ---------- */

  private rowToParcelRecord(row: Record<string, unknown>): ParcelRecord {
    return {
      assessorId: String(row.assessor_id ?? '').trim(),
      ain: String(row.ain ?? '').trim(),
      rollYear: Number(row.roll_year ?? 0),
      zipCode: String(row.zip_code ?? '').trim(),
      cityTaxRateArea: String(row.city_tax_rate_area ?? '').trim(),
      taxRateAreaCode: String(row.tax_rate_area_code ?? '').trim(),
      propertyLocation: String(row.property_location ?? '').trim(),
      propertyUseType: String(row.property_use_type ?? '').trim(),
      propertyUseCode: String(row.property_use_code ?? '').trim(),
      useCode1: String(row.use_code_1 ?? '').trim(),
      useCode2: String(row.use_code_2 ?? '').trim(),
      useCode3: String(row.use_code_3 ?? '').trim(),
      useCode4: String(row.use_code_4 ?? '').trim(),
      numberOfBuildings: Number(row.number_of_buildings ?? 0),
      yearBuilt: Number(row.year_built ?? 0),
      effectiveYear: Number(row.effective_year ?? 0),
      squareFootage: Number(row.square_footage ?? 0),
      numberOfBedrooms: Number(row.number_of_bedrooms ?? 0),
      numberOfBathrooms: Number(row.number_of_bathrooms ?? 0),
      numberOfUnits: Number(row.number_of_units ?? 0),
      recordingDate: String(row.recording_date ?? '').trim(),
      landValue: Number(row.land_value ?? 0),
      landBaseYear: Number(row.land_base_year ?? 0),
      improvementValue: Number(row.improvement_value ?? 0),
      improvementBaseYear: Number(row.improvement_base_year ?? 0),
      totalValueLandImprovement: Number(row.total_value_land_improvement ?? 0),
      homeOwnersExemption: Number(row.home_owners_exemption ?? 0),
      realEstateExemption: Number(row.real_estate_exemption ?? 0),
      fixtureValue: Number(row.fixture_value ?? 0),
      fixtureExemption: Number(row.fixture_exemption ?? 0),
      personalPropertyValue: Number(row.personal_property_value ?? 0),
      personalPropertyExemption: Number(row.personal_property_exemption ?? 0),
      propertyTaxable: String(row.property_taxable ?? '').trim(),
      totalValue: Number(row.total_value ?? 0),
      totalExemption: Number(row.total_exemption ?? 0),
      taxableValue: Number(row.taxable_value ?? 0),
      classification: String(row.classification ?? '').trim(),
      regionNumber: String(row.region_number ?? '').trim(),
      clusterCode: String(row.cluster_code ?? '').trim(),
      parcelLegalDescription: String(row.parcel_legal_description ?? '').trim(),
      addressHouseNumber: String(row.address_house_number ?? '').trim(),
      addressHouseNumberFraction: String(row.address_house_number_fraction ?? '').trim(),
      direction: String(row.direction ?? '').trim(),
      street: String(row.street ?? '').trim(),
      unitNumber: String(row.unit_number ?? '').trim(),
      city: String(row.city ?? '').trim(),
      zipCodeFull: String(row.zip_code_full ?? '').trim(),
      rowId: String(row.row_id ?? '').trim(),
      latitude: row.latitude != null ? Number(row.latitude) : null,
      longitude: row.longitude != null ? Number(row.longitude) : null,
      objectId: String(row.object_id ?? '').trim()
    }
  }

  private async exec(sql: string): Promise<void> {
    if (!this.connection) throw new Error('ParcelCsvService not initialized')
    const result = await this.connection.run(sql)
    // consume result
  }

  private async query(sql: string): Promise<Array<Record<string, unknown>>> {
    if (!this.connection) throw new Error('ParcelCsvService not initialized')
    const result = await this.connection.run(sql)
    const rows: Array<Record<string, unknown>> = []
    const columns = result.columnNames()
    const chunks = await result.fetchAllChunks()
    for (const chunk of chunks) {
      const rowCount = chunk.rowCount
      for (let r = 0; r < rowCount; r++) {
        const obj: Record<string, unknown> = {}
        for (let c = 0; c < columns.length; c++) {
          obj[columns[c]] = chunk.getColumnVector(c).getItem(r)
        }
        rows.push(obj)
      }
    }
    return rows
  }
}
