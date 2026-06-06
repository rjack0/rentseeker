export type SourceType =
  | 'canonical_dataset'
  | 'imported_folder'
  | 'propstream_html'
  | 'sbf_materialized'
  | 'parcel_boundary_archive'
  | 'fallback_geometry'
  | 'derived_fact'

export interface SourceProvenance {
  datasetId: string
  datasetName: string
  sourceType: SourceType
  sourcePath?: string
  rawKey?: string
  normalizedKey?: string
  confidence?: number
  matchFields?: string[]
  normalizations?: string[]
  notes?: string
}

const ADDRESS_SUFFIXES: Array<[RegExp, string]> = [
  [/\bstreet\b/gi, 'st'],
  [/\broad\b/gi, 'rd'],
  [/\bavenue\b/gi, 'ave'],
  [/\bboulevard\b/gi, 'blvd'],
  [/\bdrive\b/gi, 'dr'],
  [/\blane\b/gi, 'ln'],
  [/\bcourt\b/gi, 'ct'],
  [/\bplace\b/gi, 'pl'],
  [/\bparkway\b/gi, 'pkwy'],
  [/\bterrace\b/gi, 'ter']
]

export function normalizeDigits(value: string | number | null | undefined): string {
  return String(value ?? '').replace(/[^0-9]/g, '')
}

export function normalizeAin(value: string | number | null | undefined): string {
  return normalizeDigits(value)
}

export function normalizeApn(value: string | number | null | undefined): string {
  return normalizeDigits(value)
}

export function normalizeOwnerName(value: string | null | undefined): string {
  const cleaned = String(value ?? '')
    .toLowerCase()
    .replace(/,/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(the|of|and|trust|trustee|et|al|family|living|revocable|irrevocable|trustee)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!cleaned) return ''
  return cleaned
    .split(' ')
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
    .join(' ')
}

export function normalizeAddress(value: string | null | undefined): string {
  let normalized = String(value ?? '')
    .toLowerCase()
    .replace(/[#.,/\\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) return ''

  for (const [pattern, replacement] of ADDRESS_SUFFIXES) {
    normalized = normalized.replace(pattern, replacement)
  }

  return normalized
    .replace(/\b(no|number)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function normalizedSourceKey(parts: Array<string | number | null | undefined>): string {
  return parts
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join('|')
}

export function sourceDatasetId(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'source'
}

export function sourceColor(input: string, palette: string[]): string {
  if (palette.length === 0) return '#94a3b8'
  let hash = 0
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash) + input.charCodeAt(i)
    hash |= 0
  }
  return palette[Math.abs(hash) % palette.length]
}

export function geometryFingerprint(geometry: Geometry | null | undefined): string {
  if (!geometry) return ''
  const roundNumber = (value: unknown): unknown => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return value
    return Number(value.toFixed(6))
  }
  const roundCoords = (value: any): any => {
    if (Array.isArray(value)) return value.map(roundCoords)
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value)) out[k] = roundCoords(v)
      return out
    }
    return roundNumber(value)
  }
  return JSON.stringify(roundCoords(geometry))
}
import type { Geometry } from 'geojson'
