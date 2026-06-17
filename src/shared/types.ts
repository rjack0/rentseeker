import type { Geometry } from 'geojson'
import type { SourceProvenance, SourceType } from './sourceRegistry'

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

export interface SourceRegistryEntry {
  datasetId: string
  datasetName: string
  sourceType: SourceType
  sourcePath?: string
  color: string
  byteSize: number
  rowCount: number
  refreshState: 'pending' | 'loading' | 'ready' | 'error'
  rawKey?: string
  normalizedKey?: string
  confidence?: number
  provenance?: SourceProvenance
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

export interface ImportDataPathsRequest {
  paths: string[]
}

export interface ImportedDataFolder {
  folderPath: string
  label: string
  color: string
  fileCount: number
  byteSize: number
  rowCount: number
  importedAt: string
}

export interface ImportDataPathsResponse {
  ok: boolean
  summary: string
  datasets: DatasetSummary[]
  folders: ImportedDataFolder[]
  skippedPaths?: string[]
  error?: string
}

export interface PropstreamGridRecord {
  address: string
  value: string
  valueAmount: number
  valueLabel: string
  beds: number | ''
  baths: number | ''
  sqft: number | ''
  lotSqft: number | ''
  estEquity: string
  estEquityAmount: number
  estLoanBalance: string
  estLoanBalanceAmount: number
  lastSale: string
  lastSaleTimestamp: number | ''
  imagePath: string
  imageUrl?: string
  imageCount: number
  propstreamUrl: string
  propertyId: string
  searchLists: string[]
  sourceFiles: string[]
  sourceIndexes: string[]
  characteristics: string
}

export interface PropstreamGridDataset {
  name: string
  color: string
  count: number
}

export interface PropstreamGridSourceStat {
  file: string
  cards: number
}

export interface PropstreamGridPayload {
  sourcePath: string
  totalCards: number
  uniqueProperties: number
  datasets: PropstreamGridDataset[]
  sourceStats: PropstreamGridSourceStat[]
  records: PropstreamGridRecord[]
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

export type DataSource =
  | 'parcel'
  | 'cofo'
  | 'both'
  | 'sbf'
  | 'building_permit'
  | 'building_permit_submitted'
  | 'electrical_permit'
  | 'inspection'
  | 'parcel_polygon'

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
  /* Certificate of Occupancy cross-reference fields */
  dataSource: DataSource
  cofoNumber?: string
  cofoIssueDate?: string
  cofoStatus?: string
  permitType?: string
  permitSubType?: string
  workDescription?: string
  cofoValuation?: string
  cofoZone?: string
  numberOfStories?: string
  contractorName?: string
  dataSources?: DataSource[]
  buildingPermitCount?: number
  buildingPermitValuation?: number
  latestBuildingPermit?: string
  latestBuildingPermitStatus?: string
  latestBuildingPermitDescription?: string
  electricalPermitCount?: number
  latestElectricalPermit?: string
  latestElectricalPermitStatus?: string
  latestElectricalPermitDescription?: string
  submittedBuildingPermitCount?: number
  latestSubmittedBuildingPermit?: string
  latestSubmittedBuildingPermitStatus?: string
  latestSubmittedBuildingPermitDescription?: string
  inspectionCount?: number
  latestInspection?: string
  latestInspectionStatus?: string
  latestInspectionDescription?: string
  sb79Eligible?: boolean
  sb79Tier?: string
  sb79DistanceToStopFt?: number
  sqftCheckStatus?: string
  geometricSqft?: number
  neighborMedianSqft?: number
}

export interface ParcelQueryResult {
  targetParcels: ParcelRecord[]
  surroundingParcels: ParcelRecord[]
  allParcels: ParcelRecord[]
  totalFound: number
  returnedCount?: number
  queryTimeMs: number
  csvPath: string
}

export interface MapBounds {
  north: number
  south: number
  east: number
  west: number
}

export interface ParcelFilterQuery {
  /** Free text search across address, legal desc, etc. */
  searchText?: string
  /** First 4 digits of APN (book number) */
  apnPrefix?: string
  /** Explicit target APNs (comma-separated) */
  targetParcels?: string
  /** Min total value */
  valueMin?: number
  /** Max total value */
  valueMax?: number
  /** Filter to parcels with C-of-O issued */
  hasCofO?: boolean
  /** Built/unbuilt mode */
  builtState?: 'all' | 'built' | 'unbuilt'
  /** Property use type filter */
  useType?: string
  /** Year built range */
  yearBuiltMin?: number
  yearBuiltMax?: number
  /** Effective year range */
  effectiveYearMin?: number
  effectiveYearMax?: number
  /** Assessment roll year range */
  rollYearMin?: number
  rollYearMax?: number
  /** Building square footage range */
  sqftMin?: number
  sqftMax?: number
  /** Bedroom count range */
  bedMin?: number
  bedMax?: number
  /** Bathroom count range */
  bathMin?: number
  bathMax?: number
  /** Unit count range */
  unitMin?: number
  unitMax?: number
  /** Building count range */
  buildingCountMin?: number
  buildingCountMax?: number
  /** Permit/inspection count ranges */
  buildingPermitCountMin?: number
  buildingPermitCountMax?: number
  electricalPermitCountMin?: number
  electricalPermitCountMax?: number
  submittedPermitCountMin?: number
  submittedPermitCountMax?: number
  inspectionCountMin?: number
  inspectionCountMax?: number
  /** Stories / form */
  storiesMin?: number
  storiesMax?: number
  propertyTaxable?: string
  classification?: string
  regionNumber?: string
  clusterCode?: string
  /** Base year ranges */
  landBaseYearMin?: number
  landBaseYearMax?: number
  improvementBaseYearMin?: number
  improvementBaseYearMax?: number
  /** Assessed value component ranges */
  landValueMin?: number
  landValueMax?: number
  improvementValueMin?: number
  improvementValueMax?: number
  taxableValueMin?: number
  taxableValueMax?: number
  homeOwnersExemptionMin?: number
  homeOwnersExemptionMax?: number
  realEstateExemptionMin?: number
  realEstateExemptionMax?: number
  fixtureValueMin?: number
  fixtureValueMax?: number
  fixtureExemptionMin?: number
  fixtureExemptionMax?: number
  personalPropertyValueMin?: number
  personalPropertyValueMax?: number
  personalPropertyExemptionMin?: number
  personalPropertyExemptionMax?: number
  totalExemptionMin?: number
  totalExemptionMax?: number
  /** Viewport bounds for map-based loading */
  bounds?: MapBounds
  /** Sort column */
  sortField?: string
  /** Sort direction */
  sortDir?: 'asc' | 'desc'
  /** Max rows to return */
  limit?: number
  /** Use a random visible sample instead of the first rows in CSV order */
  randomSample?: boolean
  /** Include C-of-O dataset */
  includeCofO?: boolean
  includeBuildingPermits?: boolean
  includeElectricalPermits?: boolean
  includeSubmittedPermits?: boolean
  includeInspections?: boolean
}

/* ---------- Terrain Engine types ---------- */

export interface TerrainMetrics {
  parcelId: string
  demMinZ: number
  demMaxZ: number
  demMeanZ: number
  demRelief: number
  bestFitSlopePct: number
  bestFitSlopeDeg: number
  maxLocalSlopePct: number
  aspectDeg: number
  padCandidateCount: number
  largestPadAreaSqft: number
  drivewayGradeBestPct: number
  retainingWallCandidateLengthFt: number
  terrainConfidence: number
}

export interface TerrainMetricsResponse {
  computed: boolean
  cached?: boolean
  reason?: string
  metrics: TerrainMetrics | null
}

export interface ElevationSample {
  lng: number
  lat: number
  z: number
}

export interface SlopeResult {
  slopePct: number
  slopeDeg: number
  aspectDeg: number
  highestZ: number
  lowestZ: number
  samples: ElevationSample[]
}

/* ---------- Sun Simulator types ---------- */

export interface SunPosition {
  azimuthDeg: number
  altitudeDeg: number
  hour: number
  minute: number
}

export interface SunAnalysis {
  parcelId: string
  date: string
  latitude: number
  longitude: number
  sunPath: SunPosition[]
  sunriseHour: number
  sunsetHour: number
  totalDaylightHours: number
  directSunlightHours: number
  /** Per-hour shadow obstruction: 0 = fully exposed, 1 = fully shaded */
  hourlyObstruction: { hour: number; obstructionPct: number }[]
  /** Terrain features blocking sun (ridges, buildings) */
  obstructors: { azimuthDeg: number; elevationDeg: number; description: string }[]
}

export interface SunAnalysisResponse {
  computed: boolean
  cached?: boolean
  reason?: string
  analysis: SunAnalysis | null
}

/* ---------- View Analysis types ---------- */

export interface Landmark {
  name: string
  lat: number
  lng: number
  elevationFt: number
  category: 'skyline' | 'monument' | 'nature' | 'ocean'
}

export interface ViewRay {
  azimuthDeg: number
  maxDistanceMi: number
  obstructedAtMi: number | null
  terrainBlockHeight: number | null
}

export interface ViewAnalysis {
  parcelId: string
  viewerHeightFt: number
  stories: number
  totalRays: number
  /** Visible landmarks */
  visibleLandmarks: { landmark: Landmark; distanceMi: number; bearingDeg: number }[]
  /** Blocked landmarks */
  blockedLandmarks: { landmark: Landmark; blockedByDescription: string }[]
  /** 360° viewshed: for each degree, how far can you see */
  viewshed: ViewRay[]
  /** Overall view score 0-100 */
  viewScore: number
  /** Max unobstructed view distance in miles */
  maxViewDistanceMi: number
}

export interface ViewAnalysisResponse {
  computed: boolean
  cached?: boolean
  reason?: string
  analysis: ViewAnalysis | null
}

export interface ParcelAnalysisBundleRequest {
  parcelId: string
  lat: number
  lng: number
  lotSqft?: number
  date: string
  stories: number
  geometry?: Geometry | null
  parcel?: ParcelRecord | null
}

export interface ParcelAnalysisBundleResponse {
  parcelId: string
  geometryHash: string
  terrain: TerrainMetricsResponse
  sun: SunAnalysisResponse
  view: ViewAnalysisResponse
  buildRuns: BuildRunOutput[]
  terrainProduct?: unknown | null
  provenance?: ParcelDossierProvenance | null
}

/* ---------- Build Simulator types ---------- */

export interface BuildTemplate {
  id: string
  name: string
  footprintSqft: number
  stories: number
  heightFt: number
  useCodes: string[]
}

export interface BuildRunInput {
  parcelId: string
  templateId: string
  stories: number
  parcelGeometry?: Geometry | null
  /** Zoning constraints */
  frontSetbackFt?: number
  sideSetbackFt?: number
  rearSetbackFt?: number
  maxHeightFt?: number
  maxFar?: number
}

export interface BuildRunOutput {
  runId: string
  parcelId: string
  templateId: string
  stories: number
  createdAt: string
  footprintSqft: number
  buildingHeightFt: number
  floorAreaSqft: number
  estimatedUnits: number
  estimatedCutCy: number
  estimatedFillCy: number
  estimatedRetainingWallFt: number
  estimatedAvgRetainingHeightFt: number
  estimatedDrivewayGradePct: number
  estimatedFlatPadSqft: number
  fitScore: number
  constraintFlags: string[]
  /** Placement coordinates for 3D rendering */
  placementLng: number
  placementLat: number
  placementZ: number
  placementPitchDeg: number
  placementRollDeg: number
  foundationSkirt: {
    baseElevationFt: number
    uphillHeightFt: number
    downhillHeightFt: number
    vertices: Array<[number, number, number]>
  }
}

/* ═══════════════ OWNER INTELLIGENCE (SBF) ═══════════════ */

export interface OwnerRecord {
  ain: string
  ownerName: string
  situsAddress: string
  situsCity: string
  situsZip: string
  mailAddress: string
  mailCity: string
  mailZip: string
  landValue: number
  impValue: number
  totalValue: number
  saleAmount: number
  saleDate: string
  lastSale2Amount: number
  lastSale2Date: string
  lastSale3Amount: number
  lastSale3Date: string
  zoningCode: string
  useCode: string
  yearBuilt: string
  sqftMain: number
  lotSize: number
  acres: number
  units: number
  bedrooms: number
  bathrooms: number
  latitude: number
  longitude: number
  recordingDate: string
  documentType: string
  hazardCode: string
  designType: string
  qualityClass: string
}

export interface OwnerPortfolio {
  ownerName: string
  parcels: OwnerRecord[]
  totalParcels: number
  totalValue: number
  totalAcres: number
  totalSqft: number
  avgLotSize: number
  cities: string[]
  zoningCodes: string[]
}

export interface TopOwnerEntry {
  ownerName: string
  parcelCount: number
  totalValue: number
  totalAcres: number
  totalSqft: number
  avgValue: number
}

export interface HeatMapCell {
  latBin: number
  lngBin: number
  totalValue: number
  parcelCount: number
  avgValue: number
}

export interface ParcelPolygon {
  ain: string
  apn: string
  address: string
  useCode: string
  useType: string
  geometry: Geometry
  centerLat: number
  centerLon: number
}

export interface ParcelBoundaryTile {
  id: string
  bounds: MapBounds
  zoom: number
  count: number
  complete: boolean
  simplified: boolean
  polygons: ParcelPolygon[]
}

export interface ParcelBoundaryTileResponse {
  tiles: ParcelBoundaryTile[]
  polygons: ParcelPolygon[]
  visibleBoundaryCount: number
  renderedBoundaryCount: number
  complete: boolean
  queryTimeMs: number
}

export type ParcelSelectionMode = 'replace' | 'add' | 'subtract'

export interface DataLoadStep {
  datasetName: string
  color: string
  status: 'pending' | 'loading' | 'done' | 'error'
  rowCount: number
  elapsedMs: number
  byteSize?: number
  errorMsg?: string
  sourceType?: SourceType
  rawKey?: string
  normalizedKey?: string
  confidence?: number
  provenance?: SourceProvenance
}

export interface DataLoadProgress {
  steps: DataLoadStep[]
  totalRows: number
  overallPct: number
}

export interface ParcelFactProvenance {
  factLabel: string
  datasetId: string
  datasetName: string
  sourceType: SourceType
  sourcePath?: string
  sourceFields: string[]
  rawKey: string
  normalizedKey: string
  matchKey: string
  normalizations: string[]
  confidence: 'High' | 'Medium-High' | 'Medium' | 'Low'
  notes?: string
}

export interface ParcelDossierProvenance {
  parcelId: string
  owner?: ParcelFactProvenance | null
  facts: Record<string, ParcelFactProvenance>
}

export interface ParcelFactSourceManifestEntry {
  factLabel: string
  aliases: string[]
  datasetCandidates: string[]
  sourceFields: string[]
  normalizations: string[]
  sourceType: SourceType
  confidence: ParcelFactProvenance['confidence']
  notes?: string
}

export interface ParcelPmtilesInfo {
  ok: boolean
  minZoom?: number
  maxZoom?: number
  bounds?: [number, number, number, number]
  center?: [number, number, number]
  vectorLayers?: Array<{ id: string; fields: Record<string, string> }>
  error?: string
}

export interface ParcelPmtilesTileStat {
  z: number
  x: number
  y: number
  bytes: number
  cacheHit: boolean
  ioMs: number
  gunzipMs: number
  totalMs: number
  at: number
}

export interface ParcelPmtilesStats {
  available: boolean
  requests: number
  cacheHits: number
  cacheHitPct: number
  avgTotalMs: number
  avgIoMs: number
  avgGunzipMs: number
  p95TotalMs: number
  last: ParcelPmtilesTileStat[]
}

export interface ParcelSourceBlobStats {
  available: boolean
  blobs: number
  totalBytes: number
  latestAt: string | null
}

export type AnalyticsSortBy = 'parcel_count' | 'total_value' | 'total_acres' | 'total_sqft' | 'avg_value'

export interface DistributionBin {
  label: string
  count: number
}

export interface DistributionsResponse {
  totalValue: DistributionBin[]
  lotSize: DistributionBin[]
  yearBuilt: DistributionBin[]
}

export interface DashboardApi {
  pickImportFiles: () => Promise<string[]>
  pickImportFolder: () => Promise<string[]>
  ingestFiles: (request: IngestRequest) => Promise<IngestResponse>
  ingestDataPaths: (request: ImportDataPathsRequest) => Promise<ImportDataPathsResponse>
  getSnapshot: () => Promise<DashboardSnapshot>
  getBucketData: (bucket: BucketKey, query: QueryRequest) => Promise<BucketDataResponse>
  runQuery: (query: QueryRequest) => Promise<QueryResult>
  getDossier: (entityId: string) => Promise<DossierResponse>
  getConnectionGraph: (focusId?: string, bucket?: BucketKey) => Promise<ConnectionGraph>
  runPhoenix: (request: PhoenixRunRequest) => Promise<PhoenixRunResponse>
  loadConfigFile: () => Promise<{ path?: string; text?: string }>
  queryParcelCsv: (csvPath: string, targetParcel: string, maxSurrounding?: number) => Promise<ParcelQueryResult>
  queryParcelFiltered: (filter: ParcelFilterQuery) => Promise<ParcelQueryResult>
  countParcels: (filter: ParcelFilterQuery) => Promise<number>
  /* Phase 2: Terrain, Sun, View, Build APIs */
  getTerrainMetrics: (parcelId: string, lat: number, lng: number, lotSqft?: number, geometry?: Geometry | null) => Promise<TerrainMetricsResponse>
  getTerrainProduct: (parcelId: string) => Promise<any | null>
  getSlopeAtPoint: (lat: number, lng: number) => Promise<{ slopeDeg: number; slopePct: number }>
  getSunAnalysis: (parcelId: string, lat: number, lng: number, date: string, geometry?: Geometry | null) => Promise<SunAnalysisResponse>
  getViewAnalysis: (parcelId: string, lat: number, lng: number, stories: number, geometry?: Geometry | null) => Promise<ViewAnalysisResponse>
  runBuildSimulation: (input: BuildRunInput, lat: number, lng: number, lotSqft?: number) => Promise<BuildRunOutput>
  getBuildRunsForParcel: (parcelId: string, geometryHash?: string) => Promise<BuildRunOutput[]>
  getParcelAnalysisBundle: (request: ParcelAnalysisBundleRequest) => Promise<ParcelAnalysisBundleResponse>
  /* Phase 3: Owner Intelligence + Analytics */
  getOwnerByAin: (ain: string) => Promise<OwnerRecord | null>
  /** Ensure the SBF owner table is materialized and queryable (for fast per-parcel lookups). */
  prepareOwnerIndex: () => Promise<{ ok: boolean; rowCount?: number; elapsedMs?: number; error?: string }>
  getOwnerPortfolio: (ownerName: string, limit?: number) => Promise<OwnerPortfolio>
  getTopOwners: (sortBy: AnalyticsSortBy, limit?: number) => Promise<TopOwnerEntry[]>
  getHeatMapData: (resolution?: number) => Promise<HeatMapCell[]>
  getDistributions: () => Promise<DistributionsResponse>
  searchOwners: (query: string, limit?: number) => Promise<string[]>
  getParcelPolygons: (north: number, south: number, east: number, west: number, limit?: number) => Promise<ParcelPolygon[]>
  getParcelPolygonByAin: (ain: string) => Promise<ParcelPolygon | null>
  getParcelBoundaryTiles: (bounds: MapBounds, zoom: number) => Promise<ParcelBoundaryTileResponse>
  countParcelBoundaries: (bounds: MapBounds) => Promise<number>
  getParcelByPoint: (lng: number, lat: number) => Promise<ParcelPolygon | null>
  getParcelsInBounds: (bounds: MapBounds, limit?: number) => Promise<ParcelPolygon[]>
  getSqftCheck: (parcelId: string, ain: string, assessorSqft: number) => Promise<{ geometricSqft: number; neighborMedianSqft: number; status: string }>
  gdbAvailable: () => Promise<boolean>
  /* Plan 03: PMTiles-backed boundaries */
  getParcelPmtilesInfo: () => Promise<ParcelPmtilesInfo>
  getParcelPmtilesTile: (z: number, x: number, y: number) => Promise<Uint8Array | null>
  getParcelPmtilesStats: () => Promise<ParcelPmtilesStats>
  resetParcelPmtilesStats: () => Promise<void>
  getParcelPmtilesHttpBase: () => Promise<string | null>
  getSourceBlobStats: () => Promise<ParcelSourceBlobStats>
  convertSbfXlsxToCsv: () => Promise<{ ok: boolean; outputs?: string[]; error?: string }>
  getDataLoadProgress: () => Promise<DataLoadProgress>
  onDataLoadProgress: (callback: (progress: DataLoadProgress) => void) => () => void
  getParcelDossierProvenance: (parcel: ParcelRecord) => Promise<ParcelDossierProvenance>
  getParcelFactSourceManifest: () => Promise<ParcelFactSourceManifestEntry[]>
  getPropstreamGridData: () => Promise<PropstreamGridPayload>
  syncPropstreamFolders: () => Promise<{ ok: boolean; folders: ImportedDataFolder[]; error?: string }>
  captureMainWindow: () => Promise<{ ok: boolean; path?: string; error?: string }>
}
