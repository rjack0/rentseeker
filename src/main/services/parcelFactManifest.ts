import type { ParcelFactSourceManifestEntry } from '@shared/types'
import type { SourceType } from '@shared/sourceRegistry'

function norm(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const manifest: ParcelFactSourceManifestEntry[] = [
  {
    factLabel: 'Owner Record (SBF)',
    aliases: ['owner record', 'sbf owner', 'secured basic file', 'owner'],
    datasetCandidates: ['secured basic file', 'sbf', 'owner records'],
    sourceFields: ['AIN', 'First Owner Name', 'Mail Address', 'Sale Amount', 'Acres'],
    normalizations: ['AIN digits normalization', 'owner-name normalization', 'mailing address normalization'],
    sourceType: 'sbf_materialized',
    confidence: 'High',
    notes: 'Primary ownership truth source keyed by AIN.'
  },
  {
    factLabel: 'Total Value',
    aliases: ['total value', 'taxable value', 'land value', 'improvement value'],
    datasetCandidates: ['la county assessor parcels', 'assessor parcels', 'parcel data'],
    sourceFields: ['Total Value', 'Taxable Value', 'Land Value', 'Improvement Value'],
    normalizations: ['AIN/APN digits normalization', 'latest roll year per assessor id'],
    sourceType: 'canonical_dataset',
    confidence: 'High'
  },
  {
    factLabel: 'CofO Number',
    aliases: ['cofo number', 'certificate of occupancy', 'cofo'],
    datasetCandidates: ['certificate of occupancy'],
    sourceFields: ['cofo_number', 'assessor book/page/parcel'],
    normalizations: ['assessor book/page/parcel normalization', 'APN digits normalization'],
    sourceType: 'canonical_dataset',
    confidence: 'High'
  },
  {
    factLabel: 'Building Permits',
    aliases: ['building permits', 'latest building permit', 'building status', 'building work'],
    datasetCandidates: ['building permits 2020+', 'building permits issued', 'building permits'],
    sourceFields: ['apn', 'permit_nbr', 'status_desc', 'work_desc', 'valuation'],
    normalizations: ['APN digits normalization (remove hyphens)', 'permit numbers aggregated per APN'],
    sourceType: 'canonical_dataset',
    confidence: 'Medium-High'
  },
  {
    factLabel: 'Electrical Permits',
    aliases: ['electrical permits', 'latest electrical permit', 'electrical status', 'electrical work'],
    datasetCandidates: ['electrical permits 2020+', 'electrical permits issued'],
    sourceFields: ['apn', 'permit_nbr', 'status_desc', 'work_desc'],
    normalizations: ['APN digits normalization (remove hyphens)', 'permit numbers aggregated per APN'],
    sourceType: 'canonical_dataset',
    confidence: 'Medium-High'
  },
  {
    factLabel: 'Submitted Building Permits',
    aliases: ['submitted building permits', 'latest submitted permit', 'submitted status', 'submitted work'],
    datasetCandidates: ['building permits submitted'],
    sourceFields: ['apn', 'permit_nbr', 'status_desc', 'work_desc'],
    normalizations: ['APN digits normalization', 'submission records normalized to APN'],
    sourceType: 'canonical_dataset',
    confidence: 'Medium-High'
  },
  {
    factLabel: 'Inspections',
    aliases: ['inspection', 'latest inspection', 'inspection result', 'inspection type'],
    datasetCandidates: ['inspections'],
    sourceFields: ['apn', 'permit_nbr', 'inspection_type', 'status_desc'],
    normalizations: ['APN digits normalization', 'permit number join to inspection rows'],
    sourceType: 'canonical_dataset',
    confidence: 'Medium-High'
  },
  {
    factLabel: 'Terrain',
    aliases: ['terrain', 'slope', 'relief', 'aspect', 'pad candidates', 'driveway grade', 'retaining wall'],
    datasetCandidates: ['parcel terrain metrics', 'terrain engine'],
    sourceFields: ['parcel_terrain_metrics', 'parcel_terrain_products', 'parcel geometry'],
    normalizations: ['parcel geometry hash', 'elevation samples clipped to parcel polygon'],
    sourceType: 'derived_fact',
    confidence: 'Medium'
  },
  {
    factLabel: 'Sun',
    aliases: ['sun', 'sunrise', 'sunset', 'daylight'],
    datasetCandidates: ['parcel sun analysis', 'sun simulator'],
    sourceFields: ['parcel_sun_analysis', 'solar position', 'terrain samples'],
    normalizations: ['date normalized to YYYY-MM-DD', 'parcel geometry hash'],
    sourceType: 'derived_fact',
    confidence: 'Medium'
  },
  {
    factLabel: 'View',
    aliases: ['view', 'view score', 'max view', 'visible landmarks'],
    datasetCandidates: ['parcel view analysis', 'view analysis'],
    sourceFields: ['parcel_view_analysis', 'landmark catalog', 'terrain samples'],
    normalizations: ['stories converted to viewer height', 'parcel geometry hash', '360-degree ray sweep'],
    sourceType: 'derived_fact',
    confidence: 'Medium'
  },
  {
    factLabel: 'SB79',
    aliases: ['eligible', 'tier', 'nearest transit distance'],
    datasetCandidates: ['parcel_sb79'],
    sourceFields: ['eligible', 'nearest_stop_name', 'distance_to_stop_ft', 'tier', 'band'],
    normalizations: ['nearest transit anchor lookup', 'distance feet normalization'],
    sourceType: 'derived_fact',
    confidence: 'Medium'
  }
]

export function getParcelFactSourceManifest(): ParcelFactSourceManifestEntry[] {
  return manifest.map((entry) => ({
    ...entry,
    aliases: [...entry.aliases],
    datasetCandidates: [...entry.datasetCandidates],
    sourceFields: [...entry.sourceFields],
    normalizations: [...entry.normalizations]
  }))
}

export function resolveParcelFactSourceManifestEntry(label: string): ParcelFactSourceManifestEntry | null {
  const normalized = norm(label)
  const exact = manifest.find((entry) => norm(entry.factLabel) === normalized)
  if (exact) return exact
  const alias = manifest.find((entry) => entry.aliases.some((candidate) => norm(candidate) === normalized || normalized.includes(norm(candidate))))
  return alias ?? null
}

export function manifestSourceTypes(): SourceType[] {
  return [...new Set(manifest.map((entry) => entry.sourceType))]
}
