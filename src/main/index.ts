import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import http from 'http'

import { electronApp, is, optimizer } from '@electron-toolkit/utils'

import type {
  BucketKey,
  IngestRequest,
  ParcelFilterQuery,
  ParcelRecord,
  PhoenixRunRequest,
  QueryRequest,
  BuildRunInput,
  AnalyticsSortBy
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
import { geometryFingerprint } from '@shared/sourceRegistry'
import type { TerrainMetricsResponse, SunAnalysisResponse, ViewAnalysisResponse } from '@shared/types'
import { createDataRegistryService } from './services/dataRegistryService'
import { getParcelAnalysisBundle } from './services/parcelAnalysisBundleService'
import { getParcelDossierProvenance } from './services/parcelProvenanceService'
import { getParcelFactSourceManifest } from './services/parcelProvenanceService'

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
const dataRegistry = createDataRegistryService({
  workspace,
  rentSeekerStore,
  propstreamService,
  sbfConversionState
})

async function pushDataLoadProgressLive(mainWindow: BrowserWindow): Promise<void> {
  const seed = await dataRegistry.getDataLoadProgress()
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
      const result = await dataRegistry.importDataPaths(Array.isArray(request?.paths) ? request.paths : [])
      const snap = await dataRegistry.getDataLoadProgress().catch(() => null)
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
      const geometryHash = geometryFingerprint(geometry ?? null)
      try {
        const cached = await rentSeekerStore.getTerrainMetrics(parcelId, geometryHash)
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
    async (_event, parcelId: string, lat: number, lng: number, date: string, geometry?: any) => {
      const geometryHash = geometryFingerprint(geometry ?? null)
      try {
        const cached = await rentSeekerStore.getSunAnalysis(parcelId, date, geometryHash)
        if (cached) {
          const resp: SunAnalysisResponse = { computed: true, cached: true, analysis: cached }
          return resp
        }
      } catch {
        // fall through
      }
      try {
        const analysis = await computeSunAnalysis(parcelId, lat, lng, date, geometry ?? null)
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
    async (_event, parcelId: string, lat: number, lng: number, stories: number, geometry?: any) => {
      const geometryHash = geometryFingerprint(geometry ?? null)
      try {
        const cached = await rentSeekerStore.getViewAnalysis(parcelId, stories, geometryHash)
        if (cached) {
          const resp: ViewAnalysisResponse = { computed: true, cached: true, analysis: cached }
          return resp
        }
      } catch {
        // fall through
      }
      try {
        const analysis = await computeViewAnalysis(parcelId, lat, lng, stories, geometry ?? null)
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
      const cachedTerrain = await rentSeekerStore.getTerrainMetrics(input.parcelId, geometryFingerprint(input.parcelGeometry ?? null)).catch(() => null)
      return runBuildSimulation(input, lat, lng, lotSqft, cachedTerrain ?? undefined)
    }
  )

  ipcMain.handle(
    'dashboard:get-build-runs-for-parcel',
    async (_event, parcelId: string, geometryHash?: string) => {
      return rentSeekerStore.getBuildRunsForParcel(parcelId, geometryHash ?? '')
    }
  )

  ipcMain.handle(
    'dashboard:get-parcel-analysis-bundle',
    async (_event, request) => {
      return getParcelAnalysisBundle(request)
    }
  )

  ipcMain.handle(
    'dashboard:get-parcel-dossier-provenance',
    async (_event, parcel: ParcelRecord) => {
      return getParcelDossierProvenance(parcel, rentSeekerStore)
    }
  )

  ipcMain.handle(
    'dashboard:get-parcel-fact-source-manifest',
    async () => {
      return getParcelFactSourceManifest()
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

  ipcMain.handle('dashboard:get-source-blob-stats', async () => {
    return rentSeekerStore.getSourceBlobStats()
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

  ipcMain.handle('dashboard:get-data-load-progress', async () => dataRegistry.getDataLoadProgress())

  ipcMain.handle('dashboard:get-propstream-grid-data', async () => {
    return propstreamService.getGridData()
  })

  ipcMain.handle('dashboard:sync-propstream-folders', async () => {
    try {
      const result = await dataRegistry.syncPropstreamFolders()
      const snap = await dataRegistry.getDataLoadProgress().catch(() => null)
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
      const snap = await dataRegistry.getDataLoadProgress().catch(() => null)
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
        const snap = await dataRegistry.getDataLoadProgress().catch(() => null)
        if (snap) event.sender.send('dashboard:data-load-progress', snap)
      } catch { /* ignore */ }
      return { ok: true, outputs }
    } catch (err: any) {
      sbfConversionState.running = false
      sbfConversionState.lastError = err?.message || String(err)
      try {
        const snap = await dataRegistry.getDataLoadProgress().catch(() => null)
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
