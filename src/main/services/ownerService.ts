/**
 * OwnerService — SBF (Secured Basic File) owner intelligence engine
 * 
 * Queries the LA County Assessor's SBF data (3 CSV parts) via DuckDB.
 * Provides owner lookup by AIN, portfolio aggregation by owner name,
 * top-owner rankings, heat map generation, and owner search.
 * 
 * This is the KING dataset — gold crown — displayed on top of all others.
 */

import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api'
import { existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import type {
  OwnerRecord, OwnerPortfolio, TopOwnerEntry,
  HeatMapCell, AnalyticsSortBy, DistributionsResponse, DistributionBin
} from '@shared/types'

/* ═══════════════ DATA PATHS ═══════════════ */

const SBF_DIR = '/Users/rjack/Desktop/almanac/Docs/RE Data/SBF Secured Basic File LA County Assessor Abstract'
const SBF_PARTS = [
  `${SBF_DIR}/sbf_part1.csv`,
  `${SBF_DIR}/sbf_part2.csv`,
  `${SBF_DIR}/sbf_part3.csv`
]

const OWNER_DB_PATH = join('/Users/rjack/Desktop/almanac/RentSeeker', '.rentseeker', 'owner.duckdb')

function ownerNameTokens(ownerName: string): string[] {
  const expanded = ownerName
    .replace(/,/g, ' ')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token.length > 1)
  return [...new Set(expanded)].slice(0, 8)
}

/* ═══════════════ SERVICE ═══════════════ */

export class OwnerService {
  private instance: DuckDBInstance | null = null
  private connection: DuckDBConnection | null = null
  private sbfReady = false
  private sbfBuildPromise: Promise<void> | null = null
  private ownerByAinCache: Map<string, OwnerRecord | null> = new Map()
  private ownerByAinCacheLimit = 1500

  async initialize(): Promise<void> {
    if (this.connection) return
    mkdirSync(dirname(OWNER_DB_PATH), { recursive: true })
    this.instance = await DuckDBInstance.create(OWNER_DB_PATH)
    this.connection = await this.instance.connect()
    await this.exec('SET threads = 4')
    await this.exec('PRAGMA enable_object_cache')
  }

  private async exec(sql: string): Promise<void> {
    if (!this.connection) throw new Error('Not initialized')
    await this.connection.run(sql)
  }

  private async query(sql: string): Promise<Record<string, unknown>[]> {
    if (!this.connection) throw new Error('Not initialized')
    const reader = await this.connection.runAndReadAll(sql)
    return reader.getRowObjectsJson() as Record<string, unknown>[]
  }

  /**
   * Check which SBF CSV parts are available
   */
  getAvailableParts(): string[] {
    return SBF_PARTS.filter(p => existsSync(p))
  }

  isAvailable(): boolean {
    return this.getAvailableParts().length > 0
  }

  /**
   * Ensure SBF is materialized into a local DuckDB table (fast lookups).
   * Reading directly from CSV on every query is too slow for per-parcel UI.
   */
  private async ensureSbfTable(): Promise<void> {
    if (this.sbfReady) return
    if (this.sbfBuildPromise) return this.sbfBuildPromise

    this.sbfBuildPromise = (async () => {
      await this.initialize()

      const parts = this.getAvailableParts()
      if (parts.length === 0) {
        throw new Error('No SBF CSV files found. Run the xlsx→csv conversion first.')
      }

      const tableRows = await this.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.tables
        WHERE table_schema = 'main' AND table_name = 'sbf'
      `)
      const exists = Number(tableRows[0]?.cnt ?? 0) > 0
      if (!exists) {
        const unions = parts.map(p =>
          `SELECT * FROM read_csv_auto('${p.replace(/'/g, "''")}', header=true, all_varchar=true, normalize_names=true, sample_size=5000)`
        ).join('\n  UNION ALL\n  ')

        // Stage table so we can add normalized join keys.
        await this.exec(`CREATE TABLE sbf_stage AS (\n  ${unions}\n)`)
        await this.exec(`
          CREATE TABLE sbf AS
          SELECT
            regexp_replace(COALESCE(ain, ''), '[^0-9]', '', 'g') AS ain_digits,
            *
          FROM sbf_stage
        `)
        await this.exec(`DROP TABLE sbf_stage`)

        // Best-effort index; some DuckDB builds may not support indexes yet.
        try { await this.exec(`CREATE INDEX sbf_ain_digits_idx ON sbf(ain_digits)`) } catch { /* ignore */ }
        try { await this.exec(`ANALYZE sbf`) } catch { /* ignore */ }
      }

      this.sbfReady = true
    })().finally(() => {
      this.sbfBuildPromise = null
    })

    return this.sbfBuildPromise
  }

  /**
   * Convert a raw DuckDB row to an OwnerRecord
   */
  private rowToOwnerRecord(row: Record<string, unknown>): OwnerRecord {
    return {
      ain: String(row.ain ?? '').trim(),
      ownerName: String(row.first_owner_name ?? '').trim(),
      situsAddress: [
        String(row.situshouseno ?? '').trim(),
        String(row.situsfraction ?? '').trim(),
        String(row.situsdirection ?? '').trim(),
        String(row.situsstreet ?? '').trim()
      ].filter(Boolean).join(' '),
      situsCity: String(row.situscity ?? '').trim(),
      situsZip: String(row.situszip ?? '').trim(),
      mailAddress: [
        String(row.mailhouseno ?? '').trim(),
        String(row.mailfraction ?? '').trim(),
        String(row.maildirection ?? '').trim(),
        String(row.mailstreet ?? '').trim()
      ].filter(Boolean).join(' '),
      mailCity: String(row.mailcity ?? '').trim(),
      mailZip: String(row.mailzip ?? '').trim(),
      landValue: Number(row.land_current_value ?? 0) || 0,
      impValue: Number(row.imp_current_value ?? 0) || 0,
      totalValue: (Number(row.land_current_value ?? 0) || 0) + (Number(row.imp_current_value ?? 0) || 0),
      saleAmount: Number(row.sale_amount ?? 0) || 0,
      saleDate: String(row.sale_date ?? '').trim(),
      lastSale2Amount: Number(row.lastsale2amount ?? 0) || 0,
      lastSale2Date: String(row.lastsale2date ?? '').trim(),
      lastSale3Amount: Number(row.lastsale3amount ?? 0) || 0,
      lastSale3Date: String(row.lastsale3date ?? '').trim(),
      zoningCode: String(row.zoning_code ?? '').trim(),
      useCode: String(row.usecode ?? '').trim(),
      yearBuilt: String(row.yearbuilt ?? '').trim(),
      sqftMain: Number(row.sqftmain ?? 0) || 0,
      lotSize: Number(row.lot_size ?? 0) || 0,
      acres: Number(row.acres ?? 0) || 0,
      units: Number(row.units ?? 0) || 0,
      bedrooms: Number(row.bedrooms ?? 0) || 0,
      bathrooms: Number(row.bathrooms ?? 0) || 0,
      latitude: Number(row.latitude ?? 0) || 0,
      longitude: Number(row.longitude ?? 0) || 0,
      recordingDate: String(row.recording_date ?? '').trim(),
      documentType: String(row.documenttype ?? '').trim(),
      hazardCode: String(row.hazard_code ?? '').trim(),
      designType: String(row.designtype ?? '').trim(),
      qualityClass: String(row.qualityclass ?? '').trim()
    }
  }

  /* ═══════════════ QUERIES ═══════════════ */

  /**
   * Get owner info for a specific parcel by AIN
   */
  async getOwnerByAin(ain: string): Promise<OwnerRecord | null> {
    await this.ensureSbfTable()
    const cleanAin = ain.replace(/[^0-9]/g, '')
    if (this.ownerByAinCache.has(cleanAin)) {
      const cached = this.ownerByAinCache.get(cleanAin) ?? null
      // refresh LRU order
      this.ownerByAinCache.delete(cleanAin)
      this.ownerByAinCache.set(cleanAin, cached)
      return cached
    }
    const rows = await this.query(
      `SELECT * FROM sbf WHERE ain_digits = '${cleanAin}' LIMIT 1`
    )
    const record = rows.length === 0 ? null : this.rowToOwnerRecord(rows[0])
    this.ownerByAinCache.set(cleanAin, record)
    if (this.ownerByAinCache.size > this.ownerByAinCacheLimit) {
      const first = this.ownerByAinCache.keys().next().value
      if (first) this.ownerByAinCache.delete(first)
    }
    return record
  }

  /**
   * Get all parcels owned by a specific owner name
   */
  async getOwnerPortfolio(ownerName: string, limit: number = 500): Promise<OwnerPortfolio> {
    await this.ensureSbfTable()
    const escaped = ownerName.replace(/'/g, "''")
    const tokens = ownerNameTokens(ownerName)
    const tokenClause = tokens.length > 0
      ? ` OR (${tokens.map(token => `first_owner_name ILIKE '%${token.replace(/'/g, "''")}%'`).join(' AND ')})`
      : ''
    const rows = await this.query(
      `SELECT * FROM sbf WHERE first_owner_name ILIKE '%${escaped}%'${tokenClause} ORDER BY ain LIMIT ${limit}`
    )

    const parcels = rows.map(r => this.rowToOwnerRecord(r))
    const cities = [...new Set(parcels.map(p => p.situsCity).filter(Boolean))]
    const zoningCodes = [...new Set(parcels.map(p => p.zoningCode).filter(Boolean))]

    return {
      ownerName,
      parcels,
      totalParcels: parcels.length,
      totalValue: parcels.reduce((s, p) => s + p.totalValue, 0),
      totalAcres: parcels.reduce((s, p) => s + p.acres, 0),
      totalSqft: parcels.reduce((s, p) => s + p.sqftMain, 0),
      avgLotSize: parcels.length > 0
        ? parcels.reduce((s, p) => s + p.lotSize, 0) / parcels.length
        : 0,
      cities,
      zoningCodes
    }
  }

  /**
   * Get top owners ranked by various criteria
   */
  async getTopOwners(sortBy: AnalyticsSortBy = 'parcel_count', limit: number = 50): Promise<TopOwnerEntry[]> {
    await this.ensureSbfTable()

    const orderCol = {
      parcel_count: 'cnt',
      total_value: 'total_val',
      total_acres: 'total_acres',
      total_sqft: 'total_sqft',
      avg_value: 'avg_val'
    }[sortBy] || 'cnt'

    const rows = await this.query(`
      SELECT
        first_owner_name AS owner_name,
        COUNT(*) AS cnt,
        SUM(CAST(COALESCE(NULLIF(land_current_value, ''), '0') AS DOUBLE)
          + CAST(COALESCE(NULLIF(imp_current_value, ''), '0') AS DOUBLE)) AS total_val,
        SUM(CAST(COALESCE(NULLIF(acres, ''), '0') AS DOUBLE)) AS total_acres,
        SUM(CAST(COALESCE(NULLIF(sqftmain, ''), '0') AS DOUBLE)) AS total_sqft,
        AVG(CAST(COALESCE(NULLIF(land_current_value, ''), '0') AS DOUBLE)
          + CAST(COALESCE(NULLIF(imp_current_value, ''), '0') AS DOUBLE)) AS avg_val
      FROM sbf
      WHERE first_owner_name IS NOT NULL AND TRIM(first_owner_name) != ''
      GROUP BY first_owner_name
      HAVING COUNT(*) > 1
      ORDER BY ${orderCol} DESC
      LIMIT ${limit}
    `)

    return rows.map(r => ({
      ownerName: String(r.owner_name ?? ''),
      parcelCount: Number(r.cnt ?? 0),
      totalValue: Number(r.total_val ?? 0),
      totalAcres: Number(r.total_acres ?? 0),
      totalSqft: Number(r.total_sqft ?? 0),
      avgValue: Number(r.avg_val ?? 0)
    }))
  }

  async getDistributions(): Promise<DistributionsResponse> {
    await this.ensureSbfTable()

    const valueBins: Array<[number, number | null, string]> = [
      [0, 250000, '$0–250k'],
      [250000, 500000, '$250k–500k'],
      [500000, 1000000, '$500k–1M'],
      [1000000, 2000000, '$1M–2M'],
      [2000000, 5000000, '$2M–5M'],
      [5000000, 10000000, '$5M–10M'],
      [10000000, 20000000, '$10M–20M'],
      [20000000, null, '$20M+']
    ]

    const lotBins: Array<[number, number | null, string]> = [
      [0, 2000, '0–2k'],
      [2000, 5000, '2k–5k'],
      [5000, 7500, '5k–7.5k'],
      [7500, 10000, '7.5k–10k'],
      [10000, 20000, '10k–20k'],
      [20000, 50000, '20k–50k'],
      [50000, null, '50k+']
    ]

    const valueSqlParts = valueBins.map(([lo, hi, label], i) => (
      hi == null
        ? `SUM(CASE WHEN tv >= ${lo} THEN 1 ELSE 0 END) AS v${i}`
        : `SUM(CASE WHEN tv >= ${lo} AND tv < ${hi} THEN 1 ELSE 0 END) AS v${i}`
    ))
    const lotSqlParts = lotBins.map(([lo, hi, label], i) => (
      hi == null
        ? `SUM(CASE WHEN lot >= ${lo} THEN 1 ELSE 0 END) AS l${i}`
        : `SUM(CASE WHEN lot >= ${lo} AND lot < ${hi} THEN 1 ELSE 0 END) AS l${i}`
    ))

    const rows = await this.query(`
      WITH base AS (
        SELECT
          CAST(COALESCE(NULLIF(land_current_value, ''), '0') AS DOUBLE)
          + CAST(COALESCE(NULLIF(imp_current_value, ''), '0') AS DOUBLE) AS tv,
          CAST(COALESCE(NULLIF(lot_size, ''), '0') AS DOUBLE) AS lot,
          CAST(COALESCE(NULLIF(yearbuilt, ''), '0') AS INTEGER) AS yb
        FROM sbf
      )
      SELECT
        ${valueSqlParts.join(',\n        ')},
        ${lotSqlParts.join(',\n        ')},
        SUM(CASE WHEN yb >= 1800 AND yb < 1900 THEN 1 ELSE 0 END) AS y0,
        SUM(CASE WHEN yb >= 1900 AND yb < 1920 THEN 1 ELSE 0 END) AS y1,
        SUM(CASE WHEN yb >= 1920 AND yb < 1940 THEN 1 ELSE 0 END) AS y2,
        SUM(CASE WHEN yb >= 1940 AND yb < 1960 THEN 1 ELSE 0 END) AS y3,
        SUM(CASE WHEN yb >= 1960 AND yb < 1980 THEN 1 ELSE 0 END) AS y4,
        SUM(CASE WHEN yb >= 1980 AND yb < 2000 THEN 1 ELSE 0 END) AS y5,
        SUM(CASE WHEN yb >= 2000 AND yb < 2010 THEN 1 ELSE 0 END) AS y6,
        SUM(CASE WHEN yb >= 2010 AND yb < 2020 THEN 1 ELSE 0 END) AS y7,
        SUM(CASE WHEN yb >= 2020 THEN 1 ELSE 0 END) AS y8
      FROM base
    `)

    const row = rows[0] ?? {}
    const totalValue: DistributionBin[] = valueBins.map(([, , label], i) => ({ label, count: Number((row as any)[`v${i}`] ?? 0) || 0 }))
    const lotSize: DistributionBin[] = lotBins.map(([, , label], i) => ({ label, count: Number((row as any)[`l${i}`] ?? 0) || 0 }))
    const yearBuilt: DistributionBin[] = [
      { label: '<1900', count: Number((row as any).y0 ?? 0) || 0 },
      { label: '1900–1919', count: Number((row as any).y1 ?? 0) || 0 },
      { label: '1920–1939', count: Number((row as any).y2 ?? 0) || 0 },
      { label: '1940–1959', count: Number((row as any).y3 ?? 0) || 0 },
      { label: '1960–1979', count: Number((row as any).y4 ?? 0) || 0 },
      { label: '1980–1999', count: Number((row as any).y5 ?? 0) || 0 },
      { label: '2000–2009', count: Number((row as any).y6 ?? 0) || 0 },
      { label: '2010–2019', count: Number((row as any).y7 ?? 0) || 0 },
      { label: '2020+', count: Number((row as any).y8 ?? 0) || 0 }
    ]

    return { totalValue, lotSize, yearBuilt }
  }

  /**
   * Generate heat map data — aggregated value/count by lat/lng grid
   */
  async getHeatMapData(resolution: number = 2): Promise<HeatMapCell[]> {
    await this.ensureSbfTable()

    const rows = await this.query(`
      SELECT
        ROUND(CAST(COALESCE(NULLIF(latitude, ''), '0') AS DOUBLE), ${resolution}) AS lat_bin,
        ROUND(CAST(COALESCE(NULLIF(longitude, ''), '0') AS DOUBLE), ${resolution}) AS lng_bin,
        SUM(CAST(COALESCE(NULLIF(land_current_value, ''), '0') AS DOUBLE)
          + CAST(COALESCE(NULLIF(imp_current_value, ''), '0') AS DOUBLE)) AS total_val,
        COUNT(*) AS cnt,
        AVG(CAST(COALESCE(NULLIF(land_current_value, ''), '0') AS DOUBLE)
          + CAST(COALESCE(NULLIF(imp_current_value, ''), '0') AS DOUBLE)) AS avg_val
      FROM sbf
      WHERE CAST(COALESCE(NULLIF(latitude, ''), '0') AS DOUBLE) != 0
        AND CAST(COALESCE(NULLIF(longitude, ''), '0') AS DOUBLE) != 0
      GROUP BY lat_bin, lng_bin
      HAVING cnt > 5
      ORDER BY total_val DESC
      LIMIT 5000
    `)

    return rows.map(r => ({
      latBin: Number(r.lat_bin ?? 0),
      lngBin: Number(r.lng_bin ?? 0),
      totalValue: Number(r.total_val ?? 0),
      parcelCount: Number(r.cnt ?? 0),
      avgValue: Number(r.avg_val ?? 0)
    }))
  }

  /**
   * Search for owner names matching a query (type-ahead)
   */
  async searchOwners(query: string, limit: number = 20): Promise<string[]> {
    await this.ensureSbfTable()
    const escaped = query.replace(/'/g, "''")
    const rows = await this.query(`
      SELECT DISTINCT first_owner_name AS name
      FROM sbf
      WHERE first_owner_name ILIKE '%${escaped}%'
        AND first_owner_name IS NOT NULL
        AND TRIM(first_owner_name) != ''
      ORDER BY first_owner_name
      LIMIT ${limit}
    `)
    return rows.map(r => String(r.name ?? ''))
  }

  /**
   * Get dataset statistics for loading screen
   */
  async getStats(): Promise<{ totalRows: number }> {
    await this.ensureSbfTable()
    const rows = await this.query('SELECT COUNT(*) AS cnt FROM sbf')
    return { totalRows: Number(rows[0]?.cnt ?? 0) }
  }
}
