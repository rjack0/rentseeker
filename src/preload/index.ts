import { contextBridge, ipcRenderer } from 'electron'

import type { DashboardApi } from '@shared/types'

const api: DashboardApi = {
  pickImportFiles: () => ipcRenderer.invoke('dashboard:pick-import-files'),
  ingestFiles: (request) => ipcRenderer.invoke('dashboard:ingest-files', request),
  getSnapshot: () => ipcRenderer.invoke('dashboard:get-snapshot'),
  getBucketData: (bucket, query) => ipcRenderer.invoke('dashboard:get-bucket-data', bucket, query),
  runQuery: (query) => ipcRenderer.invoke('dashboard:run-query', query),
  getDossier: (entityId) => ipcRenderer.invoke('dashboard:get-dossier', entityId),
  getConnectionGraph: (focusId, bucket) => ipcRenderer.invoke('dashboard:get-connection-graph', focusId, bucket),
  runPhoenix: (request) => ipcRenderer.invoke('dashboard:run-phoenix', request),
  loadConfigFile: () => ipcRenderer.invoke('dashboard:load-config-file'),
  queryParcelCsv: (csvPath, targetParcel, maxSurrounding) =>
    ipcRenderer.invoke('dashboard:query-parcel-csv', csvPath, targetParcel, maxSurrounding)
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('rentSeeker', api)
} else {
  ;(window as Window & { rentSeeker?: DashboardApi }).rentSeeker = api
}
