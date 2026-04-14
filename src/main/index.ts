import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { readFile } from 'fs/promises'
import { join } from 'path'

import { electronApp, is, optimizer } from '@electron-toolkit/utils'

import type { BucketKey, IngestRequest, PhoenixRunRequest, QueryRequest } from '@shared/types'

import { DuckDBWorkspace } from './services/duckdbWorkspace'
import { ParcelCsvService } from './services/parcelCsvService'
import { PhoenixRunner } from './services/phoenixRunner'

const rootPath = app.getAppPath()
const workspace = new DuckDBWorkspace(rootPath)
const phoenixRunner = new PhoenixRunner(rootPath)
const parcelCsvService = new ParcelCsvService()

async function createWindow(): Promise<void> {
  const mainWindow = new BrowserWindow({
    width: 1680,
    height: 1020,
    minWidth: 1320,
    minHeight: 840,
    show: true,
    autoHideMenuBar: true,
    backgroundColor: '#091018',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.show()
  mainWindow.focus()
  app.focus({ steal: true })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    await mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    await mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
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

  ipcMain.handle('dashboard:ingest-files', async (_event, request: IngestRequest) => {
    return workspace.ingestFiles(request.filePaths)
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

