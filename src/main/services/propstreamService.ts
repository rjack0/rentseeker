import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { readFile, stat } from 'fs/promises'
import { join, resolve } from 'path'
import { pathToFileURL } from 'url'

import type {
  ImportedDataFolder,
  PropstreamGridDataset,
  PropstreamGridPayload,
  PropstreamGridRecord,
  PropstreamGridSourceStat
} from '@shared/types'

const PROPSTREAM_ROOT = '/Users/rjack/Downloads/propstream data'
const PROPSTREAM_GRID_HTML = join(PROPSTREAM_ROOT, 'propstream-grid.html')
const PROPSTREAM_PALETTE = ['#00d4ff', '#abff02', '#ffde59', '#ff7a45', '#a78bfa', '#34d399', '#f472b6', '#94a3b8']

type RawPropstreamPayload = {
  records?: Array<Record<string, unknown>>
  sourceStats?: PropstreamGridSourceStat[]
}

function hashColor(input: string): string {
  const digest = createHash('sha1').update(input).digest()
  return PROPSTREAM_PALETTE[digest[0] % PROPSTREAM_PALETTE.length]
}

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'propstream'
}

function toOptionalNumber(value: unknown): number | '' {
  if (value === '' || value == null) return ''
  const numeric = typeof value === 'number'
    ? value
    : Number(String(value).replace(/[^0-9.-]/g, ''))
  return Number.isFinite(numeric) ? numeric : ''
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item ?? '').trim()).filter(Boolean)
}

function resolveImageUrl(imagePath: string): string {
  if (!imagePath) return ''
  const absolute = resolve(PROPSTREAM_ROOT, imagePath)
  return pathToFileURL(absolute).toString()
}

function normalizeRecord(raw: Record<string, unknown>): PropstreamGridRecord {
  const imagePath = String(raw.imagePath ?? '')
  return {
    address: String(raw.address ?? 'Address Unavailable'),
    value: String(raw.displayValue ?? ''),
    valueAmount: Number(raw.displayValueAmount ?? 0) || 0,
    valueLabel: String(raw.valueLabel ?? ''),
    beds: toOptionalNumber(raw.beds),
    baths: toOptionalNumber(raw.baths),
    sqft: toOptionalNumber(raw.sqft),
    lotSqft: toOptionalNumber(raw.lotSqft),
    estEquity: String(raw.estEquity ?? ''),
    estEquityAmount: Number(raw.estEquityAmount ?? 0) || 0,
    estLoanBalance: String(raw.estLoanBalance ?? ''),
    estLoanBalanceAmount: Number(raw.estLoanBalanceAmount ?? 0) || 0,
    lastSale: String(raw.lastSale ?? ''),
    lastSaleTimestamp: toOptionalNumber(raw.lastSaleTimestamp),
    imagePath,
    imageUrl: resolveImageUrl(imagePath),
    imageCount: Number(raw.imageCount ?? 0) || 0,
    propstreamUrl: String(raw.propstreamUrl ?? ''),
    propertyId: String(raw.propertyId ?? ''),
    searchLists: toStringArray(raw.searchLists),
    sourceFiles: toStringArray(raw.sourceFiles),
    sourceIndexes: toStringArray(raw.sourceIndexes),
    characteristics: String(raw.characteristics ?? '')
  }
}

function buildDatasets(records: PropstreamGridRecord[]): PropstreamGridDataset[] {
  const groups = new Map<string, { count: number; color: string }>()
  for (const record of records) {
    const datasets = record.searchLists.length > 0 ? record.searchLists : ['Unclassified']
    for (const name of datasets) {
      const current = groups.get(name) ?? { count: 0, color: hashColor(name) }
      current.count += 1
      groups.set(name, current)
    }
  }
  return [...groups.entries()]
    .map(([name, value]) => ({ name, color: value.color, count: value.count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

function buildSourceStats(sourceStats: PropstreamGridSourceStat[] | undefined, records: PropstreamGridRecord[]): PropstreamGridSourceStat[] {
  if (Array.isArray(sourceStats) && sourceStats.length > 0) {
    return sourceStats.map((item) => ({
      file: String(item.file ?? ''),
      cards: Number(item.cards ?? 0) || 0
    }))
  }

  const byFile = new Map<string, number>()
  for (const record of records) {
    for (const file of record.sourceFiles) {
      byFile.set(file, (byFile.get(file) ?? 0) + 1)
    }
  }
  return [...byFile.entries()].map(([file, cards]) => ({ file, cards }))
}

export class PropstreamService {
  private cachedMtimeMs = 0
  private cachedPayload: PropstreamGridPayload | null = null

  private async readRawPayload(): Promise<RawPropstreamPayload> {
    if (!existsSync(PROPSTREAM_GRID_HTML)) {
      throw new Error(`PropStream HTML export not found: ${PROPSTREAM_GRID_HTML}`)
    }

    const html = await readFile(PROPSTREAM_GRID_HTML, 'utf8')
    const match = html.match(/<script id="propstream-data" type="application\/json">([\s\S]*?)<\/script>/i)
    if (!match) {
      throw new Error('Unable to locate embedded PropStream payload in propstream-grid.html')
    }

    const parsed = JSON.parse(match[1]) as RawPropstreamPayload
    const records = Array.isArray(parsed.records) ? parsed.records.map(normalizeRecord) : []
    const sourceStats = buildSourceStats(parsed.sourceStats, records)
    const datasets = buildDatasets(records)
    const payload: PropstreamGridPayload = {
      sourcePath: PROPSTREAM_GRID_HTML,
      totalCards: sourceStats.reduce((sum, item) => sum + item.cards, 0),
      uniqueProperties: records.length,
      datasets,
      sourceStats,
      records
    }

    const fileStat = await stat(PROPSTREAM_GRID_HTML)
    this.cachedMtimeMs = fileStat.mtimeMs
    this.cachedPayload = payload
    return parsed
  }

  async getGridData(): Promise<PropstreamGridPayload> {
    if (this.cachedPayload) {
      const fileStat = await stat(PROPSTREAM_GRID_HTML).catch(() => null)
      if (fileStat && fileStat.mtimeMs === this.cachedMtimeMs) {
        return this.cachedPayload
      }
    }

    const raw = await this.readRawPayload()
    const records = Array.isArray(raw.records) ? raw.records.map(normalizeRecord) : []
    const datasets = buildDatasets(records)
    const sourceStats = buildSourceStats(raw.sourceStats, records)
    const payload: PropstreamGridPayload = {
      sourcePath: PROPSTREAM_GRID_HTML,
      totalCards: sourceStats.reduce((sum, item) => sum + item.cards, 0),
      uniqueProperties: records.length,
      datasets,
      sourceStats,
      records
    }
    const fileStat = await stat(PROPSTREAM_GRID_HTML)
    this.cachedMtimeMs = fileStat.mtimeMs
    this.cachedPayload = payload
    return payload
  }

  async syncFolders(): Promise<ImportedDataFolder[]> {
    const payload = await this.getGridData()
    return payload.datasets.map((dataset) => ({
      folderPath: `propstream://${slugify(dataset.name)}`,
      label: dataset.name,
      color: dataset.color,
      fileCount: 1,
      byteSize: 0,
      rowCount: dataset.count,
      importedAt: new Date().toISOString()
    }))
  }
}

export const propstreamService = new PropstreamService()
