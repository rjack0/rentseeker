import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import type { DashboardApi, DataLoadProgress } from '@shared/types'

const api: DashboardApi = {
  pickImportFiles: () => ipcRenderer.invoke('dashboard:pick-import-files'),
  pickImportFolder: () => ipcRenderer.invoke('dashboard:pick-import-folder'),
  ingestFiles: (request) => ipcRenderer.invoke('dashboard:ingest-files', request),
  ingestDataPaths: (request) => ipcRenderer.invoke('dashboard:ingest-data-paths', request),
  getSnapshot: () => ipcRenderer.invoke('dashboard:get-snapshot'),
  getBucketData: (bucket, query) => ipcRenderer.invoke('dashboard:get-bucket-data', bucket, query),
  runQuery: (query) => ipcRenderer.invoke('dashboard:run-query', query),
  getDossier: (entityId) => ipcRenderer.invoke('dashboard:get-dossier', entityId),
  getConnectionGraph: (focusId, bucket) => ipcRenderer.invoke('dashboard:get-connection-graph', focusId, bucket),
  runPhoenix: (request) => ipcRenderer.invoke('dashboard:run-phoenix', request),
  loadConfigFile: () => ipcRenderer.invoke('dashboard:load-config-file'),
  queryParcelCsv: (csvPath, targetParcel, maxSurrounding) =>
    ipcRenderer.invoke('dashboard:query-parcel-csv', csvPath, targetParcel, maxSurrounding),
  queryParcelFiltered: (filter) =>
    ipcRenderer.invoke('dashboard:query-parcel-filtered', filter),
  countParcels: (filter) =>
    ipcRenderer.invoke('dashboard:count-parcels', filter),
  /* Phase 2: Terrain, Sun, View, Build APIs */
  getTerrainMetrics: (parcelId, lat, lng, lotSqft, geometry) =>
    ipcRenderer.invoke('dashboard:get-terrain-metrics', parcelId, lat, lng, lotSqft, geometry),
  getTerrainProduct: (parcelId) =>
    ipcRenderer.invoke('dashboard:get-terrain-product', parcelId),
  getSlopeAtPoint: (lat, lng) =>
    ipcRenderer.invoke('dashboard:get-slope-at-point', lat, lng),
  getSunAnalysis: (parcelId, lat, lng, date) =>
    ipcRenderer.invoke('dashboard:get-sun-analysis', parcelId, lat, lng, date),
  getViewAnalysis: (parcelId, lat, lng, stories) =>
    ipcRenderer.invoke('dashboard:get-view-analysis', parcelId, lat, lng, stories),
  runBuildSimulation: (input, lat, lng, lotSqft) =>
    ipcRenderer.invoke('dashboard:run-build-simulation', input, lat, lng, lotSqft),
  getBuildRunsForParcel: (parcelId) =>
    ipcRenderer.invoke('dashboard:get-build-runs-for-parcel', parcelId),
  getParcelPolygons: (north, south, east, west, limit) =>
    ipcRenderer.invoke('dashboard:get-parcel-polygons', north, south, east, west, limit),
  getParcelPolygonByAin: (ain) =>
    ipcRenderer.invoke('dashboard:get-parcel-polygon-by-ain', ain),
  getParcelBoundaryTiles: (bounds, zoom) =>
    ipcRenderer.invoke('dashboard:get-parcel-boundary-tiles', bounds, zoom),
  countParcelBoundaries: (bounds) =>
    ipcRenderer.invoke('dashboard:count-parcel-boundaries', bounds),
  getParcelByPoint: (lng, lat) =>
    ipcRenderer.invoke('dashboard:get-parcel-by-point', lng, lat),
  getParcelsInBounds: (bounds, limit) =>
    ipcRenderer.invoke('dashboard:get-parcels-in-bounds', bounds, limit),
  getSqftCheck: (parcelId, ain, assessorSqft) =>
    ipcRenderer.invoke('dashboard:get-sqft-check', parcelId, ain, assessorSqft),
  gdbAvailable: () => ipcRenderer.invoke('dashboard:gdb-available'),
  getParcelPmtilesInfo: () => ipcRenderer.invoke('dashboard:get-parcel-pmtiles-info'),
  getParcelPmtilesTile: (z, x, y) => ipcRenderer.invoke('dashboard:get-parcel-pmtiles-tile', z, x, y),
  getParcelPmtilesStats: () => ipcRenderer.invoke('dashboard:get-parcel-pmtiles-stats'),
  resetParcelPmtilesStats: () => ipcRenderer.invoke('dashboard:reset-parcel-pmtiles-stats'),
  getParcelPmtilesHttpBase: () => ipcRenderer.invoke('dashboard:get-parcel-pmtiles-http-base'),
  convertSbfXlsxToCsv: () => ipcRenderer.invoke('dashboard:convert-sbf-xlsx-to-csv'),
  getOwnerByAin: (ain) => ipcRenderer.invoke('dashboard:get-owner-by-ain', ain),
  prepareOwnerIndex: () => ipcRenderer.invoke('dashboard:prepare-owner-index'),
  getOwnerPortfolio: (ownerName, limit) =>
    ipcRenderer.invoke('dashboard:get-owner-portfolio', ownerName, limit),
  getTopOwners: (sortBy, limit) => ipcRenderer.invoke('dashboard:get-top-owners', sortBy, limit),
  getHeatMapData: (resolution) => ipcRenderer.invoke('dashboard:get-heat-map-data', resolution),
  getDistributions: () => ipcRenderer.invoke('dashboard:get-distributions'),
  searchOwners: (query, limit) => ipcRenderer.invoke('dashboard:search-owners', query, limit),
  getDataLoadProgress: () => ipcRenderer.invoke('dashboard:get-data-load-progress'),
  getPropstreamGridData: () => ipcRenderer.invoke('dashboard:get-propstream-grid-data'),
  syncPropstreamFolders: () => ipcRenderer.invoke('dashboard:sync-propstream-folders'),
  captureMainWindow: () => ipcRenderer.invoke('dashboard:capture-main-window'),
  onDataLoadProgress: (callback) => {
    const listener = (_event: IpcRendererEvent, progress: DataLoadProgress) => callback(progress)
    ipcRenderer.on('dashboard:data-load-progress', listener)
    return () => ipcRenderer.removeListener('dashboard:data-load-progress', listener)
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('rentSeeker', api)
} else {
  ;(window as Window & { rentSeeker?: DashboardApi }).rentSeeker = api
}
