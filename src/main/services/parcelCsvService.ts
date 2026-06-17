/**
 * ParcelCsvService — Uses DuckDB's read_csv_auto to query the massive
 * LA County Assessor parcel CSV directly, with flexible APN matching.
 *
 * Also supports cross-referencing with the Certificate of Occupancy dataset
 * and dynamic filtering via ParcelFilterQuery.
 */

import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api'
import { existsSync } from 'fs'

import type { ParcelRecord, ParcelQueryResult, ParcelFilterQuery, DataSource } from '@shared/types'
import { rentSeekerStore } from './rentSeekerStore'

/* ═══════════════ DATA PATHS ═══════════════ */

const PARCEL_CSV = '/Users/rjack/Desktop/almanac/Docs/RE Data/Parcel_Data_0 2.csv'
const COFO_CSV = '/Users/rjack/Desktop/almanac/Docs/RE Data/Building_and_Safety_Certificate_of_Occupancy_20260404.csv'
const BUILDING_PERMITS_CSV = '/Users/rjack/Desktop/almanac/Docs/RE Data/Building_and_Safety_-_Building_Permits_Issued_from_2020_to_Present_(N)_20260417.csv'
const ELECTRICAL_PERMITS_CSV = '/Users/rjack/Desktop/almanac/Docs/RE Data/Building_and_Safety_-_Electrical_Permits_Issued_from_2020_to_Present_(N)_20260417.csv'
const BUILDING_PERMITS_SUBMITTED_CSV = '/Users/rjack/Desktop/almanac/Docs/RE Data/Building_and_Safety_-_Building_Permits_Submitted_from_2020_to_Present_(N)_20260417.csv'
const INSPECTIONS_CSV = '/Users/rjack/Desktop/almanac/Docs/RE Data/Building_and_Safety_Inspections_20260417.csv'
const FEET_PER_MILE = 5280
const TRANSIT_ANCHORS = [
  { name: 'Union Station', lat: 34.0560, lng: -118.2365 },
  { name: '7th Street Metro Center', lat: 34.0486, lng: -118.2587 },
  { name: 'Hollywood/Highland', lat: 34.1016, lng: -118.3387 },
  { name: 'Wilshire/Vermont', lat: 34.0627, lng: -118.2901 },
  { name: 'Expo/Crenshaw', lat: 34.0225, lng: -118.3351 },
  { name: 'North Hollywood', lat: 34.1686, lng: -118.3768 },
  { name: 'Culver City', lat: 34.0279, lng: -118.3889 },
  { name: 'Santa Monica Downtown', lat: 34.0140, lng: -118.4914 },
  { name: 'LAX/Metro Transit Center', lat: 33.9454, lng: -118.3772 }
]

/* ═══════════════ NORMALIZER ═══════════════ */

export function normalizeParcelNumber(raw: string): string {
  const digits = raw.replace(/[^0-9]/g, '')
  if (digits.length < 7) return raw.trim()
  if (digits.length === 10) {
    return `${digits.slice(0, 4)}-${digits.slice(4, 7)}-${digits.slice(7, 10)}`
  }
  if (digits.length === 7) {
    return `${digits.slice(0, 4)}-${digits.slice(4, 7)}-000`
  }
  return raw.trim()
}

export function extractBookPrefix(assessorId: string): string {
  const parts = assessorId.split('-')
  return parts[0] ?? assessorId.slice(0, 4)
}

function expandAddressNeedles(raw: string): string[] {
  const base = raw.trim().replace(/\s+/g, ' ')
  const variants = new Set([base])
  const replacements: Array<[RegExp, string]> = [
    [/\bst\b/ig, 'street'],
    [/\bstreet\b/ig, 'st'],
    [/\brd\b/ig, 'road'],
    [/\broad\b/ig, 'rd'],
    [/\bave\b/ig, 'avenue'],
    [/\bavenue\b/ig, 'ave'],
    [/\bblvd\b/ig, 'boulevard'],
    [/\bboulevard\b/ig, 'blvd'],
    [/\bdr\b/ig, 'drive'],
    [/\bdrive\b/ig, 'dr'],
    [/\bln\b/ig, 'lane'],
    [/\blane\b/ig, 'ln'],
    [/\bct\b/ig, 'court'],
    [/\bcourt\b/ig, 'ct']
  ]
  for (const [pattern, replacement] of replacements) {
    variants.add(base.replace(pattern, replacement))
  }
  variants.add(base.replace(/[.,#-]/g, ' ').replace(/\s+/g, ' ').trim())
  return [...variants].filter(Boolean).slice(0, 8)
}

function distanceFeet(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const deg = Math.PI / 180
  const dLat = (lat2 - lat1) * deg
  const dLng = (lng2 - lng1) * deg
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * deg) * Math.cos(lat2 * deg) * Math.sin(dLng / 2) ** 2
  return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * FEET_PER_MILE
}

function estimateSb79(parcel: ParcelRecord): Pick<ParcelRecord, 'sb79Eligible' | 'sb79Tier' | 'sb79DistanceToStopFt'> {
  if (!parcel.latitude || !parcel.longitude) return {}
  const nearest = TRANSIT_ANCHORS
    .map(stop => ({ ...stop, feet: distanceFeet(parcel.latitude!, parcel.longitude!, stop.lat, stop.lng) }))
    .sort((a, b) => a.feet - b.feet)[0]
  if (!nearest) return {}
  const tier = nearest.feet <= 1320 ? 'tier_1_quarter_mile'
    : nearest.feet <= 2640 ? 'tier_2_half_mile'
    : nearest.feet <= 5280 ? 'tier_3_one_mile'
    : 'outside_screening_radius'
  return {
    sb79Eligible: nearest.feet <= 2640,
    sb79Tier: tier,
    sb79DistanceToStopFt: Math.round(nearest.feet)
  }
}

/* ═══════════════ SERVICE ═══════════════ */

export class ParcelCsvService {
  private instance: DuckDBInstance | null = null
  private connection: DuckDBConnection | null = null
  private cofoLoaded = false

  async initialize(): Promise<void> {
    if (this.connection) return
    this.instance = await DuckDBInstance.create(':memory:')
    this.connection = await this.instance.connect()
    await this.exec('SET threads = 4')
  }

  /* -------- Legacy query (backward-compatible) -------- */

  async queryParcels(
    csvPath: string,
    targetParcelsRaw: string,
    maxSurrounding: number = 100
  ): Promise<ParcelQueryResult> {
    return this.queryFiltered({
      targetParcels: targetParcelsRaw,
      limit: maxSurrounding + 20,
      includeCofO: true
    })
  }

  /* -------- Count query (for confirmation dialog) -------- */

  async countFiltered(filter: ParcelFilterQuery): Promise<number> {
    await this.initialize()
    const whereClause = this.buildWhereClause(filter)
    const sql = `
      SELECT COUNT(*) as cnt
      FROM read_csv_auto(
        '${PARCEL_CSV.replace(/'/g, "''")}',
        header=true,
        all_varchar=false,
        sample_size=5000,
        types={
          'Roll Year': 'INTEGER',
          'Location Latitude': 'DOUBLE',
          'Location Longitude': 'DOUBLE',
          'Total Value': 'BIGINT',
          'Year Built': 'INTEGER'
        },
        strict_mode=false,
        ignore_errors=true,
        null_padding=true
      )
      WHERE ${whereClause}
    `
    const rows = await this.query(sql)
    return Number(rows[0]?.cnt ?? 0)
  }

  /* -------- Filtered query (new main API) -------- */

  async queryFiltered(filter: ParcelFilterQuery): Promise<ParcelQueryResult> {
    await this.initialize()
    const startTime = Date.now()
    const debugTag = `[parcel-query ${new Date().toISOString()}]`
    console.log(`${debugTag} start`, {
      limit: filter.limit ?? 500,
      randomSample: filter.randomSample === true,
      hasBounds: Boolean(filter.bounds),
      includeCofO: filter.includeCofO === true,
      includeBuildingPermits: filter.includeBuildingPermits === true,
      includeElectricalPermits: filter.includeElectricalPermits === true,
      includeSubmittedPermits: filter.includeSubmittedPermits === true,
      includeInspections: filter.includeInspections === true
    })

    if (!existsSync(PARCEL_CSV)) {
      throw new Error(`Parcel CSV not found: ${PARCEL_CSV}`)
    }

    // Build target list if provided
    let normalizedTargets: string[] = []
    if (filter.targetParcels) {
      const rawTargets = filter.targetParcels.split(',').map(s => s.trim()).filter(Boolean)
      normalizedTargets = rawTargets.map(normalizeParcelNumber)
    }

    const whereClause = this.buildWhereClause(filter)
    const orderClause = this.buildOrderClause(filter)
    const limit = filter.limit ?? 500
    // Counting the full result set requires scanning a multi-GB CSV and will dominate query time.
    // The renderer uses a dedicated count IPC only when it needs confirmation for huge queries.
    const totalFound = 0
    // Performance: do not read the entire CSV as VARCHAR and then TRY_CAST every row.
    // For viewport queries, we only need a small subset of columns, and we want lat/lng typed
    // so bounds filters don't force per-row casts across the full 3.9GB file.
    const parcelCsvSource = `read_csv_auto(
      '${PARCEL_CSV.replace(/'/g, "''")}',
      header=true,
      all_varchar=false,
      normalize_names=false,
      sample_size=5000,
      types={
        'Roll Year': 'INTEGER',
        'Number of Buildings': 'INTEGER',
        'Effective Year': 'INTEGER',
        'Number of Bedrooms': 'INTEGER',
        'Number of Bathrooms': 'INTEGER',
        'Number of Units': 'INTEGER',
        'Land Base Year': 'INTEGER',
        'Improvement Base Year': 'INTEGER',
        'Location Latitude': 'DOUBLE',
        'Location Longitude': 'DOUBLE',
        'Total Value': 'BIGINT',
        'Total Exemption': 'BIGINT',
        'Taxable Value': 'BIGINT',
        'Land Value': 'BIGINT',
        'Improvement Value': 'BIGINT',
        'Total Value Land Improvement': 'BIGINT',
        'Home Owners Exemption': 'BIGINT',
        'Real Estate Exemption': 'BIGINT',
        'Fixture Value': 'BIGINT',
        'Fixture Exemption': 'BIGINT',
        'Personal Property Value': 'BIGINT',
        'Personal Property Exemption': 'BIGINT',
        'Square Footage': 'INTEGER',
        'Year Built': 'INTEGER'
      },
      strict_mode=false,
      ignore_errors=true,
      null_padding=true
    )`
    const useReservoirSample = filter.randomSample === true && whereClause === '1=1'
    const parcelCsvFrom = useReservoirSample
      ? `(SELECT * FROM ${parcelCsvSource} USING SAMPLE reservoir(${limit} ROWS))`
      : parcelCsvSource

    // Project only the columns we need (DuckDB will only parse referenced columns).
    // Also avoid ROW_NUMBER over `*`: rank using only the ID + roll year, then join to a small projection.
    const sql = `
      WITH base AS (
        SELECT
          "Assessor ID" AS assessor_id,
          "AIN" AS ain,
          COALESCE("Roll Year", 0) AS roll_year,
          COALESCE("Zip Code", '') AS zip_code,
          COALESCE("Zip Code", '') AS zip_code_full,
          "City Tax Rate Area" AS city_tax_rate_area,
          "Tax Rate Area Code" AS tax_rate_area_code,
          "Property Location" AS property_location,
          "Property Use Type" AS property_use_type,
          "Property Use Code" AS property_use_code,
          "Use Code 1st Digit" AS use_code_1,
          "Use Code 2nd Digit" AS use_code_2,
          "Use Code 3rd Digit" AS use_code_3,
          "Use Code 4th Digit" AS use_code_4,
          COALESCE("Number of Buildings", 0) AS number_of_buildings,
          COALESCE("Effective Year", 0) AS effective_year,
          COALESCE("Number of Bedrooms", 0) AS number_of_bedrooms,
          COALESCE("Number of Bathrooms", 0) AS number_of_bathrooms,
          COALESCE("Number of Units", 0) AS number_of_units,
          COALESCE(TRY_CAST("Number of Stories" AS DOUBLE), 0) AS number_of_stories,
          "Location Latitude" AS latitude,
          "Location Longitude" AS longitude,
          "Recording Date" AS recording_date,
          COALESCE("Total Value", 0) AS total_value,
          COALESCE("Total Exemption", 0) AS total_exemption,
          COALESCE("Taxable Value", 0) AS taxable_value,
          COALESCE("Land Value", 0) AS land_value,
          COALESCE("Improvement Value", 0) AS improvement_value,
          COALESCE("Land Base Year", 0) AS land_base_year,
          COALESCE("Improvement Base Year", 0) AS improvement_base_year,
          COALESCE("Total Value Land Improvement", 0) AS total_value_land_improvement,
          COALESCE("Home Owners Exemption", 0) AS home_owners_exemption,
          COALESCE("Real Estate Exemption", 0) AS real_estate_exemption,
          COALESCE("Fixture Value", 0) AS fixture_value,
          COALESCE("Fixture Exemption", 0) AS fixture_exemption,
          COALESCE("Personal Property Value", 0) AS personal_property_value,
          COALESCE("Personal Property Exemption", 0) AS personal_property_exemption,
          "Property taxable?" AS property_taxable,
          "Classification" AS classification,
          "Region Number" AS region_number,
          "Cluster Code" AS cluster_code,
          "Parcel Legal Description" AS parcel_legal_description,
          "Address House Number" AS address_house_number,
          "Address House Number Fraction" AS address_house_number_fraction,
          "Direction" AS direction,
          "Street" AS street,
          "Unit Number" AS unit_number,
          "City" AS city,
          "Row ID" AS row_id,
          "OBJECTID" AS object_id,
          COALESCE("Square Footage", 0) AS square_footage,
          COALESCE("Year Built", 0) AS year_built
        FROM ${parcelCsvFrom}
        WHERE ${whereClause}
      ),
      ranked AS (
        SELECT
          *,
          ROW_NUMBER() OVER (PARTITION BY assessor_id ORDER BY roll_year DESC) AS rn
        FROM base
      )
      SELECT
        assessor_id,
        ain,
        roll_year,
        zip_code,
        zip_code_full,
        city_tax_rate_area,
        tax_rate_area_code,
        property_location,
        property_use_type,
        property_use_code,
        use_code_1,
        use_code_2,
        use_code_3,
        use_code_4,
        number_of_buildings,
        effective_year,
        number_of_bedrooms,
        number_of_bathrooms,
        number_of_units,
        number_of_stories,
        latitude,
        longitude,
        recording_date,
        total_value,
        total_exemption,
        taxable_value,
        land_value,
        improvement_value,
        land_base_year,
        improvement_base_year,
        total_value_land_improvement,
        home_owners_exemption,
        real_estate_exemption,
        fixture_value,
        fixture_exemption,
        personal_property_value,
        personal_property_exemption,
        property_taxable,
        classification,
        region_number,
        cluster_code,
        parcel_legal_description,
        address_house_number,
        address_house_number_fraction,
        direction,
        street,
        unit_number,
        city,
        row_id,
        object_id,
        square_footage,
        year_built
      FROM ranked
      WHERE rn = 1
      ${useReservoirSample ? '' : orderClause}
      LIMIT ${limit}
    `

    const queryStart = Date.now()
    const rows = await this.query(sql)
    console.log(`${debugTag} base query`, { rows: rows.length, ms: Date.now() - queryStart })
    let allParcels = rows.map(p => this.rowToParcelRecord(p))
    allParcels = allParcels.map(parcel => ({ ...parcel, ...estimateSb79(parcel) }))

    // Cross-reference with C-of-O if requested
    if (filter.includeCofO && existsSync(COFO_CSV)) {
      const cofoStart = Date.now()
      allParcels = await this.enrichWithCofO(allParcels)
      console.log(`${debugTag} cofO enrich`, { ms: Date.now() - cofoStart })
    }

    const permitStart = Date.now()
    allParcels = await this.enrichWithPermitData(allParcels, filter)
    console.log(`${debugTag} permit enrich`, { ms: Date.now() - permitStart })

    // If hasCofO filter is set, post-filter
    if (filter.hasCofO === true) {
      allParcels = allParcels.filter(p => p.dataSource === 'both')
    }
    if (
      filter.buildingPermitCountMin != null || filter.buildingPermitCountMax != null ||
      filter.electricalPermitCountMin != null || filter.electricalPermitCountMax != null ||
      filter.submittedPermitCountMin != null || filter.submittedPermitCountMax != null ||
      filter.inspectionCountMin != null || filter.inspectionCountMax != null
    ) {
      allParcels = allParcels.filter((parcel) => {
        const building = Number(parcel.buildingPermitCount ?? 0)
        const electrical = Number(parcel.electricalPermitCount ?? 0)
        const submitted = Number(parcel.submittedBuildingPermitCount ?? 0)
        const inspections = Number(parcel.inspectionCount ?? 0)
        if (filter.buildingPermitCountMin != null && building < filter.buildingPermitCountMin) return false
        if (filter.buildingPermitCountMax != null && building > filter.buildingPermitCountMax) return false
        if (filter.electricalPermitCountMin != null && electrical < filter.electricalPermitCountMin) return false
        if (filter.electricalPermitCountMax != null && electrical > filter.electricalPermitCountMax) return false
        if (filter.submittedPermitCountMin != null && submitted < filter.submittedPermitCountMin) return false
        if (filter.submittedPermitCountMax != null && submitted > filter.submittedPermitCountMax) return false
        if (filter.inspectionCountMin != null && inspections < filter.inspectionCountMin) return false
        if (filter.inspectionCountMax != null && inspections > filter.inspectionCountMax) return false
        return true
      })
    }

    // Persist identity/provenance in the background so viewport queries return immediately.
    // The UI does not need to wait for this bookkeeping to finish before showing results.
    const persistStart = Date.now()
    void Promise.allSettled(allParcels.map(parcel => rentSeekerStore.recordParcelIdentity(parcel)))
      .catch(err => console.error('[ParcelCsvService] async identity persistence failed:', err))
    console.log(`${debugTag} queued identity persistence`, { parcels: allParcels.length, ms: Date.now() - persistStart })

    // Separate targets from surrounding
    const targetParcels = allParcels.filter(p => normalizedTargets.includes(p.assessorId))
    const surroundingParcels = allParcels.filter(p => !normalizedTargets.includes(p.assessorId))

    const result = {
      targetParcels,
      surroundingParcels,
      allParcels: [...targetParcels, ...surroundingParcels],
      totalFound: totalFound || allParcels.length,
      returnedCount: allParcels.length,
      queryTimeMs: Date.now() - startTime,
      csvPath: PARCEL_CSV
    }
    console.log(`${debugTag} done`, { returned: result.returnedCount, ms: result.queryTimeMs })
    return result
  }

  /* -------- C-of-O cross-reference -------- */

  private async enrichWithCofO(parcels: ParcelRecord[]): Promise<ParcelRecord[]> {
    if (parcels.length === 0) return parcels

    // Build a set of all AIN book prefixes for the parcels we have
    const bookPrefixes = new Set<string>()
    for (const p of parcels) {
      const book = extractBookPrefix(p.assessorId)
      if (book) bookPrefixes.add(book)
    }

    if (bookPrefixes.size === 0) return parcels

    // Query C-of-O CSV for matching assessor books
    // Use normalize_names because "CofO Issue Date" column has 256 chars of whitespace padding
    const bookConditions = [...bookPrefixes].map(b => `assessor_book = '${b}'`).join(' OR ')
    const cofoSql = `
      SELECT
        cofo_number,
        TRIM(cofo_issue_date) AS cofo_issue_date,
        status AS cofo_status,
        assessor_book AS book,
        assessor_page AS page,
        assessor_parcel AS parcel,
        permit_type,
        permit_subtype AS permit_sub_type,
        work_description,
        valuation,
        _zone AS zone,
        of_stories AS num_stories,
        contractors_business_name AS contractor_name
      FROM read_csv_auto('${COFO_CSV.replace(/'/g, "''")}', header=true, all_varchar=true, normalize_names=true)
      WHERE ${bookConditions}
    `

    try {
      const cofoRows = await this.query(cofoSql)

      // Build a lookup map: assessor_id -> cofo data (use first match)
      const cofoMap = new Map<string, Record<string, unknown>>()
      for (const row of cofoRows) {
        const book = String(row.book ?? '').trim().padStart(4, '0')
        const page = String(row.page ?? '').trim().padStart(3, '0')
        const parcel = String(row.parcel ?? '').trim().padStart(3, '0')
        const assessorId = `${book}-${page}-${parcel}`
        if (!cofoMap.has(assessorId)) {
          cofoMap.set(assessorId, row)
        }
      }

      // Enrich parcels
      return parcels.map(p => {
        const cofo = cofoMap.get(p.assessorId)
        if (cofo) {
          return {
            ...p,
            dataSource: 'both' as DataSource,
            dataSources: [...new Set([...(p.dataSources ?? ['parcel' as DataSource]), 'cofo' as DataSource])],
            cofoNumber: String(cofo.cofo_number ?? '').trim(),
            cofoIssueDate: String(cofo.cofo_issue_date ?? '').trim(),
            cofoStatus: String(cofo.cofo_status ?? '').trim(),
            permitType: String(cofo.permit_type ?? '').trim(),
            permitSubType: String(cofo.permit_sub_type ?? '').trim(),
            workDescription: String(cofo.work_description ?? '').trim(),
            cofoValuation: String(cofo.valuation ?? '').trim(),
            cofoZone: String(cofo.zone ?? '').trim(),
            numberOfStories: String(cofo.num_stories ?? '').trim(),
            contractorName: String(cofo.contractor_name ?? '').trim()
          }
        }
        return p
      })
    } catch (err) {
      console.error('[ParcelCsvService] C-of-O enrichment failed:', err)
      return parcels
    }
  }

  /* -------- Building/electrical permit cross-reference -------- */

  private async enrichWithPermitData(parcels: ParcelRecord[], filter: ParcelFilterQuery): Promise<ParcelRecord[]> {
    if (parcels.length === 0) return parcels

    const apnDigits = [...new Set(parcels.map(p => p.assessorId.replace(/[^0-9]/g, '')).filter(Boolean))]
    if (apnDigits.length === 0) return parcels

    const includeBuilding = filter.includeBuildingPermits !== false
    const includeElectrical = filter.includeElectricalPermits !== false
    const includeSubmitted = filter.includeSubmittedPermits !== false
    const includeInspections = filter.includeInspections !== false

    const [buildingMap, electricalMap, submittedMap] = await Promise.all([
      includeBuilding && existsSync(BUILDING_PERMITS_CSV)
        ? this.queryPermitSummary(BUILDING_PERMITS_CSV, apnDigits, 'building')
        : Promise.resolve(new Map<string, Record<string, unknown>>()),
      includeElectrical && existsSync(ELECTRICAL_PERMITS_CSV)
        ? this.queryPermitSummary(ELECTRICAL_PERMITS_CSV, apnDigits, 'electrical')
        : Promise.resolve(new Map<string, Record<string, unknown>>()),
      includeSubmitted && existsSync(BUILDING_PERMITS_SUBMITTED_CSV)
        ? this.queryPermitSummary(BUILDING_PERMITS_SUBMITTED_CSV, apnDigits, 'building')
        : Promise.resolve(new Map<string, Record<string, unknown>>())
    ])

    const permitNumbers = new Set<string>()
    for (const map of [buildingMap, electricalMap, submittedMap]) {
      for (const row of map.values()) {
        String(row.permit_numbers ?? '').split(',').map(s => s.trim()).filter(Boolean).forEach(n => permitNumbers.add(n))
      }
    }
    const inspectionMap = includeInspections && existsSync(INSPECTIONS_CSV) && permitNumbers.size > 0
      ? await this.queryInspectionSummary([...permitNumbers])
      : new Map<string, Record<string, unknown>>()

    return parcels.map((parcel) => {
      const key = parcel.assessorId.replace(/[^0-9]/g, '')
      const building = buildingMap.get(key)
      const electrical = electricalMap.get(key)
      const submitted = submittedMap.get(key)
      const dataSources = new Set<DataSource>(parcel.dataSources ?? ['parcel'])
      if (building) dataSources.add('building_permit')
      if (electrical) dataSources.add('electrical_permit')
      if (submitted) dataSources.add('building_permit_submitted')

      const parcelPermitNumbers = [
        String(building?.permit_numbers ?? ''),
        String(electrical?.permit_numbers ?? ''),
        String(submitted?.permit_numbers ?? '')
      ].join(',').split(',').map(s => s.trim()).filter(Boolean)
      const inspections = parcelPermitNumbers
        .map(permit => inspectionMap.get(permit))
        .filter((row): row is Record<string, unknown> => Boolean(row))
      if (inspections.length > 0) dataSources.add('inspection')
      const latestInspection = inspections[0]

      return {
        ...parcel,
        dataSources: [...dataSources],
        buildingPermitCount: building ? Number(building.permit_count ?? 0) : parcel.buildingPermitCount,
        buildingPermitValuation: building ? Number(building.total_valuation ?? 0) : parcel.buildingPermitValuation,
        latestBuildingPermit: building ? String(building.latest_permit ?? '').trim() : parcel.latestBuildingPermit,
        latestBuildingPermitStatus: building ? String(building.latest_status ?? '').trim() : parcel.latestBuildingPermitStatus,
        latestBuildingPermitDescription: building ? String(building.latest_work_desc ?? '').trim() : parcel.latestBuildingPermitDescription,
        electricalPermitCount: electrical ? Number(electrical.permit_count ?? 0) : parcel.electricalPermitCount,
        latestElectricalPermit: electrical ? String(electrical.latest_permit ?? '').trim() : parcel.latestElectricalPermit,
        latestElectricalPermitStatus: electrical ? String(electrical.latest_status ?? '').trim() : parcel.latestElectricalPermitStatus,
        latestElectricalPermitDescription: electrical ? String(electrical.latest_work_desc ?? '').trim() : parcel.latestElectricalPermitDescription,
        submittedBuildingPermitCount: submitted ? Number(submitted.permit_count ?? 0) : parcel.submittedBuildingPermitCount,
        latestSubmittedBuildingPermit: submitted ? String(submitted.latest_permit ?? '').trim() : parcel.latestSubmittedBuildingPermit,
        latestSubmittedBuildingPermitStatus: submitted ? String(submitted.latest_status ?? '').trim() : parcel.latestSubmittedBuildingPermitStatus,
        latestSubmittedBuildingPermitDescription: submitted ? String(submitted.latest_work_desc ?? '').trim() : parcel.latestSubmittedBuildingPermitDescription,
        inspectionCount: inspections.reduce((sum, row) => sum + Number(row.inspection_count ?? 0), 0) || parcel.inspectionCount,
        latestInspection: latestInspection ? String(latestInspection.latest_inspection_date ?? '').trim() : parcel.latestInspection,
        latestInspectionStatus: latestInspection ? String(latestInspection.latest_result ?? '').trim() : parcel.latestInspectionStatus,
        latestInspectionDescription: latestInspection ? String(latestInspection.latest_type ?? '').trim() : parcel.latestInspectionDescription
      }
    })
  }

  private async queryPermitSummary(
    csvPath: string,
    apnDigits: string[],
    kind: 'building' | 'electrical'
  ): Promise<Map<string, Record<string, unknown>>> {
    const safePath = csvPath.replace(/'/g, "''")
    const inList = apnDigits.map(apn => `'${apn.replace(/'/g, "''")}'`).join(',')
    const valuationExpr = kind === 'building'
      ? "TRY_CAST(regexp_replace(COALESCE(valuation, ''), '[^0-9.-]', '', 'g') AS DOUBLE)"
      : '0'

    const sql = `
      WITH permits AS (
        SELECT
          REPLACE(COALESCE(apn, ''), '-', '') AS apn_digits,
          permit_nbr,
          status_desc,
          issue_date,
          work_desc,
          ${valuationExpr} AS valuation_numeric
        FROM read_csv_auto('${safePath}', header=true, all_varchar=true, normalize_names=true)
        WHERE REPLACE(COALESCE(apn, ''), '-', '') IN (${inList})
      ),
      ranked AS (
        SELECT *,
          ROW_NUMBER() OVER (
            PARTITION BY apn_digits
            ORDER BY TRY_CAST(issue_date AS DATE) DESC NULLS LAST, permit_nbr DESC
          ) AS rn
        FROM permits
      )
      SELECT
        apn_digits,
        COUNT(*) AS permit_count,
        SUM(COALESCE(valuation_numeric, 0)) AS total_valuation,
        STRING_AGG(permit_nbr, ',') AS permit_numbers,
        MAX(CASE WHEN rn = 1 THEN permit_nbr END) AS latest_permit,
        MAX(CASE WHEN rn = 1 THEN status_desc END) AS latest_status,
        MAX(CASE WHEN rn = 1 THEN work_desc END) AS latest_work_desc
      FROM ranked
      GROUP BY apn_digits
    `

    try {
      const rows = await this.query(sql)
      return new Map(rows.map(row => [String(row.apn_digits ?? ''), row]))
    } catch (err) {
      console.error(`[ParcelCsvService] ${kind} permit enrichment failed:`, err)
      return new Map()
    }
  }

  private async queryInspectionSummary(permitNumbers: string[]): Promise<Map<string, Record<string, unknown>>> {
    const safePath = INSPECTIONS_CSV.replace(/'/g, "''")
    const inList = permitNumbers.map(permit => `'${permit.replace(/'/g, "''")}'`).join(',')
    const sql = `
      WITH inspections AS (
        SELECT
          permit,
          permit_status,
          inspection_date,
          inspection_type,
          inspection_result
        FROM read_csv_auto('${safePath}', header=true, all_varchar=true, normalize_names=true)
        WHERE permit IN (${inList})
      ),
      ranked AS (
        SELECT *,
          ROW_NUMBER() OVER (
            PARTITION BY permit
            ORDER BY TRY_CAST(inspection_date AS DATE) DESC NULLS LAST, inspection_type DESC
          ) AS rn
        FROM inspections
      )
      SELECT
        permit,
        COUNT(*) AS inspection_count,
        MAX(CASE WHEN rn = 1 THEN inspection_date END) AS latest_inspection_date,
        MAX(CASE WHEN rn = 1 THEN inspection_type END) AS latest_type,
        MAX(CASE WHEN rn = 1 THEN COALESCE(inspection_result, permit_status) END) AS latest_result
      FROM ranked
      GROUP BY permit
    `

    try {
      const rows = await this.query(sql)
      return new Map(rows.map(row => [String(row.permit ?? ''), row]))
    } catch (err) {
      console.error('[ParcelCsvService] inspection enrichment failed:', err)
      return new Map()
    }
  }

  /* -------- WHERE clause builder -------- */

  private buildWhereClause(filter: ParcelFilterQuery): string {
    const conditions: string[] = []

    // Target parcels (specific APNs)
    if (filter.targetParcels) {
      const rawTargets = filter.targetParcels.split(',').map(s => s.trim()).filter(Boolean)
      const normalizedTargets = rawTargets.map(normalizeParcelNumber)
      const bookPrefixes = [...new Set(normalizedTargets.map(extractBookPrefix))]
      const bookConds = bookPrefixes.map(p => `"Assessor ID" LIKE '${p}-%'`).join(' OR ')
      conditions.push(`(${bookConds})`)
    }

    // APN prefix (first 4 digits = book number)
    if (filter.apnPrefix) {
      const prefix = filter.apnPrefix.replace(/[^0-9]/g, '').slice(0, 4)
      if (prefix) {
        conditions.push(`"Assessor ID" LIKE '${prefix}-%'`)
      }
    }

    // Value range
    if (filter.valueMin != null && filter.valueMin > 0) {
      conditions.push(`COALESCE("Total Value", 0) >= ${filter.valueMin}`)
    }
    if (filter.valueMax != null) {
      conditions.push(`COALESCE("Total Value", 0) <= ${filter.valueMax}`)
    }

    // Built / unbuilt
    if (filter.builtState === 'built') {
      conditions.push('(COALESCE("Number of Buildings", 0) > 0 OR COALESCE("Year Built", 0) > 0)')
    }
    if (filter.builtState === 'unbuilt') {
      conditions.push('(COALESCE("Number of Buildings", 0) <= 0 AND COALESCE("Year Built", 0) <= 0)')
    }

    // Use type
    if (filter.useType) {
      conditions.push(`"Property Use Type" = '${filter.useType.replace(/'/g, "''")}'`)
    }
    if (filter.propertyUseCode?.trim()) {
      conditions.push(`LOWER(COALESCE("Property Use Code", '')) = LOWER('${filter.propertyUseCode.replace(/'/g, "''")}')`)
    }
    if (filter.useCode3?.trim()) {
      conditions.push(`LOWER(COALESCE("Use Code 3rd Digit", '')) = LOWER('${filter.useCode3.replace(/'/g, "''")}')`)
    }
    if (filter.city?.trim()) {
      conditions.push(`LOWER(COALESCE("City", '')) = LOWER('${filter.city.replace(/'/g, "''")}')`)
    }
    if (filter.zipCode?.trim()) {
      conditions.push(`COALESCE("Zip Code", '') = '${filter.zipCode.replace(/'/g, "''")}'`)
    }
    if (filter.cityTaxRateArea?.trim()) {
      conditions.push(`LOWER(COALESCE("City Tax Rate Area", '')) = LOWER('${filter.cityTaxRateArea.replace(/'/g, "''")}')`)
    }
    if (filter.taxRateAreaCode?.trim()) {
      conditions.push(`LOWER(COALESCE("Tax Rate Area Code", '')) = LOWER('${filter.taxRateAreaCode.replace(/'/g, "''")}')`)
    }

    // Year built range
    if (filter.yearBuiltMin != null && filter.yearBuiltMin > 0) {
      conditions.push(`COALESCE("Year Built", 0) >= ${filter.yearBuiltMin}`)
    }
    if (filter.yearBuiltMax != null) {
      conditions.push(`COALESCE("Year Built", 0) <= ${filter.yearBuiltMax}`)
    }
    if (filter.effectiveYearMin != null && filter.effectiveYearMin > 0) {
      conditions.push(`COALESCE("Effective Year", 0) >= ${filter.effectiveYearMin}`)
    }
    if (filter.effectiveYearMax != null) {
      conditions.push(`COALESCE("Effective Year", 0) <= ${filter.effectiveYearMax}`)
    }
    if (filter.rollYearMin != null && filter.rollYearMin > 0) {
      conditions.push(`COALESCE("Roll Year", 0) >= ${filter.rollYearMin}`)
    }
    if (filter.rollYearMax != null) {
      conditions.push(`COALESCE("Roll Year", 0) <= ${filter.rollYearMax}`)
    }

    // Square footage
    if (filter.sqftMin != null && filter.sqftMin > 0) {
      conditions.push(`COALESCE("Square Footage", 0) >= ${filter.sqftMin}`)
    }
    if (filter.sqftMax != null) {
      conditions.push(`COALESCE("Square Footage", 0) <= ${filter.sqftMax}`)
    }

    // Bedrooms
    if (filter.bedMin != null && filter.bedMin > 0) {
      conditions.push(`COALESCE("Number of Bedrooms", 0) >= ${filter.bedMin}`)
    }
    if (filter.bedMax != null) {
      conditions.push(`COALESCE("Number of Bedrooms", 0) <= ${filter.bedMax}`)
    }

    // Bathrooms
    if (filter.bathMin != null && filter.bathMin > 0) {
      conditions.push(`COALESCE("Number of Bathrooms", 0) >= ${filter.bathMin}`)
    }
    if (filter.bathMax != null) {
      conditions.push(`COALESCE("Number of Bathrooms", 0) <= ${filter.bathMax}`)
    }

    // Units
    if (filter.unitMin != null && filter.unitMin > 0) {
      conditions.push(`COALESCE("Number of Units", 0) >= ${filter.unitMin}`)
    }
    if (filter.unitMax != null) {
      conditions.push(`COALESCE("Number of Units", 0) <= ${filter.unitMax}`)
    }

    // Building count
    if (filter.buildingCountMin != null && filter.buildingCountMin > 0) {
      conditions.push(`COALESCE("Number of Buildings", 0) >= ${filter.buildingCountMin}`)
    }
    if (filter.buildingCountMax != null) {
      conditions.push(`COALESCE("Number of Buildings", 0) <= ${filter.buildingCountMax}`)
    }
    if (filter.storiesMin != null && filter.storiesMin > 0) {
      conditions.push(`COALESCE(TRY_CAST("Number of Stories" AS DOUBLE), 0) >= ${filter.storiesMin}`)
    }
    if (filter.storiesMax != null) {
      conditions.push(`COALESCE(TRY_CAST("Number of Stories" AS DOUBLE), 0) <= ${filter.storiesMax}`)
    }

    if (filter.landBaseYearMin != null && filter.landBaseYearMin > 0) {
      conditions.push(`COALESCE("Land Base Year", 0) >= ${filter.landBaseYearMin}`)
    }
    if (filter.landBaseYearMax != null) {
      conditions.push(`COALESCE("Land Base Year", 0) <= ${filter.landBaseYearMax}`)
    }
    if (filter.improvementBaseYearMin != null && filter.improvementBaseYearMin > 0) {
      conditions.push(`COALESCE("Improvement Base Year", 0) >= ${filter.improvementBaseYearMin}`)
    }
    if (filter.improvementBaseYearMax != null) {
      conditions.push(`COALESCE("Improvement Base Year", 0) <= ${filter.improvementBaseYearMax}`)
    }

    if (filter.landValueMin != null && filter.landValueMin > 0) {
      conditions.push(`COALESCE("Land Value", 0) >= ${filter.landValueMin}`)
    }
    if (filter.landValueMax != null) {
      conditions.push(`COALESCE("Land Value", 0) <= ${filter.landValueMax}`)
    }
    if (filter.improvementValueMin != null && filter.improvementValueMin > 0) {
      conditions.push(`COALESCE("Improvement Value", 0) >= ${filter.improvementValueMin}`)
    }
    if (filter.improvementValueMax != null) {
      conditions.push(`COALESCE("Improvement Value", 0) <= ${filter.improvementValueMax}`)
    }
    if (filter.taxableValueMin != null && filter.taxableValueMin > 0) {
      conditions.push(`COALESCE("Taxable Value", 0) >= ${filter.taxableValueMin}`)
    }
    if (filter.taxableValueMax != null) {
      conditions.push(`COALESCE("Taxable Value", 0) <= ${filter.taxableValueMax}`)
    }
    if (filter.homeOwnersExemptionMin != null && filter.homeOwnersExemptionMin > 0) {
      conditions.push(`COALESCE("Home Owners Exemption", 0) >= ${filter.homeOwnersExemptionMin}`)
    }
    if (filter.homeOwnersExemptionMax != null) {
      conditions.push(`COALESCE("Home Owners Exemption", 0) <= ${filter.homeOwnersExemptionMax}`)
    }
    if (filter.realEstateExemptionMin != null && filter.realEstateExemptionMin > 0) {
      conditions.push(`COALESCE("Real Estate Exemption", 0) >= ${filter.realEstateExemptionMin}`)
    }
    if (filter.realEstateExemptionMax != null) {
      conditions.push(`COALESCE("Real Estate Exemption", 0) <= ${filter.realEstateExemptionMax}`)
    }
    if (filter.fixtureValueMin != null && filter.fixtureValueMin > 0) {
      conditions.push(`COALESCE("Fixture Value", 0) >= ${filter.fixtureValueMin}`)
    }
    if (filter.fixtureValueMax != null) {
      conditions.push(`COALESCE("Fixture Value", 0) <= ${filter.fixtureValueMax}`)
    }
    if (filter.fixtureExemptionMin != null && filter.fixtureExemptionMin > 0) {
      conditions.push(`COALESCE("Fixture Exemption", 0) >= ${filter.fixtureExemptionMin}`)
    }
    if (filter.fixtureExemptionMax != null) {
      conditions.push(`COALESCE("Fixture Exemption", 0) <= ${filter.fixtureExemptionMax}`)
    }
    if (filter.personalPropertyValueMin != null && filter.personalPropertyValueMin > 0) {
      conditions.push(`COALESCE("Personal Property Value", 0) >= ${filter.personalPropertyValueMin}`)
    }
    if (filter.personalPropertyValueMax != null) {
      conditions.push(`COALESCE("Personal Property Value", 0) <= ${filter.personalPropertyValueMax}`)
    }
    if (filter.personalPropertyExemptionMin != null && filter.personalPropertyExemptionMin > 0) {
      conditions.push(`COALESCE("Personal Property Exemption", 0) >= ${filter.personalPropertyExemptionMin}`)
    }
    if (filter.personalPropertyExemptionMax != null) {
      conditions.push(`COALESCE("Personal Property Exemption", 0) <= ${filter.personalPropertyExemptionMax}`)
    }
    if (filter.totalExemptionMin != null && filter.totalExemptionMin > 0) {
      conditions.push(`COALESCE("Total Exemption", 0) >= ${filter.totalExemptionMin}`)
    }
    if (filter.totalExemptionMax != null) {
      conditions.push(`COALESCE("Total Exemption", 0) <= ${filter.totalExemptionMax}`)
    }
    if (filter.propertyTaxable?.trim()) {
      conditions.push(`LOWER(COALESCE("Property Taxable", '')) = LOWER('${filter.propertyTaxable.replace(/'/g, "''")}')`)
    }
    if (filter.classification?.trim()) {
      conditions.push(`LOWER(COALESCE("Classification", '')) LIKE LOWER('${filter.classification.replace(/'/g, "''")}%')`)
    }
    if (filter.regionNumber?.trim()) {
      conditions.push(`LOWER(COALESCE("Region Number", '')) = LOWER('${filter.regionNumber.replace(/'/g, "''")}')`)
    }
    if (filter.clusterCode?.trim()) {
      conditions.push(`LOWER(COALESCE("Cluster Code", '')) = LOWER('${filter.clusterCode.replace(/'/g, "''")}')`)
    }

    // Viewport bounds
    if (filter.bounds) {
      const { north, south, east, west } = filter.bounds
      conditions.push(`"Location Latitude" BETWEEN ${south} AND ${north}`)
      conditions.push(`"Location Longitude" BETWEEN ${west} AND ${east}`)
    }

    // Free text search
    if (filter.searchText && filter.searchText.trim()) {
      const needles = expandAddressNeedles(filter.searchText).map(needle => needle.replace(/'/g, "''"))
      const needleConditions = needles.map(needle => `(
          "Property Location" ILIKE '%${needle}%'
          OR "Parcel Legal Description" ILIKE '%${needle}%'
          OR "Street" ILIKE '%${needle}%'
          OR "City" ILIKE '%${needle}%'
          OR "Assessor ID" ILIKE '%${needle}%'
          OR "AIN" ILIKE '%${needle}%'
        )`)
      conditions.push(`(${needleConditions.join(' OR ')})`)
    }

    return conditions.length > 0 ? conditions.join(' AND ') : '1=1'
  }

  /* -------- ORDER BY builder -------- */

  private buildOrderClause(filter: ParcelFilterQuery): string {
    const fieldMap: Record<string, string> = {
      assessorId: 'assessor_id',
      totalValue: 'total_value',
      squareFootage: 'square_footage',
      yearBuilt: 'year_built',
      effectiveYear: 'effective_year',
      rollYear: 'roll_year',
      landBaseYear: 'land_base_year',
      improvementBaseYear: 'improvement_base_year',
      bedrooms: 'number_of_bedrooms',
      bathrooms: 'number_of_bathrooms',
      units: 'number_of_units',
      buildingCount: 'number_of_buildings',
      stories: 'number_of_stories',
      taxableValue: 'taxable_value',
      landValue: 'land_value',
      improvementValue: 'improvement_value',
      propertyUseCode: 'property_use_code',
      useCode3: 'use_code_3',
      city: 'city',
      zipCode: 'zip_code',
      cityTaxRateArea: 'city_tax_rate_area',
      taxRateAreaCode: 'tax_rate_area_code',
      homeOwnersExemption: 'home_owners_exemption',
      realEstateExemption: 'real_estate_exemption',
      fixtureValue: 'fixture_value',
      fixtureExemption: 'fixture_exemption',
      personalPropertyValue: 'personal_property_value',
      personalPropertyExemption: 'personal_property_exemption',
      totalExemption: 'total_exemption',
      classification: 'classification',
      regionNumber: 'region_number',
      clusterCode: 'cluster_code'
    }
    if (filter.randomSample) {
      return 'ORDER BY random()'
    }
    if (filter.sortField && fieldMap[filter.sortField]) {
      const dir = filter.sortDir === 'desc' ? 'DESC' : 'ASC'
      return `ORDER BY ${fieldMap[filter.sortField]} ${dir}`
    }
    return 'ORDER BY "Assessor ID"'
  }

  async destroy(): Promise<void> {
    this.connection = null
    this.instance = null
  }

  /* -------- private helpers -------- */

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
      numberOfStories: String(row.number_of_stories ?? '').trim(),
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
      objectId: String(row.object_id ?? '').trim(),
      dataSource: 'parcel' as DataSource,
      dataSources: ['parcel' as DataSource]
    }
  }

  private async exec(sql: string): Promise<void> {
    if (!this.connection) throw new Error('ParcelCsvService not initialized')
    await this.connection.run(sql)
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
