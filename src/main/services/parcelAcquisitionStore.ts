import { createHash } from 'crypto'

export interface ParcelAcquisitionDb {
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

function sqlBool(value: unknown): string {
  return value ? 'true' : 'false'
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null)
}

export const SOURCE_BLOB_SCHEMA_SQL: string[] = []

export const SOURCE_BLOB_SCHEMA_ALTER_SQL = [
  `ALTER TABLE source_blob ADD COLUMN IF NOT EXISTS source_system VARCHAR`,
  `ALTER TABLE source_blob ADD COLUMN IF NOT EXISTS source_url VARCHAR`,
  `ALTER TABLE source_blob ADD COLUMN IF NOT EXISTS object_key VARCHAR`,
  `ALTER TABLE source_blob ADD COLUMN IF NOT EXISTS content_hash VARCHAR`,
  `ALTER TABLE source_blob ADD COLUMN IF NOT EXISTS mime_type VARCHAR`,
  `ALTER TABLE source_blob ADD COLUMN IF NOT EXISTS byte_size DOUBLE`,
  `ALTER TABLE source_blob ADD COLUMN IF NOT EXISTS payload_base64 VARCHAR`,
  `ALTER TABLE source_blob ADD COLUMN IF NOT EXISTS payload_json VARCHAR`,
  `ALTER TABLE source_blob ADD COLUMN IF NOT EXISTS cached_at TIMESTAMP`
]

export interface SourceBlobRecord {
  sourceSystem: string
  sourceUrl: string
  objectKey: string
  contentHash: string
  mimeType: string
  byteSize: number
  payloadBase64: string
  payloadMeta?: Record<string, unknown>
}

export interface SourceBlobStats {
  available: boolean
  blobs: number
  totalBytes: number
  latestAt: string | null
}

export function sourceBlobId(record: Pick<SourceBlobRecord, 'sourceUrl' | 'objectKey' | 'contentHash'>): string {
  return createHash('sha1')
    .update(`${record.sourceUrl}|${record.objectKey}|${record.contentHash}`)
    .digest('hex')
}

export async function recordSourceBlob(db: ParcelAcquisitionDb, record: SourceBlobRecord): Promise<void> {
  await db.exec(`
    INSERT OR REPLACE INTO source_blob (
      blob_id, source_system, source_url, object_key, content_hash, mime_type,
      byte_size, payload_base64, payload_json, fetched_at, provenance_json
    ) VALUES (
      ${sqlString(sourceBlobId(record))}, ${sqlString(record.sourceSystem)}, ${sqlString(record.sourceUrl)},
      ${sqlString(record.objectKey)}, ${sqlString(record.contentHash)}, ${sqlString(record.mimeType)},
      ${sqlNumber(record.byteSize)}, ${sqlString(record.payloadBase64)},
      ${sqlString(json(record.payloadMeta ?? null))}, now(), ${sqlString(json(record.payloadMeta ?? null))}
    )
  `)
}

export async function getSourceBlobStats(db: ParcelAcquisitionDb): Promise<SourceBlobStats> {
  const rows = await db.query(`
    SELECT COUNT(*) AS blobs, COALESCE(SUM(byte_size), 0) AS total_bytes, MAX(COALESCE(cached_at, fetched_at)) AS latest_at
    FROM source_blob
    WHERE source_system = 'parcel_pmtiles'
  `)
  const row = rows[0] ?? {}
  return {
    available: true,
    blobs: Number(row.blobs ?? 0) || 0,
    totalBytes: Number(row.total_bytes ?? 0) || 0,
    latestAt: row.latest_at ? String(row.latest_at) : null
  }
}

export async function getSourceBlobByKey(db: ParcelAcquisitionDb, sourceUrl: string, objectKey: string): Promise<{ payloadBase64: string; mimeType: string; byteSize: number } | null> {
  const rows = await db.query(`
    SELECT payload_base64, mime_type, byte_size
    FROM source_blob
    WHERE source_url = ${sqlString(sourceUrl)} AND object_key = ${sqlString(objectKey)}
    ORDER BY COALESCE(cached_at, fetched_at) DESC
    LIMIT 1
  `)
  if (rows.length === 0) return null
  const row = rows[0]
  return {
    payloadBase64: String(row.payload_base64 ?? ''),
    mimeType: String(row.mime_type ?? ''),
    byteSize: Number(row.byte_size ?? 0) || 0
  }
}
