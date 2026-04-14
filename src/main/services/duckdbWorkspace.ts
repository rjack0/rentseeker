import duckdb, {
  BIGINT,
  BOOLEAN,
  DATE,
  DOUBLE,
  DuckDBConnection,
  DuckDBDataChunk,
  DuckDBInstance,
  VARCHAR
} from '@duckdb/node-api'
import type { DuckDBAppender } from '@duckdb/node-api'
import type { DuckDBValue } from '@duckdb/node-api'
import { existsSync } from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { basename, extname, join, resolve } from 'path'
import { createHash, randomUUID } from 'crypto'
import * as XLSX from 'xlsx'

import type {
  BucketDataResponse,
  BucketKey,
  BucketRow,
  BucketSummary,
  ConnectionGraph,
  DashboardMetric,
  DashboardSnapshot,
  DatasetSummary,
  DossierResponse,
  GraphEdge,
  GraphNode,
  IngestResponse,
  PhoenixRunResponse,
  PhoenixRunSummary,
  QueryFilter,
  QueryRequest,
  QueryResult,
  ValueKind
} from '@shared/types'

interface EntityHandle {
  entityId: string
  entityType: string
  bucketKey: BucketKey
  label: string
}

interface IngestAppenders {
  rawRows: BufferedAppender
  rawCells: BufferedAppender
  entityFacts: BufferedAppender
  stageEntities: BufferedAppender
  stageLinks: BufferedAppender
}

interface BufferedAppender {
  appender: DuckDBAppender
  rows: DuckDBValue[][]
  types: any[]
}

const DATASET_BUCKETS: BucketSummary[] = [
  {
    key: 'overview',
    label: 'Overview',
    description: 'Mission control for the entire local knowledge graph.',
    accent: '#ff8a3d',
    count: 0,
    kind: 'data'
  },
  {
    key: 'uploads',
    label: 'Uploads',
    description: 'Every CSV, XLSX, JSON, and pipeline artifact staged into DuckDB.',
    accent: '#f1d182',
    count: 0,
    kind: 'data'
  },
  {
    key: 'records',
    label: 'Records',
    description: 'Canonical record dossiers ready for fast query composition.',
    accent: '#95d5c9',
    count: 0,
    kind: 'data'
  },
  {
    key: 'parcels',
    label: 'Parcels',
    description: 'AIN/APN, parcel keys, and property-spine records.',
    accent: '#73c2fb',
    count: 0,
    kind: 'data'
  },
  {
    key: 'addresses',
    label: 'Addresses',
    description: 'Normalized situs, mailing, and linked location strings.',
    accent: '#6dd3c7',
    count: 0,
    kind: 'data'
  },
  {
    key: 'people',
    label: 'People',
    description: 'Owners, contractors, clients, and person-like names.',
    accent: '#ff6f91',
    count: 0,
    kind: 'data'
  },
  {
    key: 'phones',
    label: 'Phones',
    description: 'Dialable identity anchors and numeric ranking surfaces.',
    accent: '#f9a03f',
    count: 0,
    kind: 'data'
  },
  {
    key: 'permits',
    label: 'Permits',
    description: 'Permit numbers, valuation, and delivery timing.',
    accent: '#b1f05a',
    count: 0,
    kind: 'data'
  },
  {
    key: 'deeds',
    label: 'Deeds',
    description: 'Recorded instruments and deed-level identity residue.',
    accent: '#c77dff',
    count: 0,
    kind: 'data'
  },
  {
    key: 'zoning',
    label: 'Zoning',
    description: 'Code envelopes, overlay flags, and land-use context.',
    accent: '#7bdff2',
    count: 0,
    kind: 'data'
  },
  {
    key: 'buildability',
    label: 'Buildability',
    description: 'SB 9, SB 79, and related rule-pack facts and verdicts.',
    accent: '#5eead4',
    count: 0,
    kind: 'data'
  },
  {
    key: 'runs',
    label: 'Runs',
    description: 'Every Phoenix run launched from the workbench.',
    accent: '#ffcf5c',
    count: 0,
    kind: 'data'
  },
  {
    key: 'query-lab',
    label: 'Query Lab',
    description: 'Compose cross-bucket filters and rank the resulting dossiers.',
    accent: '#f5f7fa',
    count: 1,
    kind: 'control'
  },
  {
    key: 'phoenix-control',
    label: 'Run Phoenix',
    description: 'Edit YAML, point the pipeline at new data, and launch discovery.',
    accent: '#ff8a3d',
    count: 1,
    kind: 'control'
  }
]

const CONTROL_BUCKETS = new Set<BucketKey>(['query-lab', 'phoenix-control'])

const ENTITY_BUCKET_LABELS: Record<string, BucketKey> = {
  address: 'addresses',
  buildability: 'buildability',
  deed: 'deeds',
  parcel: 'parcels',
  permit: 'permits',
  person: 'people',
  phone: 'phones',
  zoning: 'zoning'
}

export class DuckDBWorkspace {
  private readonly rootPath: string
  private readonly dbPath: string
  private instance?: DuckDBInstance
  private connection?: DuckDBConnection
  private initializationPromise?: Promise<void>

  constructor(rootPath: string) {
    this.rootPath = rootPath
    this.dbPath = resolve(rootPath, 'workspace', 'phoenix-workspace.duckdb')
  }

  async initialize(): Promise<void> {
    if (this.initializationPromise) {
      return this.initializationPromise
    }

    this.initializationPromise = (async () => {
      await mkdir(resolve(this.rootPath, 'workspace'), { recursive: true })
      this.instance = await DuckDBInstance.create(this.dbPath)
      this.connection = await this.instance.connect()
      await this.exec("SET TimeZone = 'UTC'")
      await this.exec('SET threads = 4')
      await this.tryLoadExtensions()
      await this.execMany([
        `create table if not exists datasets (
          dataset_id varchar primary key,
          name varchar not null,
          source_path varchar not null,
          source_format varchar not null,
          row_count bigint not null default 0,
          imported_at timestamp default current_timestamp
        )`,
        `create table if not exists raw_rows (
          dataset_id varchar not null,
          source_row bigint not null,
          payload_json varchar not null,
          primary key(dataset_id, source_row)
        )`,
        `create table if not exists raw_cells (
          dataset_id varchar not null,
          source_row bigint not null,
          column_name varchar not null,
          normalized_column varchar not null,
          value_text varchar,
          value_numeric double,
          value_date date,
          value_boolean boolean,
          value_kind varchar not null
        )`,
        `create table if not exists entities (
          entity_id varchar primary key,
          entity_type varchar not null,
          bucket_key varchar not null,
          label varchar not null,
          normalized_label varchar not null,
          dataset_id varchar,
          source_row bigint,
          created_at timestamp default current_timestamp
        )`,
        `create table if not exists entity_facts (
          entity_id varchar not null,
          fact_key varchar not null,
          fact_value varchar,
          value_kind varchar not null,
          dataset_id varchar,
          source_row bigint,
          confidence double default 1.0
        )`,
        `create table if not exists entity_links (
          link_id varchar primary key,
          source_entity_id varchar not null,
          target_entity_id varchar not null,
          link_type varchar not null,
          strength double default 1.0,
          dataset_id varchar,
          source_row bigint
        )`,
        `create table if not exists phoenix_runs (
          run_id varchar primary key,
          config_path varchar not null,
          status varchar not null,
          entity_count bigint default 0,
          tier_a_count bigint default 0,
          tier_b_count bigint default 0,
          tier_c_count bigint default 0,
          output_paths_json varchar,
          started_at timestamp default current_timestamp,
          finished_at timestamp,
          error_text varchar
        )`,
        `create index if not exists idx_entities_bucket_key on entities(bucket_key)`,
        `create index if not exists idx_entities_normalized_label on entities(normalized_label)`,
        `create index if not exists idx_entity_facts_key on entity_facts(fact_key)`,
        `create index if not exists idx_raw_cells_column on raw_cells(normalized_column)`
      ])
      await this.rebuildViews()
      await this.seedSampleDataIfNeeded()
    })()

    return this.initializationPromise
  }

  async ingestFiles(filePaths: string[]): Promise<IngestResponse> {
    await this.initialize()
    const datasets: DatasetSummary[] = []

    for (const filePath of filePaths) {
      this.debugLog(`loading rows from ${basename(filePath)}`)
      const rows = await this.loadRows(filePath)
      this.debugLog(`loaded ${rows.length} rows from ${basename(filePath)}`)
      if (rows.length === 0) {
        continue
      }
      const dataset = await this.ingestDataset(filePath, rows)
      datasets.push(dataset)
    }

    this.debugLog('rebuilding cached record/entity tables after ingest')
    await this.rebuildViews()
    this.debugLog('cached record/entity tables rebuilt')
    return {
      datasets,
      summary: datasets.length === 0
        ? 'No importable rows found.'
        : `Imported ${datasets.length} dataset${datasets.length === 1 ? '' : 's'} into the workspace.`
    }
  }

  async recordPhoenixRun(result: PhoenixRunResponse): Promise<void> {
    await this.initialize()
    await this.exec(
      `insert into phoenix_runs (
        run_id, config_path, status, entity_count, tier_a_count, tier_b_count, tier_c_count, output_paths_json, finished_at, error_text
      ) values ($runId, $configPath, $status, $entityCount, $tierA, $tierB, $tierC, $outputPaths, current_timestamp, $errorText)`,
      {
        runId: randomUUID(),
        configPath: result.configPath,
        status: result.ok ? 'complete' : 'failed',
        entityCount: result.entityCount,
        tierA: result.tierACount,
        tierB: result.tierBCount,
        tierC: result.tierCCount,
        outputPaths: JSON.stringify(result.outputPaths),
        errorText: result.error ?? null
      }
    )
  }

  async getSnapshot(): Promise<DashboardSnapshot> {
    await this.initialize()
    const buckets = await Promise.all(
      DATASET_BUCKETS.map(async (bucket) => ({
        ...bucket,
        count: CONTROL_BUCKETS.has(bucket.key) ? bucket.count : await this.getBucketCount(bucket.key)
      }))
    )

    const datasets = (await this.query(
      `select dataset_id, name, source_format, source_path, row_count, imported_at
       from datasets
       order by imported_at desc
       limit 8`
    )).map(this.rowToDatasetSummary)

    const runs = (await this.query(
      `select
         run_id,
         config_path,
         status,
         entity_count,
         tier_a_count,
         tier_b_count,
         tier_c_count,
         started_at,
         finished_at
       from phoenix_runs
       order by coalesce(finished_at, started_at) desc
       limit 8`
    )).map((row) => ({
      runId: String(row.run_id),
      configPath: String(row.config_path),
      status: String(row.status),
      entityCount: Number(row.entity_count ?? 0),
      tierACount: Number(row.tier_a_count ?? 0),
      tierBCount: Number(row.tier_b_count ?? 0),
      tierCCount: Number(row.tier_c_count ?? 0),
      startedAt: String(row.started_at),
      finishedAt: row.finished_at ? String(row.finished_at) : null
    }))

    const metrics: DashboardMetric[] = [
      {
        label: 'Canonical Records',
        value: String(await this.getBucketCount('records')),
        helper: 'Records collapsed into a common dossier shape.'
      },
      {
        label: 'Linked Entities',
        value: String(await this.scalar(`select count(*)::bigint as count from entities where entity_type <> 'record'`)),
        helper: 'Names, phones, parcels, addresses, permits, deeds, and zoning nodes.'
      },
      {
        label: 'Connection Edges',
        value: String(await this.scalar('select count(*)::bigint as count from entity_links')),
        helper: 'Cross-bucket identity and co-occurrence links.'
      },
      {
        label: 'DuckDB File',
        value: basename(this.dbPath),
        helper: 'Local analytical store that the dashboard queries directly.'
      }
    ]

    return {
      buckets,
      datasets,
      runs,
      metrics,
      workspacePath: this.dbPath
    }
  }

  async getBucketData(bucket: BucketKey, query: QueryRequest): Promise<BucketDataResponse> {
    await this.initialize()

    if (bucket === 'query-lab' || bucket === 'phoenix-control') {
      return {
        bucket,
        columns: [],
        rows: [],
        total: 0,
        graph: await this.getConnectionGraph(undefined, bucket)
      }
    }

    if (bucket === 'uploads') {
      const rows = await this.query(
        `select
           dataset_id as id,
           name as title,
           source_format as format,
           row_count as rows,
           source_path,
           imported_at
         from datasets
         order by imported_at desc
         limit ${query.limit}
         offset ${query.offset}`
      )
      const bucketRows = rows.map((row) => this.rowToBucketRow('uploads', row, 'id', 'title'))
      return {
        bucket,
        columns: ['format', 'rows', 'source_path', 'imported_at'],
        rows: bucketRows,
        total: Number(await this.scalar('select count(*)::bigint as count from datasets')),
        graph: await this.getConnectionGraph(bucketRows[0]?.id, bucket)
      }
    }

    if (bucket === 'runs') {
      const rows = await this.query(
        `select
           run_id as id,
           config_path as title,
           status,
           entity_count,
           tier_a_count,
           tier_b_count,
           tier_c_count,
           started_at,
           finished_at
         from phoenix_runs
         order by coalesce(finished_at, started_at) desc
         limit ${query.limit}
         offset ${query.offset}`
      )
      const bucketRows = rows.map((row) => this.rowToBucketRow('runs', row, 'id', 'title'))
      return {
        bucket,
        columns: ['status', 'entity_count', 'tier_a_count', 'tier_b_count', 'tier_c_count', 'started_at', 'finished_at'],
        rows: bucketRows,
        total: Number(await this.scalar('select count(*)::bigint as count from phoenix_runs')),
        graph: await this.getConnectionGraph(undefined, bucket)
      }
    }

    const response = bucket === 'records' || bucket === 'overview'
      ? await this.getRecordRows(bucket, query)
      : await this.getEntityBucketRows(bucket, query)

    return {
      ...response,
      graph: await this.getConnectionGraph(response.rows[0]?.id, bucket)
    }
  }

  async runStructuredQuery(query: QueryRequest): Promise<QueryResult> {
    await this.initialize()
    const where = this.composeQueryWhere(query.searchText, query.filters)
    const order = this.composeQueryOrder(query.sorts)
    const sql = `
      select
        record_id as id,
        record_label,
        dataset_name,
        owner_name,
        client_name,
        contractor_name,
        person_name,
        person_role,
        address,
        parcel_id,
        phone,
        permit_number,
        permit_value,
        permit_issue_date,
        certificate_of_occupancy_date,
        permit_duration_days,
        permit_duration_months,
        total_phone_numeric,
        deed_number,
        deed_date,
        zoning_code,
        sb79_applies,
        sb9_applies
      from v_record_dossiers
      ${where}
      ${order}
      limit ${query.limit}
      offset ${query.offset}
    `
    const rows = await this.query(sql)
    const countSql = `
      select count(*)::bigint as count
      from v_record_dossiers
      ${where}
    `

    return {
      sql,
      columns: [
        'record_label',
        'dataset_name',
        'owner_name',
        'client_name',
        'contractor_name',
        'person_name',
        'person_role',
        'address',
        'parcel_id',
        'phone',
        'permit_number',
        'permit_value',
        'permit_issue_date',
        'certificate_of_occupancy_date',
        'permit_duration_days',
        'permit_duration_months',
        'total_phone_numeric',
        'deed_number',
        'deed_date',
        'zoning_code',
        'sb79_applies',
        'sb9_applies'
      ],
      rows: rows.map((row) => this.sanitizeRow(row)),
      total: Number(await this.scalar(countSql)),
      graph: await this.getConnectionGraph(rows[0]?.id ? String(rows[0].id) : undefined, 'query-lab')
    }
  }

  async getDossier(entityId: string): Promise<DossierResponse> {
    await this.initialize()
    const [entity] = await this.query(
      `select entity_id, label, entity_type from entities where entity_id = $entityId`,
      { entityId }
    )
    const facts = await this.query(
      `select fact_key, fact_value, value_kind
       from entity_facts
       where entity_id = $entityId
       order by fact_key`,
      { entityId }
    )
    const linkedEntities = await this.query(
      `select
         e.entity_id,
         e.label,
         e.entity_type,
         l.link_type
       from entity_links l
       join entities e on e.entity_id = case
         when l.source_entity_id = $entityId then l.target_entity_id
         else l.source_entity_id
       end
       where l.source_entity_id = $entityId or l.target_entity_id = $entityId
       limit 24`,
      { entityId }
    )

    return {
      entityId,
      title: entity ? String(entity.label) : entityId,
      entityType: entity ? String(entity.entity_type) : 'unknown',
      facts: facts.map((fact) => ({
        key: String(fact.fact_key),
        value: String(fact.fact_value ?? ''),
        valueKind: (fact.value_kind as ValueKind) ?? 'text'
      })),
      linkedEntities: linkedEntities.map((link) => ({
        entityId: String(link.entity_id),
        label: String(link.label),
        entityType: String(link.entity_type),
        linkType: String(link.link_type)
      }))
    }
  }

  async getConnectionGraph(focusId?: string, bucket?: BucketKey): Promise<ConnectionGraph> {
    await this.initialize()
    if (!focusId) {
      return this.getBucketGraph(bucket)
    }

    const rows = await this.query(
      `select
         e.entity_id,
         e.label,
         e.entity_type,
         e.bucket_key,
         max(case when f.fact_key = 'latitude' then try_cast(f.fact_value as double) end) as latitude,
         max(case when f.fact_key = 'longitude' then try_cast(f.fact_value as double) end) as longitude,
         count(f.fact_key) as fact_count
       from entities e
       left join entity_facts f on f.entity_id = e.entity_id
       where e.entity_id = $focusId
          or e.entity_id in (
            select source_entity_id from entity_links where target_entity_id = $focusId
            union
            select target_entity_id from entity_links where source_entity_id = $focusId
          )
       group by 1, 2, 3, 4
       limit 36`,
      { focusId }
    )
    const edges = await this.query(
      `select
         link_id,
         source_entity_id,
         target_entity_id,
         link_type,
         strength
       from entity_links
       where source_entity_id = $focusId
          or target_entity_id = $focusId
       limit 60`,
      { focusId }
    )

    return {
      title: 'Connected dossier',
      focusId,
      nodes: rows.map((row) => ({
        id: String(row.entity_id),
        label: String(row.label),
        nodeType: String(row.entity_type),
        bucket: (String(row.bucket_key) as BucketKey) ?? 'records',
        weight: Number(row.fact_count ?? 1),
        subtitle: String(row.entity_type),
        lat: row.latitude === null || row.latitude === undefined ? null : Number(row.latitude),
        lng: row.longitude === null || row.longitude === undefined ? null : Number(row.longitude)
      })),
      edges: edges.map((edge) => ({
        id: String(edge.link_id),
        source: String(edge.source_entity_id),
        target: String(edge.target_entity_id),
        label: String(edge.link_type),
        strength: Number(edge.strength ?? 1)
      }))
    }
  }

  getWorkspacePath(): string {
    return this.dbPath
  }

  private async seedSampleDataIfNeeded(): Promise<void> {
    const count = await this.scalar('select count(*)::bigint as count from datasets')
    const samplePath = resolve(this.rootPath, 'data', 'input', 'sample_input.csv')
    if (count === 0 && existsSync(samplePath)) {
      await this.ingestFiles([samplePath])
    }
  }

  private async ingestDataset(filePath: string, rows: Array<Record<string, unknown>>): Promise<DatasetSummary> {
    const datasetId = `dataset:${randomUUID()}`
    const format = extname(filePath).replace('.', '').toLowerCase() || 'unknown'
    const name = basename(filePath)
    const stageEntitiesTable = `stage_entities_${randomUUID().replace(/-/g, '')}`
    const stageLinksTable = `stage_links_${randomUUID().replace(/-/g, '')}`

    await this.exec('begin transaction')
    try {
      await this.exec(
        `insert into datasets (dataset_id, name, source_path, source_format, row_count)
         values ($datasetId, $name, $sourcePath, $sourceFormat, $rowCount)`,
        {
          datasetId,
          name,
          sourcePath: filePath,
          sourceFormat: format,
          rowCount: rows.length
        }
      )

      await this.exec(
        `create temp table ${stageEntitiesTable} (
          entity_id varchar,
          entity_type varchar,
          bucket_key varchar,
          label varchar,
          normalized_label varchar,
          dataset_id varchar,
          source_row bigint
        )`
      )
      await this.exec(
        `create temp table ${stageLinksTable} (
          link_id varchar,
          source_entity_id varchar,
          target_entity_id varchar,
          link_type varchar,
          strength double,
          dataset_id varchar,
          source_row bigint
        )`
      )

      this.debugLog(`ingesting ${name} with ${rows.length} rows`)
      const appenders = await this.createIngestAppenders(stageEntitiesTable, stageLinksTable)
      const seenEntities = new Set<string>()
      const seenLinks = new Set<string>()

      try {
        for (const [index, row] of rows.entries()) {
          this.ingestRowIntoAppenders(
            datasetId,
            index + 1,
            row,
            appenders,
            seenEntities,
            seenLinks
          )
        }
      } finally {
        this.closeIngestAppenders(appenders)
      }
      this.debugLog(`finished appenders for ${name}`)

      await this.exec(
        `insert or ignore into entities (
          entity_id, entity_type, bucket_key, label, normalized_label, dataset_id, source_row
        )
        select entity_id, entity_type, bucket_key, label, normalized_label, dataset_id, source_row
        from ${stageEntitiesTable}`
      )
      await this.exec(
        `insert or ignore into entity_links (
          link_id, source_entity_id, target_entity_id, link_type, strength, dataset_id, source_row
        )
        select link_id, source_entity_id, target_entity_id, link_type, strength, dataset_id, source_row
        from ${stageLinksTable}`
      )

      await this.exec(`drop table ${stageEntitiesTable}`)
      await this.exec(`drop table ${stageLinksTable}`)
      await this.exec('commit')
      this.debugLog(`committed ${name}`)
    } catch (error) {
      await this.exec('rollback')
      throw error
    }

    return {
      datasetId,
      name,
      format,
      rows: rows.length,
      sourcePath: filePath,
      importedAt: new Date().toISOString()
    }
  }

  private ingestRowIntoAppenders(
    datasetId: string,
    sourceRow: number,
    row: Record<string, unknown>,
    appenders: IngestAppenders,
    seenEntities: Set<string>,
    seenLinks: Set<string>
  ): void {
    const recordEntityId = `record:${datasetId}:${sourceRow}`
    const title = this.deriveRecordTitle(row, sourceRow)
    this.appendEntityRow(
      appenders.stageEntities,
      seenEntities,
      {
        entityId: recordEntityId,
        entityType: 'record',
        bucketKey: 'records',
        label: title,
        normalizedLabel: this.normalizeText(title),
        datasetId,
        sourceRow
      }
    )
    this.appendValues(appenders.rawRows, [datasetId, sourceRow, JSON.stringify(row)])

    const typedHandles: EntityHandle[] = []
    const rowFacts = new Map<string, { value: string; kind: ValueKind }>()

    for (const [columnName, rawValue] of Object.entries(row)) {
      const value = this.stringifyCellValue(rawValue)
      if (!value) {
        continue
      }
      const normalizedColumn = this.normalizeColumnName(columnName)
      const valueKind = this.inferValueKind(normalizedColumn, value)
      const numericValue = this.parseNumeric(valueKind, value)
      const dateValue = this.parseDate(value)
      const booleanValue = this.parseBoolean(value)
      this.appendValues(appenders.rawCells, [
        datasetId,
        sourceRow,
        columnName,
        normalizedColumn,
        value,
        numericValue,
        dateValue,
        booleanValue,
        valueKind
      ])

      this.appendFactRow(
        appenders.entityFacts,
        recordEntityId,
        this.factKeyForValueKind(valueKind, normalizedColumn),
        value,
        valueKind,
        datasetId,
        sourceRow
      )
      rowFacts.set(this.factKeyForValueKind(valueKind, normalizedColumn), { value, kind: valueKind })

      if (valueKind === 'phone') {
        const numericPhone = this.numericOnly(value)
        if (numericPhone) {
          this.appendFactRow(
            appenders.entityFacts,
            recordEntityId,
            'phone_numeric',
            numericPhone,
            'currency',
            datasetId,
            sourceRow
          )
          rowFacts.set('phone_numeric', { value: numericPhone, kind: 'currency' })
        }
      }

      const bucketHandle = this.makeTypedEntity(valueKind, value)
      if (!bucketHandle) {
        continue
      }

      typedHandles.push(bucketHandle)
      this.appendEntityRow(
        appenders.stageEntities,
        seenEntities,
        {
          entityId: bucketHandle.entityId,
          entityType: bucketHandle.entityType,
          bucketKey: bucketHandle.bucketKey,
          label: bucketHandle.label,
          normalizedLabel: this.normalizeText(bucketHandle.label),
          datasetId,
          sourceRow
        }
      )
      this.appendFactRow(
        appenders.entityFacts,
        bucketHandle.entityId,
        this.factKeyForValueKind(valueKind, normalizedColumn),
        value,
        valueKind,
        datasetId,
        sourceRow
      )
      this.appendLinkRow(
        appenders.stageLinks,
        seenLinks,
        recordEntityId,
        bucketHandle.entityId,
        'record_contains',
        datasetId,
        sourceRow
      )
    }

    const issueDate = rowFacts.get('permit_issue_date')?.value
    const occupancyDate = rowFacts.get('certificate_of_occupancy_date')?.value
    if (issueDate && occupancyDate) {
      const diff = this.dateDifferenceInDays(issueDate, occupancyDate)
      if (diff !== null) {
        this.appendFactRow(
          appenders.entityFacts,
          recordEntityId,
          'permit_duration_days',
          String(diff),
          'currency',
          datasetId,
          sourceRow
        )
      }
    }

    this.linkTypedEntitiesIntoAppender(typedHandles, datasetId, sourceRow, appenders.stageLinks, seenLinks)
  }

  private linkTypedEntitiesIntoAppender(
    handles: EntityHandle[],
    datasetId: string,
    sourceRow: number,
    appender: BufferedAppender,
    seenLinks: Set<string>
  ): void {
    const byType = new Map<string, EntityHandle[]>()
    for (const handle of handles) {
      const current = byType.get(handle.entityType) ?? []
      current.push(handle)
      byType.set(handle.entityType, current)
    }

    const parcel = byType.get('parcel')?.[0]
    const address = byType.get('address')?.[0]
    const person = byType.get('person')?.[0]
    const phone = byType.get('phone')?.[0]
    const permit = byType.get('permit')?.[0]
    const zoning = byType.get('zoning')?.[0]
    const buildability = byType.get('buildability')?.[0]
    const deed = byType.get('deed')?.[0]

    if (parcel && address) {
      this.appendLinkRow(appender, seenLinks, parcel.entityId, address.entityId, 'located_at', datasetId, sourceRow)
    }
    if (person && address) {
      this.appendLinkRow(appender, seenLinks, person.entityId, address.entityId, 'associated_address', datasetId, sourceRow)
    }
    if (person && phone) {
      this.appendLinkRow(appender, seenLinks, person.entityId, phone.entityId, 'reachable_by', datasetId, sourceRow)
    }
    if (permit && person) {
      this.appendLinkRow(appender, seenLinks, permit.entityId, person.entityId, 'permit_party', datasetId, sourceRow)
    }
    if (permit && parcel) {
      this.appendLinkRow(appender, seenLinks, permit.entityId, parcel.entityId, 'permit_site', datasetId, sourceRow)
    }
    if (deed && parcel) {
      this.appendLinkRow(appender, seenLinks, deed.entityId, parcel.entityId, 'recorded_against', datasetId, sourceRow)
    }
    if (zoning && parcel) {
      this.appendLinkRow(appender, seenLinks, zoning.entityId, parcel.entityId, 'regulates', datasetId, sourceRow)
    }
    if (buildability && parcel) {
      this.appendLinkRow(appender, seenLinks, buildability.entityId, parcel.entityId, 'rule_pack_applies_to', datasetId, sourceRow)
    }
  }

  private async rebuildViews(): Promise<void> {
    this.debugLog('rebuildViews start')
    await this.execMany([
      `drop table if exists v_record_dossiers`,
      `drop view if exists v_record_dossiers`,
      `create table v_record_dossiers as
       select
         e.entity_id as record_id,
         e.label as record_label,
         d.name as dataset_name,
         d.source_format,
         max(case when f.fact_key = 'owner_name' then f.fact_value end) as owner_name,
         max(case when f.fact_key = 'client_name' then f.fact_value end) as client_name,
         max(case when f.fact_key = 'contractor_name' then f.fact_value end) as contractor_name,
         max(case when f.fact_key in ('owner_name', 'client_name', 'contractor_name', 'person_name') then f.fact_value end) as person_name,
         case
           when max(case when f.fact_key = 'client_name' then 1 else 0 end) = 1 then 'client'
           when max(case when f.fact_key = 'owner_name' then 1 else 0 end) = 1 then 'owner'
           when max(case when f.fact_key = 'contractor_name' then 1 else 0 end) = 1 then 'contractor'
           when max(case when f.fact_key = 'person_name' then 1 else 0 end) = 1 then 'person'
           else 'unknown'
         end as person_role,
         max(case when f.fact_key = 'address' then f.fact_value end) as address,
         max(case when f.fact_key in ('parcel_ain', 'parcel_apn') then f.fact_value end) as parcel_id,
         max(case when f.fact_key = 'phone' then f.fact_value end) as phone,
         max(case when f.fact_key = 'phone_numeric' then try_cast(f.fact_value as double) end) as total_phone_numeric,
         max(case when f.fact_key = 'permit_number' then f.fact_value end) as permit_number,
         max(case when f.fact_key = 'permit_value' then try_cast(f.fact_value as double) end) as permit_value,
         max(case when f.fact_key = 'permit_issue_date' then try_cast(f.fact_value as date) end) as permit_issue_date,
         max(case when f.fact_key = 'certificate_of_occupancy_date' then try_cast(f.fact_value as date) end) as certificate_of_occupancy_date,
         max(case when f.fact_key = 'permit_duration_days' then try_cast(f.fact_value as integer) end) as permit_duration_days,
         max(case when f.fact_key = 'deed_number' then f.fact_value end) as deed_number,
         max(case when f.fact_key = 'deed_date' then try_cast(f.fact_value as date) end) as deed_date,
         round(max(case when f.fact_key = 'permit_duration_days' then try_cast(f.fact_value as double) end) / 30.4375, 2) as permit_duration_months,
         max(case when f.fact_key = 'zoning' then f.fact_value end) as zoning_code,
         max(case when f.fact_key = 'sb79_flag' then lower(f.fact_value) end) as sb79_applies,
         max(case when f.fact_key = 'sb9_flag' then lower(f.fact_value) end) as sb9_applies,
         max(case when f.fact_key = 'latitude' then try_cast(f.fact_value as double) end) as latitude,
         max(case when f.fact_key = 'longitude' then try_cast(f.fact_value as double) end) as longitude
       from entities e
       left join entity_facts f on f.entity_id = e.entity_id
       left join datasets d on d.dataset_id = e.dataset_id
       where e.entity_type = 'record'
       group by 1, 2, 3, 4`,
      `create index if not exists idx_v_record_dossiers_person_name on v_record_dossiers(person_name)`,
      `create index if not exists idx_v_record_dossiers_owner_name on v_record_dossiers(owner_name)`,
      `create index if not exists idx_v_record_dossiers_client_name on v_record_dossiers(client_name)`,
      `create index if not exists idx_v_record_dossiers_parcel_id on v_record_dossiers(parcel_id)`,
      `create index if not exists idx_v_record_dossiers_permit_value on v_record_dossiers(permit_value)`,
      `create index if not exists idx_v_record_dossiers_permit_duration_days on v_record_dossiers(permit_duration_days)`,
      `create index if not exists idx_v_record_dossiers_phone_numeric on v_record_dossiers(total_phone_numeric)`,
      `create index if not exists idx_v_record_dossiers_sb79 on v_record_dossiers(sb79_applies)`,
      `drop table if exists v_entity_overview`,
      `drop view if exists v_entity_overview`,
      `create table v_entity_overview as
       with fact_counts as (
         select
           entity_id,
           count(distinct fact_key) as fact_count
         from entity_facts
         group by 1
       ),
       link_counts as (
         select
           entity_id,
           count(*) as link_count
         from (
           select source_entity_id as entity_id from entity_links
           union all
           select target_entity_id as entity_id from entity_links
         )
         group by 1
       )
       select
         e.entity_id,
         e.entity_type,
         e.bucket_key,
         e.label,
         coalesce(fact_counts.fact_count, 0) as fact_count,
         coalesce(link_counts.link_count, 0) as link_count
       from entities e
       left join fact_counts on fact_counts.entity_id = e.entity_id
       left join link_counts on link_counts.entity_id = e.entity_id
       where e.entity_type <> 'record'`,
      `create index if not exists idx_v_entity_overview_bucket_key on v_entity_overview(bucket_key)`,
      `create index if not exists idx_v_entity_overview_label on v_entity_overview(label)`
    ])
    this.debugLog('rebuildViews complete')
  }

  private async getRecordRows(bucket: BucketKey, query: QueryRequest): Promise<Omit<BucketDataResponse, 'graph'>> {
    const where = this.composeQueryWhere(query.searchText, query.filters)
    const sql = `
      select
        record_id as id,
        record_label as title,
        dataset_name,
        owner_name,
        client_name,
        contractor_name,
        person_name,
        person_role,
        address,
        parcel_id,
        phone,
        permit_number,
        permit_value,
        permit_issue_date,
        certificate_of_occupancy_date,
        permit_duration_days,
        permit_duration_months,
        total_phone_numeric,
        deed_number,
        deed_date,
        zoning_code,
        sb79_applies,
        sb9_applies
      from v_record_dossiers
      ${where}
      order by coalesce(permit_value, 0) desc, record_label asc
      limit ${query.limit}
      offset ${query.offset}
    `
    const rows = await this.query(sql)
    return {
      bucket,
      columns: [
        'dataset_name',
        'owner_name',
        'client_name',
        'contractor_name',
        'person_name',
        'person_role',
        'address',
        'parcel_id',
        'phone',
        'permit_number',
        'permit_value',
        'permit_issue_date',
        'certificate_of_occupancy_date',
        'permit_duration_days',
        'permit_duration_months',
        'total_phone_numeric',
        'deed_number',
        'deed_date',
        'zoning_code',
        'sb79_applies',
        'sb9_applies'
      ],
      rows: rows.map((row) => this.rowToBucketRow(bucket, row, 'id', 'title')),
      total: Number(await this.scalar(`select count(*)::bigint as count from v_record_dossiers ${where}`))
    }
  }

  private async getEntityBucketRows(bucket: BucketKey, query: QueryRequest): Promise<Omit<BucketDataResponse, 'graph'>> {
    const filter = query.searchText
      ? `and e.normalized_label like ${this.quoteLiteral(`%${this.normalizeText(query.searchText)}%`)}`
      : ''
    const sql = `
      select
        e.entity_id as id,
        e.label as title,
        e.entity_type,
        e.bucket_key,
        e.dataset_id,
        max(case when f.fact_key = 'address' then f.fact_value end) as address,
        max(case when f.fact_key in ('parcel_ain', 'parcel_apn') then f.fact_value end) as parcel_id,
        max(case when f.fact_key = 'phone' then f.fact_value end) as phone,
        max(case when f.fact_key = 'permit_number' then f.fact_value end) as permit_number,
        max(case when f.fact_key = 'permit_value' then f.fact_value end) as permit_value,
        max(case when f.fact_key = 'zoning' then f.fact_value end) as zoning_code,
        coalesce(max(overview.link_count), 0) as link_count
      from entities e
      left join v_entity_overview overview on overview.entity_id = e.entity_id
      left join entity_facts f on f.entity_id = e.entity_id
      where e.bucket_key = ${this.quoteLiteral(bucket)}
        and e.entity_type <> 'record'
        ${filter}
      group by 1, 2, 3, 4, 5
      order by link_count desc, title asc
      limit ${query.limit}
      offset ${query.offset}
    `
    const rows = await this.query(sql)
    return {
      bucket,
      columns: ['entity_type', 'dataset_id', 'address', 'parcel_id', 'phone', 'permit_number', 'permit_value', 'zoning_code', 'link_count'],
      rows: rows.map((row) => this.rowToBucketRow(bucket, row, 'id', 'title')),
      total: Number(
        await this.scalar(
          `select count(*)::bigint as count
           from entities e
           where e.bucket_key = ${this.quoteLiteral(bucket)}
             and e.entity_type <> 'record'
             ${filter}`
        )
      )
    }
  }

  private async getBucketGraph(bucket?: BucketKey): Promise<ConnectionGraph> {
    const nodes: GraphNode[] = await Promise.all(
      DATASET_BUCKETS.filter((item) => !CONTROL_BUCKETS.has(item.key)).map(async (item) => ({
        id: item.key,
        label: item.label,
        nodeType: 'bucket',
        bucket: item.key,
        weight: await this.getBucketCount(item.key),
        subtitle: item.description
      }))
    )

    const cooccurrenceRows = await this.query(
      `select
         least(source_entity.bucket_key, target_entity.bucket_key) as left_bucket,
         greatest(source_entity.bucket_key, target_entity.bucket_key) as right_bucket,
         count(*)::bigint as edge_count
       from entity_links links
       join entities source_entity on source_entity.entity_id = links.source_entity_id
       join entities target_entity on target_entity.entity_id = links.target_entity_id
       where source_entity.bucket_key <> target_entity.bucket_key
       group by 1, 2
       order by edge_count desc
       limit 24`
    )

    const edges: GraphEdge[] = cooccurrenceRows.map((row) => ({
      id: `${row.left_bucket}:${row.right_bucket}`,
      source: String(row.left_bucket),
      target: String(row.right_bucket),
      label: 'co-occurs',
      strength: Number(row.edge_count ?? 1)
    }))

    return {
      title: bucket ? `${bucket} connection fabric` : 'Bucket connection fabric',
      nodes,
      edges
    }
  }

  private async getBucketCount(bucket: BucketKey): Promise<number> {
    if (bucket === 'uploads') {
      return Number(await this.scalar('select count(*)::bigint as count from datasets'))
    }
    if (bucket === 'records' || bucket === 'overview') {
      return Number(await this.scalar(`select count(*)::bigint as count from entities where entity_type = 'record'`))
    }
    if (bucket === 'runs') {
      return Number(await this.scalar('select count(*)::bigint as count from phoenix_runs'))
    }
    return Number(
      await this.scalar(
        `select count(*)::bigint as count
         from entities
         where bucket_key = ${this.quoteLiteral(bucket)}
           and entity_type <> 'record'`
      )
    )
  }

  private composeQueryWhere(searchText: string, filters: QueryFilter[]): string {
    const clauses: string[] = []
    if (searchText.trim()) {
      const pattern = `%${this.normalizeText(searchText)}%`
      clauses.push(
        `(
          lower(coalesce(record_label, '')) like ${this.quoteLiteral(pattern)}
          or lower(coalesce(person_name, '')) like ${this.quoteLiteral(pattern)}
          or lower(coalesce(owner_name, '')) like ${this.quoteLiteral(pattern)}
          or lower(coalesce(client_name, '')) like ${this.quoteLiteral(pattern)}
          or lower(coalesce(contractor_name, '')) like ${this.quoteLiteral(pattern)}
          or lower(coalesce(person_role, '')) like ${this.quoteLiteral(pattern)}
          or lower(coalesce(address, '')) like ${this.quoteLiteral(pattern)}
          or lower(coalesce(parcel_id, '')) like ${this.quoteLiteral(pattern)}
          or lower(coalesce(phone, '')) like ${this.quoteLiteral(pattern)}
          or lower(coalesce(permit_number, '')) like ${this.quoteLiteral(pattern)}
          or lower(coalesce(deed_number, '')) like ${this.quoteLiteral(pattern)}
          or lower(coalesce(zoning_code, '')) like ${this.quoteLiteral(pattern)}
          or lower(coalesce(dataset_name, '')) like ${this.quoteLiteral(pattern)}
        )`
      )
    }

    for (const filter of filters) {
      const field = this.safeQueryField(filter.field)
      if (!field) {
        continue
      }
      if (filter.operator === 'contains' && filter.value !== undefined) {
        clauses.push(`lower(coalesce(${field}::varchar, '')) like ${this.quoteLiteral(`%${String(filter.value).toLowerCase()}%`)}`)
      } else if (filter.operator === 'eq' && filter.value !== undefined) {
        clauses.push(`${field} = ${this.sqlValue(filter.value)}`)
      } else if (filter.operator === 'gt' && filter.value !== undefined) {
        clauses.push(`${field} > ${this.sqlValue(filter.value)}`)
      } else if (filter.operator === 'gte' && filter.value !== undefined) {
        clauses.push(`${field} >= ${this.sqlValue(filter.value)}`)
      } else if (filter.operator === 'lt' && filter.value !== undefined) {
        clauses.push(`${field} < ${this.sqlValue(filter.value)}`)
      } else if (filter.operator === 'lte' && filter.value !== undefined) {
        clauses.push(`${field} <= ${this.sqlValue(filter.value)}`)
      } else if (filter.operator === 'between' && filter.value !== undefined && filter.valueMax !== undefined) {
        clauses.push(`${field} between ${this.sqlValue(filter.value)} and ${this.sqlValue(filter.valueMax)}`)
      } else if (filter.operator === 'is_true') {
        clauses.push(`lower(coalesce(${field}::varchar, '')) in ('true', 'yes', '1')`)
      } else if (filter.operator === 'is_false') {
        clauses.push(`lower(coalesce(${field}::varchar, '')) in ('false', 'no', '0')`)
      }
    }

    return clauses.length > 0 ? `where ${clauses.join(' and ')}` : ''
  }

  private composeQueryOrder(sorts: QueryRequest['sorts']): string {
    const clauses = sorts
      .map((sort) => {
        const field = this.safeQueryField(sort.field)
        if (!field) {
          return null
        }
        return `${field} ${sort.direction === 'asc' ? 'asc' : 'desc'}`
      })
      .filter((value): value is string => Boolean(value))
    return clauses.length > 0 ? `order by ${clauses.join(', ')}` : 'order by coalesce(permit_value, 0) desc, record_label asc'
  }

  private safeQueryField(field: string): string | null {
    const allowed = new Set([
      'record_label',
      'dataset_name',
      'owner_name',
      'client_name',
      'contractor_name',
      'person_name',
      'person_role',
      'address',
      'parcel_id',
      'phone',
      'permit_number',
      'permit_value',
      'permit_issue_date',
      'certificate_of_occupancy_date',
      'permit_duration_days',
      'permit_duration_months',
      'total_phone_numeric',
      'deed_number',
      'deed_date',
      'zoning_code',
      'sb79_applies',
      'sb9_applies'
    ])
    return allowed.has(field) ? field : null
  }

  private async loadRows(filePath: string): Promise<Array<Record<string, unknown>>> {
    const extension = extname(filePath).toLowerCase()
    if (extension === '.json') {
      const payload = JSON.parse(await readFile(filePath, 'utf8'))
      if (Array.isArray(payload)) {
        return payload
      }
      if (payload && Array.isArray(payload.data)) {
        return payload.data
      }
      return payload ? [payload] : []
    }

    if (extension === '.csv') {
      const reader = await this.connectionOrThrow().runAndReadAll(
        `select * from read_csv_auto($path, header = true, sample_size = -1)`,
        { path: filePath }
      )
      return reader.getRowObjectsJson() as Array<Record<string, unknown>>
    }

    const workbook = XLSX.readFile(filePath, { cellDates: true })
    const firstSheet = workbook.SheetNames[0]
    if (!firstSheet) {
      return []
    }
    return XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[firstSheet], {
      raw: false,
      defval: null
    })
  }

  private stringifyCellValue(value: unknown): string {
    if (value === null || value === undefined) {
      return ''
    }
    if (typeof value === 'string') {
      return value.trim()
    }
    if (value instanceof Date) {
      return value.toISOString().slice(0, 10)
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value)
    }
    return JSON.stringify(value)
  }

  private normalizeColumnName(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  }

  private normalizeText(value: string): string {
    return value.toLowerCase().trim().replace(/\s+/g, ' ')
  }

  private inferValueKind(column: string, value: string): ValueKind {
    const lower = column.toLowerCase()
    if (/(^|_)sb79($|_)/.test(lower)) return 'sb79_flag'
    if (/(^|_)sb9($|_)/.test(lower)) return 'sb9_flag'
    if (lower.includes('ain')) return 'parcel_ain'
    if (lower.includes('apn') || lower.includes('parcel')) return 'parcel_apn'
    if (lower.includes('address') || lower.includes('street') || lower.includes('situs')) return 'address'
    if (lower.includes('phone')) return 'phone'
    if (lower.includes('email') || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'email'
    if ((lower.includes('permit') && lower.includes('value')) || lower.includes('valuation')) return 'permit_value'
    if (lower.includes('permit') && (lower.includes('date') || lower.includes('issued'))) return 'permit_issue_date'
    if (lower.includes('occupancy') || lower.includes('certificate') || lower.includes('final_date')) return 'certificate_of_occupancy_date'
    if (lower.includes('permit')) return 'permit_number'
    if (lower.includes('deed') && lower.includes('date')) return 'deed_date'
    if (lower.includes('deed')) return 'deed_number'
    if (lower.includes('zoning') || lower.includes('zone')) return 'zoning'
    if ((lower.includes('lat') || lower === 'y') && this.isNumeric(value)) return 'latitude'
    if ((lower.includes('lng') || lower.includes('lon') || lower === 'x') && this.isNumeric(value)) return 'longitude'
    if (lower.includes('owner') || lower.includes('client') || lower.includes('contractor') || lower.includes('name')) return 'name'
    if (/^\+?\d[\d\-\(\)\s]{7,}\d$/.test(value)) return 'phone'
    if (this.looksBoolean(value)) return 'boolean'
    if (this.looksDate(value)) return 'date'
    if (this.looksCurrency(value)) return 'currency'
    return 'text'
  }

  private factKeyForValueKind(kind: ValueKind, normalizedColumn: string): string {
    if (kind === 'name') {
      if (normalizedColumn.includes('owner')) return 'owner_name'
      if (normalizedColumn.includes('client')) return 'client_name'
      if (normalizedColumn.includes('contractor')) return 'contractor_name'
      return 'person_name'
    }
    return kind
  }

  private makeTypedEntity(kind: ValueKind, value: string): EntityHandle | null {
    const entityType =
      kind === 'parcel_ain' || kind === 'parcel_apn' ? 'parcel'
        : kind === 'address' ? 'address'
          : kind === 'name' ? 'person'
            : kind === 'phone' ? 'phone'
              : kind === 'permit_number' ? 'permit'
                : kind === 'deed_number' ? 'deed'
                  : kind === 'zoning' ? 'zoning'
                    : kind === 'sb79_flag' || kind === 'sb9_flag' ? 'buildability'
                      : null

    if (!entityType) {
      return null
    }
    const normalizedValue = this.normalizeText(value)
    const entityId = `${entityType}:${createHash('sha1').update(normalizedValue).digest('hex').slice(0, 16)}`
    return {
      entityId,
      entityType,
      bucketKey: ENTITY_BUCKET_LABELS[entityType],
      label: value
    }
  }

  private parseNumeric(kind: ValueKind, value: string): number | null {
    if (kind === 'phone') {
      const normalized = Number(this.numericOnly(value))
      return Number.isFinite(normalized) ? normalized : null
    }
    if (kind === 'currency' || kind === 'permit_value' || kind === 'latitude' || kind === 'longitude') {
      const normalized = Number(value.replace(/[^0-9.\-]/g, ''))
      return Number.isFinite(normalized) ? normalized : null
    }
    return null
  }

  private parseDate(value: string): string | null {
    const trimmed = value.trim()
    if (!trimmed) {
      return null
    }

    const isoMatch = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/)
    if (isoMatch) {
      return this.normalizeDateParts(isoMatch[1], isoMatch[2], isoMatch[3])
    }

    const usMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
    if (usMatch) {
      return this.normalizeDateParts(usMatch[3], usMatch[1], usMatch[2])
    }

    return null
  }

  private parseBoolean(value: string): boolean | null {
    const normalized = value.trim().toLowerCase()
    if (['true', 'yes', '1', 'y'].includes(normalized)) return true
    if (['false', 'no', '0', 'n'].includes(normalized)) return false
    return null
  }

  private dateDifferenceInDays(start: string, end: string): number | null {
    const startDate = new Date(start)
    const endDate = new Date(end)
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      return null
    }
    return Math.max(0, Math.round((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)))
  }

  private deriveRecordTitle(row: Record<string, unknown>, sourceRow: number): string {
    const name = this.firstTruthyField(row, ['name', 'owner', 'client', 'contractor', 'person'])
    const address = this.firstTruthyField(row, ['address', 'street', 'situs'])
    const parcel = this.firstTruthyField(row, ['ain', 'apn', 'parcel'])
    return [name, address, parcel].filter(Boolean).join(' • ') || `Record ${sourceRow}`
  }

  private firstTruthyField(row: Record<string, unknown>, needles: string[]): string | null {
    for (const [key, value] of Object.entries(row)) {
      const normalizedKey = this.normalizeColumnName(key)
      if (needles.some((needle) => normalizedKey.includes(needle))) {
        const stringValue = this.stringifyCellValue(value)
        if (stringValue) {
          return stringValue
        }
      }
    }
    return null
  }

  private looksCurrency(value: string): boolean {
    return /[$,]/.test(value) || /^\d+(\.\d+)?$/.test(value)
  }

  private looksDate(value: string): boolean {
    return this.parseDate(value) !== null
  }

  private looksBoolean(value: string): boolean {
    return ['true', 'false', 'yes', 'no', '1', '0', 'y', 'n'].includes(value.trim().toLowerCase())
  }

  private isNumeric(value: string): boolean {
    return Number.isFinite(Number(value))
  }

  private numericOnly(value: string): string {
    return value.replace(/\D+/g, '')
  }

  private normalizeDateParts(year: string, month: string, day: string): string | null {
    const parsedYear = Number(year)
    const parsedMonth = Number(month)
    const parsedDay = Number(day)
    if (
      !Number.isInteger(parsedYear)
      || !Number.isInteger(parsedMonth)
      || !Number.isInteger(parsedDay)
      || parsedYear < 1800
      || parsedYear > 2100
      || parsedMonth < 1
      || parsedMonth > 12
      || parsedDay < 1
      || parsedDay > 31
    ) {
      return null
    }

    const candidate = new Date(Date.UTC(parsedYear, parsedMonth - 1, parsedDay))
    if (
      candidate.getUTCFullYear() !== parsedYear
      || candidate.getUTCMonth() !== parsedMonth - 1
      || candidate.getUTCDate() !== parsedDay
    ) {
      return null
    }

    return `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  }

  private async createIngestAppenders(
    stageEntitiesTable: string,
    stageLinksTable: string
  ): Promise<IngestAppenders> {
    const connection = this.connectionOrThrow()
    return {
      rawRows: {
        appender: await connection.createAppender('raw_rows'),
        rows: [],
        types: [VARCHAR, BIGINT, VARCHAR]
      },
      rawCells: {
        appender: await connection.createAppender('raw_cells'),
        rows: [],
        types: [VARCHAR, BIGINT, VARCHAR, VARCHAR, VARCHAR, DOUBLE, DATE, BOOLEAN, VARCHAR]
      },
      entityFacts: {
        appender: await connection.createAppender('entity_facts'),
        rows: [],
        types: [VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, BIGINT, DOUBLE]
      },
      stageEntities: {
        appender: await connection.createAppender(stageEntitiesTable),
        rows: [],
        types: [VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, BIGINT]
      },
      stageLinks: {
        appender: await connection.createAppender(stageLinksTable),
        rows: [],
        types: [VARCHAR, VARCHAR, VARCHAR, VARCHAR, DOUBLE, VARCHAR, BIGINT]
      }
    }
  }

  private closeIngestAppenders(appenders: IngestAppenders): void {
    this.flushBufferedAppender(appenders.rawRows)
    this.flushBufferedAppender(appenders.rawCells)
    this.flushBufferedAppender(appenders.entityFacts)
    this.flushBufferedAppender(appenders.stageEntities)
    this.flushBufferedAppender(appenders.stageLinks)
    appenders.rawRows.appender.closeSync()
    appenders.rawCells.appender.closeSync()
    appenders.entityFacts.appender.closeSync()
    appenders.stageEntities.appender.closeSync()
    appenders.stageLinks.appender.closeSync()
  }

  private appendValues(appender: BufferedAppender, values: DuckDBValue[]): void {
    appender.rows.push(values)
    if (appender.rows.length >= 2048) {
      this.flushBufferedAppender(appender)
    }
  }

  private flushBufferedAppender(appender: BufferedAppender): void {
    if (appender.rows.length === 0) {
      return
    }
    const chunk = DuckDBDataChunk.create(appender.types)
    chunk.setRows(appender.rows.map((row) => this.normalizeBufferedRow(row, appender.types)))
    appender.appender.appendDataChunk(chunk)
    appender.rows = []
  }

  private normalizeBufferedRow(row: DuckDBValue[], types: any[]): DuckDBValue[] {
    return row.map((value, index) => {
      if (value === null || value === undefined) {
        return null
      }
      if (types[index] === BIGINT && typeof value === 'number') {
        return BigInt(Math.trunc(value))
      }
      return value
    })
  }

  private appendEntityRow(
    appender: BufferedAppender,
    seenEntities: Set<string>,
    entity: {
      entityId: string
      entityType: string
      bucketKey: string
      label: string
      normalizedLabel: string
      datasetId: string
      sourceRow: number
    }
  ): void {
    if (seenEntities.has(entity.entityId)) {
      return
    }
    seenEntities.add(entity.entityId)
    this.appendValues(appender, [
      entity.entityId,
      entity.entityType,
      entity.bucketKey,
      entity.label,
      entity.normalizedLabel,
      entity.datasetId,
      entity.sourceRow
    ])
  }

  private appendFactRow(
    appender: BufferedAppender,
    entityId: string,
    key: string,
    value: string,
    kind: ValueKind,
    datasetId: string,
    sourceRow: number
  ): void {
    this.appendValues(appender, [entityId, key, value, kind, datasetId, sourceRow, 1.0])
  }

  private appendLinkRow(
    appender: BufferedAppender,
    seenLinks: Set<string>,
    sourceEntityId: string,
    targetEntityId: string,
    linkType: string,
    datasetId: string,
    sourceRow: number
  ): void {
    const sorted = [sourceEntityId, targetEntityId].sort()
    const linkId = `${linkType}:${createHash('sha1').update(sorted.join('|')).digest('hex').slice(0, 16)}`
    if (seenLinks.has(linkId)) {
      return
    }
    seenLinks.add(linkId)
    this.appendValues(appender, [linkId, sourceEntityId, targetEntityId, linkType, 1.0, datasetId, sourceRow])
  }

  private rowToBucketRow(bucket: BucketKey, row: Record<string, unknown>, idKey: string, titleKey: string): BucketRow {
    return {
      id: String(row[idKey]),
      bucket,
      title: String(row[titleKey]),
      subtitle: row.dataset_name ? String(row.dataset_name) : row.entity_type ? String(row.entity_type) : undefined,
      values: Object.fromEntries(
        Object.entries(this.sanitizeRow(row)).filter(([key]) => key !== idKey && key !== titleKey)
      )
    }
  }

  private rowToDatasetSummary = (row: Record<string, unknown>): DatasetSummary => ({
    datasetId: String(row.dataset_id),
    name: String(row.name),
    format: String(row.source_format),
    rows: Number(row.row_count ?? 0),
    sourcePath: String(row.source_path),
    importedAt: String(row.imported_at)
  })

  private sanitizeRow(row: Record<string, unknown>): Record<string, string | number | boolean | null> {
    return Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        value === undefined ? null
          : value === null ? null
            : typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
              ? value
              : JSON.stringify(value)
      ])
    )
  }

  private async tryLoadExtensions(): Promise<void> {
    const statements = [
      'install spatial',
      'load spatial',
      'install fts',
      'load fts'
    ]
    for (const statement of statements) {
      try {
        await this.exec(statement)
      } catch {
        // Optional extensions are best-effort because the app must still work offline.
      }
    }
  }

  private connectionOrThrow(): DuckDBConnection {
    if (!this.connection) {
      throw new Error('DuckDB workspace has not been initialized.')
    }
    return this.connection
  }

  private async exec(sql: string, values?: Record<string, DuckDBValue>): Promise<void> {
    await this.connectionOrThrow().run(sql, values)
  }

  private async execMany(statements: string[]): Promise<void> {
    for (const statement of statements) {
      await this.exec(statement)
    }
  }

  private async query(sql: string, values?: Record<string, DuckDBValue>): Promise<Array<Record<string, unknown>>> {
    const reader = await this.connectionOrThrow().runAndReadAll(sql, values)
    return reader.getRowObjectsJson() as Array<Record<string, unknown>>
  }

  private async scalar(sql: string): Promise<number> {
    const [row] = await this.query(sql)
    return Number(row?.count ?? 0)
  }

  private quoteLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`
  }

  private sqlValue(value: string | number | boolean): string {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? String(value) : 'null'
    }
    if (typeof value === 'boolean') {
      return value ? 'true' : 'false'
    }
    return this.quoteLiteral(String(value))
  }

  private debugLog(message: string): void {
    if (process.env.DGF_STRESS_LOG === '1') {
      console.info(`[workspace] ${message}`)
    }
  }
}

export function getDuckDBVersion(): string {
  return duckdb.version()
}
