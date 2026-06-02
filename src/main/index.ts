import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync, statSync } from 'fs'
import { mkdir, readFile, readdir, writeFile } from 'fs/promises'
import { basename, extname, join, resolve } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'
import http from 'http'

import { electronApp, is, optimizer } from '@electron-toolkit/utils'

import type {
  BucketKey,
  IngestRequest,
  ParcelFilterQuery,
  PhoenixRunRequest,
  QueryRequest,
  BuildRunInput,
  AnalyticsSortBy,
  DataLoadProgress,
  PropstreamGridPayload
} from '@shared/types'

import { DuckDBWorkspace } from './services/duckdbWorkspace'
import { ParcelCsvService } from './services/parcelCsvService'
import { PhoenixRunner } from './services/phoenixRunner'
import { computeTerrainMetrics, computeSlopeAtPoint } from './services/terrainEngine'
import { computeSunAnalysis } from './services/sunSimulator'
import { computeViewAnalysis } from './services/viewAnalysis'
import { runBuildSimulation } from './services/buildSimulator'
import { getOrComputeSqftCheck } from './services/sqftCheckEngine'
import { GdbParcelService } from './services/gdbConverter'
import { OwnerService } from './services/ownerService'
import { rentSeekerStore } from './services/rentSeekerStore'
import { ParcelPmtilesService } from './services/parcelPmtilesService'
import { propstreamService } from './services/propstreamService'
import type { TerrainMetricsResponse, SunAnalysisResponse, ViewAnalysisResponse } from '@shared/types'

const rootPath = app.getAppPath()
const workspace = new DuckDBWorkspace(rootPath)
const phoenixRunner = new PhoenixRunner(rootPath)
const parcelCsvService = new ParcelCsvService()
const gdbParcelService = new GdbParcelService()
const ownerService = new OwnerService()
const parcelPmtilesService = new ParcelPmtilesService()
const execFileAsync = promisify(execFile)

let pmtilesHttpBase: string | null = null
let pmtilesHttpServer: http.Server | null = null
let mainWindowRef: BrowserWindow | null = null

interface CustomDataFolderRecord {
  folderPath: string
  label: string
  color: string
  fileCount: number
  byteSize: number
  rowCount: number
  importedAt: string
  kind?: 'path' | 'propstream'
}

const DATA_FOLDER_STATE_FILE = () => resolve(app.getPath('userData'), 'data-folders.json')
const SUPPORTED_IMPORT_EXTENSIONS = new Set(['.csv', '.tsv', '.json', '.xlsx', '.xls', '.geojson'])
const CUSTOM_FOLDER_PALETTE = ['#00d4ff', '#abff02', '#ffde59', '#ff7a45', '#a78bfa', '#34d399', '#f472b6', '#94a3b8']

function hashToPaletteColor(input: string): string {
  const digest = createHash('sha1').update(input).digest()
  const idx = digest[0] % CUSTOM_FOLDER_PALETTE.length
  return CUSTOM_FOLDER_PALETTE[idx]
}

function labelFromFolderPath(folderPath: string): string {
  const label = basename(folderPath).replace(/\.[^.]+$/, '').trim()
  return label || 'Imported Data'
}

async function readCustomFolderRegistry(): Promise<CustomDataFolderRecord[]> {
  try {
    const raw = await readFile(DATA_FOLDER_STATE_FILE(), 'utf8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item) => ({
        folderPath: String(item.folderPath ?? ''),
        label: String(item.label ?? ''),
        color: String(item.color ?? ''),
        fileCount: Number(item.fileCount ?? 0) || 0,
        byteSize: Number(item.byteSize ?? 0) || 0,
      rowCount: Number(item.rowCount ?? 0) || 0,
      importedAt: String(item.importedAt ?? new Date().toISOString()),
      kind: (item.kind === 'propstream' ? 'propstream' : 'path') as 'path' | 'propstream'
    }))
      .filter((item) => item.folderPath)
  } catch {
    return []
  }
}

async function writeCustomFolderRegistry(records: CustomDataFolderRecord[]): Promise<void> {
  await mkdir(resolve(app.getPath('userData')), { recursive: true })
  await writeFile(DATA_FOLDER_STATE_FILE(), JSON.stringify(records, null, 2), 'utf8')
}

async function collectImportableFiles(paths: string[]): Promise<Array<{ filePath: string; rootPath: string }>> {
  const files = new Map<string, string>()
  const queue = paths.map((path) => ({ path, rootPath: existsSync(path) && statSync(path).isDirectory() ? path : resolve(path, '..') }))
  while (queue.length > 0) {
    const current = queue.shift()!
    if (!existsSync(current.path)) continue
    const stat = statSync(current.path)
    if (stat.isFile()) {
      const ext = extname(current.path).toLowerCase()
      if (SUPPORTED_IMPORT_EXTENSIONS.has(ext)) files.set(current.path, current.rootPath)
      continue
    }
    if (!stat.isDirectory()) continue
    const entries = await readdir(current.path, { withFileTypes: true })
    for (const entry of entries) {
      const child = resolve(current.path, entry.name)
      if (entry.isDirectory()) {
        queue.push({ path: child, rootPath: current.rootPath })
      } else {
        const ext = extname(entry.name).toLowerCase()
        if (SUPPORTED_IMPORT_EXTENSIONS.has(ext)) files.set(child, current.rootPath)
      }
    }
  }
  return [...files.entries()].map(([filePath, rootPath]) => ({ filePath, rootPath }))
}

async function ensurePmtilesHttpServer(): Promise<string | null> {
  if (pmtilesHttpBase) return pmtilesHttpBase
  if (!parcelPmtilesService.isAvailable()) {
    pmtilesHttpBase = null
    return null
  }
  if (pmtilesHttpServer) return pmtilesHttpBase

  pmtilesHttpServer = http.createServer(async (req, res) => {
    // Lightweight per-process counter for seeing whether MapLibre is actually requesting tiles.
    const n = (((ensurePmtilesHttpServer as any).__reqCount ?? 0) + 1)
    ;(ensurePmtilesHttpServer as any).__reqCount = n
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      // /pmtiles/z/x/y.pbf
      const m = url.pathname.match(/^\/pmtiles\/(\d+)\/(\d+)\/(\d+)\.pbf$/i)
      if (!m) {
        res.statusCode = 404
        res.end('not found')
        return
      }
      const z = Number(m[1]); const x = Number(m[2]); const y = Number(m[3])
      if (!Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y)) {
        res.statusCode = 400
        res.end('bad request')
        return
      }
      const t0 = Date.now()
      const tile = await parcelPmtilesService.getTile(z, x, y)
      const dt = Date.now() - t0
      if (!tile) {
        res.statusCode = 204
        res.end()
        return
      }
      if (n <= 12) {
        console.log(`[pmtiles-http] #${n} zxy=${z}/${x}/${y} bytes=${tile.byteLength} dt=${dt}ms`)
      }
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/x-protobuf')
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      res.end(Buffer.from(tile))
    } catch (err: any) {
      res.statusCode = 500
      res.end(err?.message || 'server error')
    }
  })

  await new Promise<void>((resolve, reject) => {
    pmtilesHttpServer!.listen(0, '127.0.0.1', () => resolve())
    pmtilesHttpServer!.on('error', reject)
  })
  const addr = pmtilesHttpServer.address()
  const port = typeof addr === 'object' && addr ? addr.port : null
  pmtilesHttpBase = port ? `http://127.0.0.1:${port}/pmtiles` : null
  if (pmtilesHttpBase) console.log('[pmtiles-http] serving tiles at', pmtilesHttpBase)
  return pmtilesHttpBase
}

const sbfConversionState: {
  running: boolean
  startedAt: number
  lastError?: string
} = { running: false, startedAt: 0 }

const dataManifest = [
  {
    datasetName: 'LA County Assessor Parcels',
    color: '#00d4ff',
    path: '/Users/rjack/Desktop/almanac/Docs/RE Data/Parcel_Data_0 2.csv',
    estimatedRows: 2400000
  },
  {
    datasetName: 'Secured Basic File (SBF)',
    color: '#e8c547',
    path: '/Users/rjack/Desktop/almanac/Docs/RE Data/SBF Secured Basic File LA County Assessor Abstract/sbf_part1.csv',
    estimatedRows: 880000
  },
  {
    datasetName: 'Certificate of Occupancy',
    color: '#ff6b35',
    path: '/Users/rjack/Desktop/almanac/Docs/RE Data/Building_and_Safety_Certificate_of_Occupancy_20260404.csv',
    estimatedRows: 150000
  },
  {
    datasetName: 'Building Permits 2020+',
    color: '#a78bfa',
    path: '/Users/rjack/Desktop/almanac/Docs/RE Data/Building_and_Safety_-_Building_Permits_Issued_from_2020_to_Present_(N)_20260417.csv',
    estimatedRows: 850000
  },
  {
    datasetName: 'Electrical Permits 2020+',
    color: '#34d399',
    path: '/Users/rjack/Desktop/almanac/Docs/RE Data/Building_and_Safety_-_Electrical_Permits_Issued_from_2020_to_Present_(N)_20260417.csv',
    estimatedRows: 650000
  },
  {
    datasetName: 'Building Permits Submitted',
    color: '#f472b6',
    path: '/Users/rjack/Desktop/almanac/Docs/RE Data/Building_and_Safety_-_Building_Permits_Submitted_from_2020_to_Present_(N)_20260417.csv',
    estimatedRows: 550000
  },
  {
    datasetName: 'Inspections',
    color: '#94a3b8',
    path: '/Users/rjack/Desktop/almanac/Docs/RE Data/Building_and_Safety_Inspections_20260417.csv',
    estimatedRows: 4000000
  },
  {
    datasetName: 'Parcel Boundary Lines',
    color: '#00ffc8',
    path: '/Users/rjack/Desktop/almanac/Docs/RE Data/parcel_geojson/LACounty_Parcels.pmtiles',
    estimatedRows: 2400000
  }
]

async function getDataLoadProgress(): Promise<DataLoadProgress> {
  const started = Date.now()
  const customFolders = await readCustomFolderRegistry()
  const manifestEntries = dataManifest.map((item) => {
    let exists = existsSync(item.path)
    let bytes = exists ? statSync(item.path).size : 0

    // For SBF, treat it as present only when all 3 CSV parts exist.
    if (item.datasetName.includes('(SBF)')) {
      const dir = '/Users/rjack/Desktop/almanac/Docs/RE Data/SBF Secured Basic File LA County Assessor Abstract'
      const parts = ['sbf_part1.csv', 'sbf_part2.csv', 'sbf_part3.csv'].map((name) => join(dir, name))
      exists = parts.every((p) => existsSync(p))
      bytes = exists ? parts.reduce((sum, p) => sum + statSync(p).size, 0) : 0
    }

    return {
      sourcePath: item.path,
      datasetId: item.datasetName.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
      step: {
        datasetName: item.datasetName,
        color: item.color,
        status: sbfConversionState.running && item.datasetName.includes('(SBF)')
          ? 'loading' as const
          : (exists ? 'done' as const : 'error' as const),
        rowCount: exists ? item.estimatedRows : 0,
        elapsedMs: Date.now() - started,
        byteSize: bytes,
        errorMsg: exists ? undefined : (sbfConversionState.running && item.datasetName.includes('(SBF)') ? undefined : (sbfConversionState.lastError ?? 'File not found'))
      }
    }
  })
  const customEntries = customFolders.map((folder) => ({
    sourcePath: folder.folderPath,
    datasetId: `custom_folder_${createHash('sha1').update(folder.folderPath).digest('hex').slice(0, 10)}`,
    step: {
      datasetName: `Folder: ${folder.label || labelFromFolderPath(folder.folderPath)}`,
      color: folder.color || hashToPaletteColor(folder.folderPath),
      status: folder.folderPath.startsWith('propstream://') || existsSync(folder.folderPath)
        ? 'done' as const
        : 'error' as const,
      rowCount: folder.rowCount,
      elapsedMs: Date.now() - started,
      byteSize: folder.folderPath.startsWith('propstream://') ? 0 : folder.byteSize,
      errorMsg: folder.folderPath.startsWith('propstream://') || existsSync(folder.folderPath) ? undefined : 'Folder not found'
    }
  }))
  const manifestSteps = [...manifestEntries, ...customEntries]
  const steps = manifestSteps.map((entry) => entry.step)
  await Promise.allSettled(manifestSteps.map((entry) => rentSeekerStore.recordSourceStep({
    ...entry.step,
    sourcePath: entry.sourcePath,
    datasetId: entry.datasetId
  })))
  const done = steps.filter((step) => step.status === 'done').length
  return {
    steps,
    totalRows: steps.reduce((sum, step) => sum + step.rowCount, 0),
    overallPct: steps.length === 0 ? 0 : (done / steps.length) * 100
  }
}

async function importDataPaths(paths: string[]): Promise<{ datasets: Awaited<ReturnType<typeof workspace.ingestFiles>>['datasets']; folders: CustomDataFolderRecord[]; skippedPaths: string[] }> {
  await workspace.initialize()
  const registry = await readCustomFolderRegistry()
  const importableFiles = await collectImportableFiles(paths)
  const skippedPaths = paths.filter((path) => !existsSync(path))
  const ingestResponse = importableFiles.length > 0
    ? await workspace.ingestFiles(importableFiles.map((entry) => entry.filePath))
    : { datasets: [], summary: 'No importable rows found.' }

  const now = new Date().toISOString()
  const byFolder = new Map<string, { fileCount: number; byteSize: number; rowCount: number; label: string; color: string }>()
  const rootByFile = new Map(importableFiles.map((entry) => [resolve(entry.filePath), resolve(entry.rootPath)] as const))
  for (const entry of importableFiles) {
    const parent = resolve(entry.rootPath)
    const label = labelFromFolderPath(parent)
    const color = hashToPaletteColor(parent)
    const stat = existsSync(entry.filePath) ? statSync(entry.filePath) : null
    const prev = byFolder.get(parent) ?? { fileCount: 0, byteSize: 0, rowCount: 0, label, color }
    prev.fileCount += 1
    prev.byteSize += stat?.size ?? 0
    byFolder.set(parent, prev)
  }

  for (const dataset of ingestResponse.datasets) {
    const source = resolve(dataset.sourcePath)
    const parent = rootByFile.get(source) ?? resolve(source, '..')
    const folderEntry = byFolder.get(parent)
    if (folderEntry) folderEntry.rowCount += Number(dataset.rows ?? 0) || 0
  }

  const merged = [...registry]
  for (const [folderPath, info] of byFolder.entries()) {
    const existingIndex = merged.findIndex((item) => resolve(item.folderPath) === folderPath)
    const next: CustomDataFolderRecord = {
      folderPath,
      label: info.label,
      color: info.color,
      fileCount: info.fileCount,
      byteSize: info.byteSize,
      rowCount: info.rowCount,
      importedAt: now
    }
    if (existingIndex >= 0) merged[existingIndex] = next
    else merged.push(next)
  }
  await writeCustomFolderRegistry(merged)

  return { datasets: ingestResponse.datasets, folders: merged, skippedPaths }
}

async function syncPropstreamFolders(): Promise<{ payload: PropstreamGridPayload; folders: CustomDataFolderRecord[] }> {
  const payload = await propstreamService.getGridData()
  const registry = await readCustomFolderRegistry()
  const now = new Date().toISOString()
  const propFolders = await propstreamService.syncFolders()
  const merged = [...registry.filter((item) => !item.folderPath.startsWith('propstream://'))]

  for (const folder of propFolders) {
    const next: CustomDataFolderRecord = {
      folderPath: folder.folderPath,
      label: folder.label,
      color: folder.color,
      fileCount: folder.fileCount,
      byteSize: folder.byteSize,
      rowCount: folder.rowCount,
      importedAt: now,
      kind: 'propstream'
    }
    const existingIndex = merged.findIndex((item) => item.folderPath === folder.folderPath)
    if (existingIndex >= 0) merged[existingIndex] = next
    else merged.push(next)
  }

  await writeCustomFolderRegistry(merged)
  return { payload, folders: merged }
}

async function pushDataLoadProgressLive(mainWindow: BrowserWindow): Promise<void> {
  // No fake sequencing. This is a file/manifest health snapshot.
  // Runtime readiness is tracked separately by the renderer assembly gates.
  const seed = await getDataLoadProgress()
  mainWindow.webContents.send('dashboard:data-load-progress', seed)
}

async function createWindow(): Promise<void> {
  await ensurePmtilesHttpServer().catch(() => null)
  const mainWindow = new BrowserWindow({
    width: 1680,
    height: 1020,
    minWidth: 1320,
    minHeight: 840,
    // Do not steal focus on reloads during dev; showInactive after ready-to-show.
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#091018',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.once('ready-to-show', () => {
    // Show without focusing; allow explicit focus via env toggle.
    try { (mainWindow as any).showInactive?.() } catch { mainWindow.show() }
    if (process.env['RENTSEEKER_FOCUS'] === '1') {
      mainWindow.focus()
      app.focus({ steal: true })
    }
  })
  mainWindowRef = mainWindow
  // Pipe renderer console logs to the main process terminal so we can debug without opening DevTools.
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const tag = level >= 3 ? 'error' : level === 2 ? 'warn' : 'log'
    console.log(`[renderer:${tag}] ${message} (${sourceId}:${line})`)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    await mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    await mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Only open DevTools when explicitly requested.
  if (is.dev && process.env['RENTSEEKER_DEVTOOLS'] === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }
  // Dataset manifest scanning is triggered by the renderer once core runtime gates are ready.
  // Avoid doing large-file stats during initial map/PMTiles bring-up.

  // Dev-only: PMTiles tile performance telemetry.
  if (is.dev) {
    let lastReq = -1
    setInterval(() => {
      try {
        const s = parcelPmtilesService.getStats()
        if (s.requests !== lastReq) {
          lastReq = s.requests
          console.log(
            `[pmtiles] req=${s.requests} cache=${s.cacheHitPct.toFixed(0)}% avgTotal=${s.avgTotalMs.toFixed(1)}ms avgIO=${s.avgIoMs.toFixed(1)}ms avgGunzip=${s.avgGunzipMs.toFixed(1)}ms p95=${s.p95TotalMs.toFixed(1)}ms`
          )
        }
      } catch {
        // ignore
      }
    }, 1000).unref?.()
  }
}

function registerIpc(): void {
  ipcMain.handle('dashboard:pick-import-files', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Import discovery data',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Supported data files', extensions: ['csv', 'xlsx', 'xls', 'json'] },
        { name: 'CSV', extensions: ['csv'] },
        { name: 'Excel', extensions: ['xlsx', 'xls'] },
        { name: 'JSON', extensions: ['json'] }
      ]
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('dashboard:pick-import-folder', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Import data folder',
      properties: ['openDirectory', 'multiSelections']
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('dashboard:ingest-files', async (_event, request: IngestRequest) => {
    return workspace.ingestFiles(request.filePaths)
  })

  ipcMain.handle('dashboard:ingest-data-paths', async (_event, request: { paths: string[] }) => {
    try {
      const result = await importDataPaths(Array.isArray(request?.paths) ? request.paths : [])
      const snap = await getDataLoadProgress().catch(() => null)
      if (snap) mainWindowRef?.webContents.send('dashboard:data-load-progress', snap)
      return {
        ok: true,
        summary: result.datasets.length === 0
          ? 'No importable rows found.'
          : `Imported ${result.datasets.length} dataset${result.datasets.length === 1 ? '' : 's'} from ${result.folders.length} folder${result.folders.length === 1 ? '' : 's'}.`,
        datasets: result.datasets,
        folders: result.folders,
        skippedPaths: result.skippedPaths
      }
    } catch (err: any) {
      return { ok: false, summary: '', datasets: [], folders: [], error: err?.message || String(err), skippedPaths: [] }
    }
  })

  ipcMain.handle('dashboard:get-snapshot', async () => workspace.getSnapshot())
  ipcMain.handle('dashboard:get-bucket-data', async (_event, bucket: BucketKey, query: QueryRequest) =>
    workspace.getBucketData(bucket, query)
  )
  ipcMain.handle('dashboard:run-query', async (_event, query: QueryRequest) => workspace.runStructuredQuery(query))
  ipcMain.handle('dashboard:get-dossier', async (_event, entityId: string) => workspace.getDossier(entityId))
  ipcMain.handle('dashboard:get-connection-graph', async (_event, focusId?: string, bucket?: BucketKey) =>
    workspace.getConnectionGraph(focusId, bucket)
  )

  ipcMain.handle('dashboard:load-config-file', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Load Phoenix config',
      properties: ['openFile'],
      filters: [{ name: 'YAML', extensions: ['yaml', 'yml'] }]
    })
    if (result.canceled || result.filePaths.length === 0) {
      return {}
    }
    const filePath = result.filePaths[0]
    const text = await readFile(filePath, 'utf8')
    return { path: filePath, text }
  })

  ipcMain.handle('dashboard:run-phoenix', async (_event, request: PhoenixRunRequest) => {
    const result = await phoenixRunner.run(request)
    await workspace.recordPhoenixRun(result)
    const importableOutputs = result.outputPaths.filter((path) => /\.(csv|json|xlsx|xls)$/i.test(path))
    if (result.ok && importableOutputs.length > 0) {
      await workspace.ingestFiles(importableOutputs)
    }
    return result
  })

  ipcMain.handle(
    'dashboard:query-parcel-csv',
    async (_event, csvPath: string, targetParcel: string, maxSurrounding?: number) => {
      return parcelCsvService.queryParcels(csvPath, targetParcel, maxSurrounding ?? 100)
    }
  )

  ipcMain.handle(
    'dashboard:query-parcel-filtered',
    async (_event, filter: ParcelFilterQuery) => {
      return parcelCsvService.queryFiltered(filter)
    }
  )

  ipcMain.handle(
    'dashboard:count-parcels',
    async (_event, filter: ParcelFilterQuery) => {
      return parcelCsvService.countFiltered(filter)
    }
  )

  /* -------- Terrain Engine -------- */
  ipcMain.handle(
    'dashboard:get-terrain-metrics',
    async (_event, parcelId: string, lat: number, lng: number, lotSqft?: number, geometry?: any) => {
      try {
        const cached = await rentSeekerStore.getTerrainMetrics(parcelId)
        if (cached) {
          const resp: TerrainMetricsResponse = { computed: true, cached: true, metrics: cached }
          return resp
        }
      } catch {
        // Ignore cache read failures; compute below.
      }
      try {
        const metrics = await computeTerrainMetrics(parcelId, lat, lng, lotSqft, geometry ?? null)
        const resp: TerrainMetricsResponse = { computed: true, cached: false, metrics }
        return resp
      } catch (err: any) {
        const resp: TerrainMetricsResponse = {
          computed: false,
          cached: false,
          reason: err?.message || 'Terrain metrics not computed',
          metrics: null
        }
        return resp
      }
    }
  )

  ipcMain.handle(
    'dashboard:get-terrain-product',
    async (_event, parcelId: string) => {
      return rentSeekerStore.getLatestTerrainProduct(parcelId, 'surface_grid')
    }
  )

  ipcMain.handle(
    'dashboard:get-slope-at-point',
    async (_event, lat: number, lng: number) => {
      return computeSlopeAtPoint(lat, lng)
    }
  )

  /* -------- Sun Simulator -------- */
  ipcMain.handle(
    'dashboard:get-sun-analysis',
    async (_event, parcelId: string, lat: number, lng: number, date: string) => {
      try {
        const cached = await rentSeekerStore.getSunAnalysis(parcelId, date)
        if (cached) {
          const resp: SunAnalysisResponse = { computed: true, cached: true, analysis: cached }
          return resp
        }
      } catch {
        // fall through
      }
      try {
        const analysis = await computeSunAnalysis(parcelId, lat, lng, date)
        const resp: SunAnalysisResponse = { computed: true, cached: false, analysis }
        return resp
      } catch (err: any) {
        const resp: SunAnalysisResponse = {
          computed: false,
          cached: false,
          reason: err?.message || 'Sun analysis not computed',
          analysis: null
        }
        return resp
      }
    }
  )

  /* -------- View Analysis -------- */
  ipcMain.handle(
    'dashboard:get-view-analysis',
    async (_event, parcelId: string, lat: number, lng: number, stories: number) => {
      try {
        const cached = await rentSeekerStore.getViewAnalysis(parcelId, stories)
        if (cached) {
          const resp: ViewAnalysisResponse = { computed: true, cached: true, analysis: cached }
          return resp
        }
      } catch {
        // fall through
      }
      try {
        const analysis = await computeViewAnalysis(parcelId, lat, lng, stories)
        const resp: ViewAnalysisResponse = { computed: true, cached: false, analysis }
        return resp
      } catch (err: any) {
        const resp: ViewAnalysisResponse = {
          computed: false,
          cached: false,
          reason: err?.message || 'View analysis not computed',
          analysis: null
        }
        return resp
      }
    }
  )

  /* -------- Build Simulator -------- */
  ipcMain.handle(
    'dashboard:run-build-simulation',
    async (_event, input: BuildRunInput, lat: number, lng: number, lotSqft?: number) => {
      const cachedTerrain = await rentSeekerStore.getTerrainMetrics(input.parcelId).catch(() => null)
      return runBuildSimulation(input, lat, lng, lotSqft, cachedTerrain ?? undefined)
    }
  )

  ipcMain.handle(
    'dashboard:get-build-runs-for-parcel',
    async (_event, parcelId: string) => {
      return rentSeekerStore.getBuildRunsForParcel(parcelId)
    }
  )

  /* -------- GDB Parcel Polygons -------- */
  ipcMain.handle(
    'dashboard:get-parcel-polygons',
    async (_event, north: number, south: number, east: number, west: number, limit?: number) => {
      return gdbParcelService.queryPolygonsInBounds(north, south, east, west, limit)
    }
  )

  ipcMain.handle(
    'dashboard:get-parcel-polygon-by-ain',
    async (_event, ain: string) => {
      return gdbParcelService.getParcelByAin(ain)
    }
  )

  /* -------- Parcel Polygon Sqft Check (Plan 02) -------- */
  ipcMain.handle(
    'dashboard:get-sqft-check',
    async (_event, parcelId: string, ain: string, assessorSqft: number) => {
      const poly = await gdbParcelService.getParcelByAin(ain).catch(() => null)
      const resp = await getOrComputeSqftCheck({
        parcelId,
        assessorSqft,
        parcelPolygon: poly,
        getNeighbors: (bounds, limit) => gdbParcelService.getParcelsInBounds(bounds, limit)
      })
      return resp
    }
  )

  ipcMain.handle(
    'dashboard:get-parcel-boundary-tiles',
    async (_event, bounds, zoom: number) => {
      return gdbParcelService.getParcelBoundaryTiles(bounds, zoom)
    }
  )

  ipcMain.handle(
    'dashboard:count-parcel-boundaries',
    async (_event, bounds) => {
      return gdbParcelService.countParcelBoundaries(bounds)
    }
  )

  ipcMain.handle(
    'dashboard:get-parcel-by-point',
    async (_event, lng: number, lat: number) => {
      return gdbParcelService.getParcelByPoint(lng, lat)
    }
  )

  ipcMain.handle(
    'dashboard:get-parcels-in-bounds',
    async (_event, bounds, limit?: number) => {
      return gdbParcelService.getParcelsInBounds(bounds, limit)
    }
  )

  ipcMain.handle('dashboard:gdb-available', async () => {
    return gdbParcelService.isAvailable()
  })

  /* -------- PMTiles Parcel Boundaries (Primary Render Source) -------- */
  ipcMain.handle('dashboard:get-parcel-pmtiles-info', async () => {
    return parcelPmtilesService.getInfo()
  })

  ipcMain.handle(
    'dashboard:get-parcel-pmtiles-tile',
    async (_event, z: number, x: number, y: number) => {
      return parcelPmtilesService.getTile(z, x, y)
    }
  )

  ipcMain.handle('dashboard:get-parcel-pmtiles-stats', async () => {
    return parcelPmtilesService.getStats()
  })

  ipcMain.handle('dashboard:reset-parcel-pmtiles-stats', async () => {
    parcelPmtilesService.resetStats()
  })

  ipcMain.handle('dashboard:get-parcel-pmtiles-http-base', async () => {
    return ensurePmtilesHttpServer().catch(() => null)
  })

  /* -------- Owner Intelligence (SBF) -------- */
  ipcMain.handle(
    'dashboard:get-owner-by-ain',
    async (_event, ain: string) => {
      return ownerService.getOwnerByAin(ain)
    }
  )

  ipcMain.handle('dashboard:prepare-owner-index', async () => {
    const started = Date.now()
    try {
      const stats = await ownerService.getStats()
      return { ok: true, rowCount: stats.totalRows, elapsedMs: Date.now() - started }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err), elapsedMs: Date.now() - started }
    }
  })

  ipcMain.handle(
    'dashboard:get-owner-portfolio',
    async (_event, ownerName: string, limit?: number) => {
      return ownerService.getOwnerPortfolio(ownerName, limit)
    }
  )

  ipcMain.handle(
    'dashboard:get-top-owners',
    async (_event, sortBy: AnalyticsSortBy, limit?: number) => {
      return ownerService.getTopOwners(sortBy, limit)
    }
  )

  ipcMain.handle(
    'dashboard:get-heat-map-data',
    async (_event, resolution?: number) => {
      return ownerService.getHeatMapData(resolution)
    }
  )

  ipcMain.handle(
    'dashboard:get-distributions',
    async () => {
      return ownerService.getDistributions()
    }
  )

  ipcMain.handle(
    'dashboard:search-owners',
    async (_event, query: string, limit?: number) => {
      return ownerService.searchOwners(query, limit)
    }
  )

  ipcMain.handle('dashboard:get-data-load-progress', async () => getDataLoadProgress())

  ipcMain.handle('dashboard:get-propstream-grid-data', async () => {
    return propstreamService.getGridData()
  })

  ipcMain.handle('dashboard:sync-propstream-folders', async () => {
    try {
      const result = await syncPropstreamFolders()
      const snap = await getDataLoadProgress().catch(() => null)
      if (snap) mainWindowRef?.webContents.send('dashboard:data-load-progress', snap)
      return { ok: true, folders: result.folders, error: undefined }
    } catch (err: any) {
      return { ok: false, folders: [], error: err?.message || String(err) }
    }
  })

  ipcMain.handle('dashboard:capture-main-window', async () => {
    const w = mainWindowRef
    if (!w) return { ok: false, error: 'Main window not ready' }
    try {
      const image = await w.webContents.capturePage()
      const png = image.toPNG()
      const path = `/private/tmp/rentseeker_capture_${Date.now()}.png`
      await writeFile(path, png)
      return { ok: true, path }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  })

  /* -------- SBF Conversion (XLSX -> CSV) -------- */
  ipcMain.handle('dashboard:convert-sbf-xlsx-to-csv', async (event) => {
    const scriptPath = '/Users/rjack/Desktop/almanac/RentSeeker/scripts/convert-sbf-xlsx.py'
    const venvPython = '/Users/rjack/Desktop/almanac/RentSeeker/.venv/bin/python'
    const python = existsSync(venvPython) ? venvPython : 'python3'
    sbfConversionState.running = true
    sbfConversionState.startedAt = Date.now()
    sbfConversionState.lastError = undefined
    try {
      const snap = await getDataLoadProgress().catch(() => null)
      if (snap) event.sender.send('dashboard:data-load-progress', snap)
    } catch { /* ignore */ }
    try {
      const { stdout, stderr } = await execFileAsync(python, [scriptPath], { maxBuffer: 1024 * 1024 * 16 })
      if (stderr?.trim()) {
        console.warn('[sbf-convert] stderr:', stderr.trim())
      }
      const outputs = (stdout ?? '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => line.split(':')[0])
      sbfConversionState.running = false
      try {
        const snap = await getDataLoadProgress().catch(() => null)
        if (snap) event.sender.send('dashboard:data-load-progress', snap)
      } catch { /* ignore */ }
      return { ok: true, outputs }
    } catch (err: any) {
      sbfConversionState.running = false
      sbfConversionState.lastError = err?.message || String(err)
      try {
        const snap = await getDataLoadProgress().catch(() => null)
        if (snap) event.sender.send('dashboard:data-load-progress', snap)
      } catch { /* ignore */ }
      return { ok: false, error: err?.message || String(err) }
    }
  })
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.almanac.rentseeker')
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Force macOS Dock icon when running loosely inside the native .app wrapper
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(join(rootPath, 'icon.png'))
  }

  try {
    registerIpc()
    await rentSeekerStore.initialize()
    await createWindow()

    // workspace.initialize() is non-critical for the Parcel Explorer.
    // Fire-and-forget so a DuckDB lock error doesn't kill the window.
    workspace.initialize().catch((err) => {
      console.error('[workspace] non-fatal init error:', err?.message || err)
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow()
      }
    })
  } catch (error: any) {
    dialog.showErrorBox('Startup Error', `The application failed to initialize properly:\n\n${error?.message || error}`)
    app.quit()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  // Ensure file handles are closed explicitly (Node 25+ treats GC-closing as an error).
  void parcelPmtilesService.dispose().catch(() => undefined)
})
