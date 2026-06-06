import { app } from 'electron'
import { createHash } from 'crypto'
import { existsSync, statSync } from 'fs'
import { mkdir, readFile, readdir, writeFile } from 'fs/promises'
import { basename, extname, join, resolve } from 'path'

import type {
  DataLoadStep,
  DataLoadProgress,
  PropstreamGridPayload,
  SourceRegistryEntry
} from '@shared/types'
import { sourceDatasetId } from '@shared/sourceRegistry'

type SbfConversionState = {
  running: boolean
  startedAt: number
  lastError?: string
}

type CustomDataFolderRecord = {
  folderPath: string
  label: string
  color: string
  fileCount: number
  byteSize: number
  rowCount: number
  importedAt: string
  kind?: 'path' | 'propstream'
  sourceType?: SourceRegistryEntry['sourceType']
}

type WorkspaceIngestResult = {
  datasets: Array<{ sourcePath: string; rows?: number }>
  summary?: string
}

type DataRegistryDeps = {
  workspace: {
    initialize(): Promise<void>
    ingestFiles(paths: string[]): Promise<WorkspaceIngestResult>
  }
  rentSeekerStore: {
    recordSourceStep(step: DataLoadStep & { sourcePath?: string; datasetId?: string }): Promise<void>
    getSourceRegistryEntries(): Promise<DataLoadStep[]>
  }
  propstreamService: {
    getGridData(): Promise<PropstreamGridPayload>
    syncFolders(): Promise<CustomDataFolderRecord[]>
  }
  sbfConversionState: SbfConversionState
}

const DATA_FOLDER_STATE_FILE = () => resolve(app.getPath('userData'), 'data-folders.json')
const SUPPORTED_IMPORT_EXTENSIONS = new Set(['.csv', '.tsv', '.json', '.xlsx', '.xls', '.geojson'])
const CUSTOM_FOLDER_PALETTE = ['#00d4ff', '#abff02', '#ffde59', '#ff7a45', '#a78bfa', '#34d399', '#f472b6', '#94a3b8']

const canonicalDataManifest = [
  {
    datasetName: 'LA County Assessor Parcels',
    color: '#00d4ff',
    path: '/Users/rjack/Desktop/almanac/Docs/RE Data/Parcel_Data_0 2.csv',
    estimatedRows: 2400000,
    sourceType: 'canonical_dataset' as const
  },
  {
    datasetName: 'Secured Basic File (SBF)',
    color: '#e8c547',
    path: '/Users/rjack/Desktop/almanac/Docs/RE Data/SBF Secured Basic File LA County Assessor Abstract/sbf_part1.csv',
    estimatedRows: 880000,
    sourceType: 'sbf_materialized' as const
  },
  {
    datasetName: 'Certificate of Occupancy',
    color: '#ff6b35',
    path: '/Users/rjack/Desktop/almanac/Docs/RE Data/Building_and_Safety_Certificate_of_Occupancy_20260404.csv',
    estimatedRows: 150000,
    sourceType: 'canonical_dataset' as const
  },
  {
    datasetName: 'Building Permits 2020+',
    color: '#a78bfa',
    path: '/Users/rjack/Desktop/almanac/Docs/RE Data/Building_and_Safety_-_Building_Permits_Issued_from_2020_to_Present_(N)_20260417.csv',
    estimatedRows: 850000,
    sourceType: 'canonical_dataset' as const
  },
  {
    datasetName: 'Electrical Permits 2020+',
    color: '#34d399',
    path: '/Users/rjack/Desktop/almanac/Docs/RE Data/Building_and_Safety_-_Electrical_Permits_Issued_from_2020_to_Present_(N)_20260417.csv',
    estimatedRows: 650000,
    sourceType: 'canonical_dataset' as const
  },
  {
    datasetName: 'Building Permits Submitted',
    color: '#f472b6',
    path: '/Users/rjack/Desktop/almanac/Docs/RE Data/Building_and_Safety_-_Building_Permits_Submitted_from_2020_to_Present_(N)_20260417.csv',
    estimatedRows: 550000,
    sourceType: 'canonical_dataset' as const
  },
  {
    datasetName: 'Inspections',
    color: '#94a3b8',
    path: '/Users/rjack/Desktop/almanac/Docs/RE Data/Building_and_Safety_Inspections_20260417.csv',
    estimatedRows: 4000000,
    sourceType: 'canonical_dataset' as const
  },
  {
    datasetName: 'Parcel Boundary Lines',
    color: '#00ffc8',
    path: '/Users/rjack/Desktop/almanac/Docs/RE Data/parcel_geojson/LACounty_Parcels.pmtiles',
    estimatedRows: 2400000,
    sourceType: 'parcel_boundary_archive' as const
  }
]

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
        kind: (item.kind === 'propstream' ? 'propstream' : 'path') as 'path' | 'propstream',
        sourceType: (String(item.sourceType ?? '').includes('propstream')
          ? 'propstream_html'
          : String(item.sourceType ?? '').includes('boundary')
            ? 'parcel_boundary_archive'
            : 'imported_folder') as SourceRegistryEntry['sourceType']
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

function datasetIdForFolder(folderPath: string): string {
  return folderPath.startsWith('propstream://')
    ? `propstream_${createHash('sha1').update(folderPath).digest('hex').slice(0, 10)}`
    : `custom_folder_${createHash('sha1').update(folderPath).digest('hex').slice(0, 10)}`
}

function buildFolderStep(
  folder: CustomDataFolderRecord,
  elapsedMs: number,
  rowCount = folder.rowCount
): DataLoadStep & { sourcePath?: string; datasetId?: string } {
  const label = folder.label || labelFromFolderPath(folder.folderPath)
  const datasetId = datasetIdForFolder(folder.folderPath)
  const sourceType = folder.sourceType ?? (folder.folderPath.startsWith('propstream://') ? 'propstream_html' : 'imported_folder')
  const normalizedKey = sourceDatasetId(label)
  const confidence = folder.folderPath.startsWith('propstream://') ? 0.92 : 0.85
  return {
    datasetName: `Folder: ${label}`,
    color: folder.color || hashToPaletteColor(folder.folderPath),
    status: folder.folderPath.startsWith('propstream://') || existsSync(folder.folderPath)
      ? 'done'
      : 'error',
    rowCount,
    elapsedMs,
    byteSize: folder.folderPath.startsWith('propstream://') ? 0 : folder.byteSize,
    sourcePath: folder.folderPath,
    datasetId,
    sourceType,
    rawKey: folder.folderPath,
    normalizedKey,
    confidence,
    provenance: {
      datasetId,
      datasetName: `Folder: ${label}`,
      sourceType,
      sourcePath: folder.folderPath,
      rawKey: folder.folderPath,
      normalizedKey,
      confidence,
      normalizations: folder.folderPath.startsWith('propstream://')
        ? ['PropStream HTML payload grouped by searchLists']
        : ['Imported folder scan']
    },
    errorMsg: folder.folderPath.startsWith('propstream://') || existsSync(folder.folderPath) ? undefined : 'Folder not found'
  } as DataLoadStep & { sourcePath?: string; datasetId?: string }
}

function buildManifestStep(
  item: typeof canonicalDataManifest[number],
  started: number,
  sbfConversionState: SbfConversionState
): DataLoadStep & { sourcePath?: string; datasetId?: string } {
  let exists = existsSync(item.path)
  let bytes = exists ? statSync(item.path).size : 0

  if (item.datasetName.includes('(SBF)')) {
    const dir = '/Users/rjack/Desktop/almanac/Docs/RE Data/SBF Secured Basic File LA County Assessor Abstract'
    const parts = ['sbf_part1.csv', 'sbf_part2.csv', 'sbf_part3.csv'].map((name) => join(dir, name))
    exists = parts.every((p) => existsSync(p))
    bytes = exists ? parts.reduce((sum, p) => sum + statSync(p).size, 0) : 0
  }

  const datasetId = sourceDatasetId(item.datasetName)
  const normalizedKey = item.datasetName.includes('Parcel') ? 'parcel-boundary' : sourceDatasetId(item.datasetName)
  return {
    sourcePath: item.path,
    datasetId,
    datasetName: item.datasetName,
    color: item.color,
    sourceType: item.sourceType,
    status: sbfConversionState.running && item.datasetName.includes('(SBF)')
      ? 'loading'
      : (exists ? 'done' : 'error'),
    rowCount: exists ? item.estimatedRows : 0,
    elapsedMs: Date.now() - started,
    byteSize: bytes,
    normalizedKey,
    rawKey: item.path,
    confidence: exists ? 0.95 : 0,
    provenance: {
      datasetId,
      datasetName: item.datasetName,
      sourceType: item.sourceType,
      sourcePath: item.path,
      rawKey: item.path,
      normalizedKey,
      confidence: exists ? 0.95 : 0,
      normalizations: item.datasetName.includes('SBF') ? ['CSV materialization from xlsx parts'] : ['Canonical dataset manifest'],
      notes: item.datasetName.includes('SBF') ? 'SBF readiness requires all three CSV parts.' : undefined
    },
    errorMsg: exists ? undefined : (sbfConversionState.running && item.datasetName.includes('(SBF)') ? undefined : 'File not found')
  } as DataLoadStep & { sourcePath?: string; datasetId?: string }
}

export function createDataRegistryService(deps: DataRegistryDeps) {
  const { workspace, rentSeekerStore, propstreamService, sbfConversionState } = deps

  async function getDataLoadProgress(): Promise<DataLoadProgress> {
    const started = Date.now()
    const customFolders = await readCustomFolderRegistry()
    const manifestSteps = canonicalDataManifest.map((item) => buildManifestStep(item, started, sbfConversionState))
    const customEntries = customFolders.map((folder) => buildFolderStep(folder, Date.now() - started))
    const allEntries = [...manifestSteps, ...customEntries]
    await Promise.allSettled(allEntries.map((entry) => rentSeekerStore.recordSourceStep(entry)))
    const steps = await rentSeekerStore.getSourceRegistryEntries()
    const done = steps.filter((step) => step.status === 'done').length
    return {
      steps,
      totalRows: steps.reduce((sum, step) => sum + step.rowCount, 0),
      overallPct: steps.length === 0 ? 0 : (done / steps.length) * 100
    }
  }

  async function importDataPaths(paths: string[]): Promise<{ datasets: WorkspaceIngestResult['datasets']; folders: CustomDataFolderRecord[]; skippedPaths: string[] }> {
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
        importedAt: now,
        kind: 'path',
        sourceType: 'imported_folder'
      }
      if (existingIndex >= 0) merged[existingIndex] = next
      else merged.push(next)
    }
    await writeCustomFolderRegistry(merged)
    await Promise.allSettled(merged.map((folder) => rentSeekerStore.recordSourceStep(buildFolderStep(folder, 0))))

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
        kind: 'propstream',
        sourceType: 'propstream_html'
      }
      const existingIndex = merged.findIndex((item) => item.folderPath === folder.folderPath)
      if (existingIndex >= 0) merged[existingIndex] = next
      else merged.push(next)
    }

    await writeCustomFolderRegistry(merged)
    await Promise.allSettled(
      merged
        .filter((item) => item.folderPath.startsWith('propstream://'))
        .map((folder) => rentSeekerStore.recordSourceStep(buildFolderStep(folder, 0)))
    )
    return { payload, folders: merged }
  }

  return {
    getDataLoadProgress,
    importDataPaths,
    syncPropstreamFolders
  }
}
