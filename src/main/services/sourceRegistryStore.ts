import type { DataLoadStep, SourceRegistryEntry } from '@shared/types'

export interface SourceRegistryDb {
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

export const SOURCE_REGISTRY_SCHEMA_SQL = [
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
  `CREATE TABLE IF NOT EXISTS source_registry (
    dataset_id VARCHAR PRIMARY KEY,
    dataset_name VARCHAR,
    source_type VARCHAR,
    source_path VARCHAR,
    color VARCHAR,
    byte_size BIGINT,
    row_count BIGINT,
    refresh_state VARCHAR,
    raw_key VARCHAR,
    normalized_key VARCHAR,
    confidence DOUBLE,
    provenance_json VARCHAR,
    updated_at TIMESTAMP
  )`
]

export const SOURCE_REGISTRY_SCHEMA_ALTER_SQL = [
  `ALTER TABLE source_registry ADD COLUMN IF NOT EXISTS source_type VARCHAR`,
  `ALTER TABLE source_registry ADD COLUMN IF NOT EXISTS source_path VARCHAR`,
  `ALTER TABLE source_registry ADD COLUMN IF NOT EXISTS color VARCHAR`,
  `ALTER TABLE source_registry ADD COLUMN IF NOT EXISTS byte_size BIGINT`,
  `ALTER TABLE source_registry ADD COLUMN IF NOT EXISTS row_count BIGINT`,
  `ALTER TABLE source_registry ADD COLUMN IF NOT EXISTS refresh_state VARCHAR`,
  `ALTER TABLE source_registry ADD COLUMN IF NOT EXISTS raw_key VARCHAR`,
  `ALTER TABLE source_registry ADD COLUMN IF NOT EXISTS normalized_key VARCHAR`,
  `ALTER TABLE source_registry ADD COLUMN IF NOT EXISTS confidence DOUBLE`,
  `ALTER TABLE source_registry ADD COLUMN IF NOT EXISTS provenance_json VARCHAR`,
  `ALTER TABLE source_registry ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP`,
  `ALTER TABLE source_blob ADD COLUMN IF NOT EXISTS source_system VARCHAR`,
  `ALTER TABLE source_blob ADD COLUMN IF NOT EXISTS object_key VARCHAR`,
  `ALTER TABLE source_blob ADD COLUMN IF NOT EXISTS mime_type VARCHAR`,
  `ALTER TABLE source_blob ADD COLUMN IF NOT EXISTS payload_base64 VARCHAR`,
  `ALTER TABLE source_blob ADD COLUMN IF NOT EXISTS payload_json VARCHAR`,
  `ALTER TABLE source_blob ADD COLUMN IF NOT EXISTS cached_at TIMESTAMP`
]

export async function recordSourceStep(
  db: SourceRegistryDb,
  step: DataLoadStep & { sourcePath?: string; datasetId?: string }
): Promise<void> {
  const sourceId = step.datasetId ?? step.datasetName
  const provenance = step.provenance ?? {
    datasetId: sourceId,
    datasetName: step.datasetName,
    sourceType: step.sourceType ?? 'canonical_dataset',
    sourcePath: step.sourcePath,
    rawKey: step.rawKey,
    normalizedKey: step.normalizedKey,
    confidence: step.confidence,
    normalizations: []
  }
  await db.exec(`
    INSERT OR REPLACE INTO source_record (
      source_id, dataset_name, source_path, row_count, load_status, color, updated_at, error_msg
    ) VALUES (
      ${sqlString(sourceId)}, ${sqlString(step.datasetName)},
      ${sqlString(step.sourcePath ?? '')}, ${sqlNumber(step.rowCount)}, ${sqlString(step.status)},
      ${sqlString(step.color)}, now(), ${sqlString(step.errorMsg ?? '')}
    )
  `)
  await db.exec(`
    INSERT OR REPLACE INTO source_registry (
      dataset_id, dataset_name, source_type, source_path, color, byte_size, row_count,
      refresh_state, raw_key, normalized_key, confidence, provenance_json, updated_at
    ) VALUES (
      ${sqlString(sourceId)}, ${sqlString(step.datasetName)}, ${sqlString(step.sourceType ?? 'canonical_dataset')},
      ${sqlString(step.sourcePath ?? '')}, ${sqlString(step.color)}, ${sqlNumber(step.byteSize ?? 0)},
      ${sqlNumber(step.rowCount)}, ${sqlString(step.status)}, ${sqlString(step.rawKey ?? '')},
      ${sqlString(step.normalizedKey ?? '')}, ${sqlNumber(step.confidence ?? 0)},
      ${sqlString(json(provenance))}, now()
    )
  `)
  if (step.sourcePath) {
    await db.exec(`
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

export async function getSourceRegistryEntries(db: SourceRegistryDb): Promise<DataLoadStep[]> {
  const rows = await db.query(`
    SELECT *
    FROM source_registry
    ORDER BY CASE refresh_state
      WHEN 'loading' THEN 0
      WHEN 'pending' THEN 1
      WHEN 'ready' THEN 2
      WHEN 'done' THEN 2
      WHEN 'error' THEN 3
      ELSE 4
    END, dataset_name
  `)
  const now = Date.now()
  return rows.map((row) => ({
    datasetName: String(row.dataset_name ?? ''),
    color: String(row.color ?? '#94a3b8'),
    status: String(row.refresh_state ?? 'pending') as DataLoadStep['status'],
    rowCount: Number(row.row_count ?? 0) || 0,
    elapsedMs: now - new Date(String(row.updated_at ?? now)).getTime(),
    byteSize: Number(row.byte_size ?? 0) || 0,
    errorMsg: String(row.refresh_state ?? '') === 'error' ? 'Source unavailable' : undefined,
    sourceType: String(row.source_type ?? 'canonical_dataset') as SourceRegistryEntry['sourceType'],
    rawKey: String(row.raw_key ?? ''),
    normalizedKey: String(row.normalized_key ?? ''),
    confidence: Number(row.confidence ?? 0) || 0,
    provenance: (() => {
      try { return JSON.parse(String(row.provenance_json ?? 'null')) } catch { return undefined }
    })()
  }))
}
