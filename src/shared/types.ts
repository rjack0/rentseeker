export type BucketKey =
  | 'overview'
  | 'uploads'
  | 'records'
  | 'parcels'
  | 'addresses'
  | 'people'
  | 'phones'
  | 'permits'
  | 'deeds'
  | 'zoning'
  | 'buildability'
  | 'runs'
  | 'query-lab'
  | 'phoenix-control'

export type BucketKind = 'data' | 'control'

export type ValueKind =
  | 'text'
  | 'currency'
  | 'date'
  | 'boolean'
  | 'name'
  | 'address'
  | 'phone'
  | 'email'
  | 'parcel_ain'
  | 'parcel_apn'
  | 'permit_number'
  | 'permit_value'
  | 'permit_issue_date'
  | 'certificate_of_occupancy_date'
  | 'deed_number'
  | 'deed_date'
  | 'zoning'
  | 'sb79_flag'
  | 'sb9_flag'
  | 'latitude'
  | 'longitude'

export interface BucketSummary {
  key: BucketKey
  label: string
  description: string
  accent: string
  count: number
  kind: BucketKind
}

export interface DatasetSummary {
  datasetId: string
  name: string
  format: string
  rows: number
  sourcePath: string
  importedAt: string
}

export interface PhoenixRunSummary {
  runId: string
  configPath: string
  status: string
  entityCount: number
  tierACount: number
  tierBCount: number
  tierCCount: number
  startedAt: string
  finishedAt?: string | null
}

export interface DashboardMetric {
  label: string
  value: string
  helper: string
}

export interface DashboardSnapshot {
  buckets: BucketSummary[]
  datasets: DatasetSummary[]
  runs: PhoenixRunSummary[]
  metrics: DashboardMetric[]
  workspacePath: string
}

export interface GraphNode {
  id: string
  label: string
  nodeType: string
  bucket: BucketKey | 'system'
  weight: number
  subtitle?: string
  lat?: number | null
  lng?: number | null
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  label: string
  strength: number
}

export interface ConnectionGraph {
  title: string
  focusId?: string
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface BucketRow {
  id: string
  bucket: BucketKey
  title: string
  subtitle?: string
  values: Record<string, string | number | boolean | null>
}

export interface BucketDataResponse {
  bucket: BucketKey
  columns: string[]
  rows: BucketRow[]
  total: number
  graph: ConnectionGraph
}

export interface QueryFilter {
  field: string
  operator: 'contains' | 'eq' | 'gt' | 'gte' | 'lt' | 'lte' | 'between' | 'is_true' | 'is_false'
  value?: string | number | boolean
  valueMax?: string | number
}

export interface QuerySort {
  field: string
  direction: 'asc' | 'desc'
}

export interface QueryRequest {
  searchText: string
  limit: number
  offset: number
  filters: QueryFilter[]
  sorts: QuerySort[]
}

export interface QueryResult {
  sql: string
  columns: string[]
  rows: Array<Record<string, string | number | boolean | null>>
  total: number
  graph: ConnectionGraph
}

export interface DossierItem {
  key: string
  value: string
  valueKind: ValueKind
}

export interface DossierResponse {
  entityId: string
  title: string
  entityType: string
  facts: DossierItem[]
  linkedEntities: Array<{ entityId: string; label: string; entityType: string; linkType: string }>
}

export interface IngestRequest {
  filePaths: string[]
}

export interface IngestResponse {
  datasets: DatasetSummary[]
  summary: string
}

export interface PhoenixRunRequest {
  configPath?: string
  configText: string
}

export interface PhoenixRunResponse {
  ok: boolean
  configPath: string
  entityCount: number
  tierACount: number
  tierBCount: number
  tierCCount: number
  outputPaths: string[]
  error?: string
}

/* ---------- Parcel Explorer types ---------- */

export interface ParcelRecord {
  assessorId: string
  ain: string
  rollYear: number
  zipCode: string
  cityTaxRateArea: string
  taxRateAreaCode: string
  propertyLocation: string
  propertyUseType: string
  propertyUseCode: string
  useCode1: string
  useCode2: string
  useCode3: string
  useCode4: string
  numberOfBuildings: number
  yearBuilt: number
  effectiveYear: number
  squareFootage: number
  numberOfBedrooms: number
  numberOfBathrooms: number
  numberOfUnits: number
  recordingDate: string
  landValue: number
  landBaseYear: number
  improvementValue: number
  improvementBaseYear: number
  totalValueLandImprovement: number
  homeOwnersExemption: number
  realEstateExemption: number
  fixtureValue: number
  fixtureExemption: number
  personalPropertyValue: number
  personalPropertyExemption: number
  propertyTaxable: string
  totalValue: number
  totalExemption: number
  taxableValue: number
  classification: string
  regionNumber: string
  clusterCode: string
  parcelLegalDescription: string
  addressHouseNumber: string
  addressHouseNumberFraction: string
  direction: string
  street: string
  unitNumber: string
  city: string
  zipCodeFull: string
  rowId: string
  latitude: number | null
  longitude: number | null
  objectId: string
}

export interface ParcelQueryResult {
  targetParcels: ParcelRecord[]
  surroundingParcels: ParcelRecord[]
  allParcels: ParcelRecord[]
  totalFound: number
  queryTimeMs: number
  csvPath: string
}

export interface DashboardApi {
  pickImportFiles: () => Promise<string[]>
  ingestFiles: (request: IngestRequest) => Promise<IngestResponse>
  getSnapshot: () => Promise<DashboardSnapshot>
  getBucketData: (bucket: BucketKey, query: QueryRequest) => Promise<BucketDataResponse>
  runQuery: (query: QueryRequest) => Promise<QueryResult>
  getDossier: (entityId: string) => Promise<DossierResponse>
  getConnectionGraph: (focusId?: string, bucket?: BucketKey) => Promise<ConnectionGraph>
  runPhoenix: (request: PhoenixRunRequest) => Promise<PhoenixRunResponse>
  loadConfigFile: () => Promise<{ path?: string; text?: string }>
  queryParcelCsv: (csvPath: string, targetParcel: string, maxSurrounding?: number) => Promise<ParcelQueryResult>
}
