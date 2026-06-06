import type { ParcelDossierProvenance, ParcelFactProvenance, ParcelRecord } from '@shared/types'
import { normalizeAddress, normalizeAin, normalizeApn, normalizeOwnerName, sourceDatasetId, type SourceType } from '@shared/sourceRegistry'
import { getParcelFactSourceManifest as loadParcelFactSourceManifest, resolveParcelFactSourceManifestEntry } from './parcelFactManifest'

type SourceRegistryLookup = {
  getSourceRegistryEntries(): Promise<Array<{
    datasetName: string
    sourceType?: SourceType
    sourcePath?: string
    rawKey?: string
    normalizedKey?: string
    confidence?: number
    provenance?: {
      datasetId?: string
      datasetName?: string
      sourceType?: SourceType
      sourcePath?: string
      sourceFields?: string[]
      matchFields?: string[]
      rawKey?: string
      normalizedKey?: string
      confidence?: number
      normalizations?: string[]
      notes?: string
    }
  }>>
}

type RegistryEntry = Awaited<ReturnType<SourceRegistryLookup['getSourceRegistryEntries']>>[number]

function normalizeDatasetLabel(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function confidenceLabel(score: number): ParcelFactProvenance['confidence'] {
  if (score >= 0.95) return 'High'
  if (score >= 0.85) return 'Medium-High'
  if (score >= 0.65) return 'Medium'
  return 'Low'
}

function confidenceScoreForType(sourceType: SourceType, fallback = 0.85): number {
  switch (sourceType) {
    case 'sbf_materialized':
      return 0.98
    case 'parcel_boundary_archive':
      return 0.97
    case 'canonical_dataset':
      return 0.94
    case 'imported_folder':
      return 0.84
    case 'propstream_html':
      return 0.92
    case 'derived_fact':
      return 0.88
    case 'fallback_geometry':
      return 0.55
    default:
      return fallback
  }
}

function registryEntryToFact(
  factLabel: string,
  entry: RegistryEntry | undefined,
  sourceFields: string[],
  rawKey: string,
  normalizedKey: string,
  normalizations: string[],
  notes?: string,
  sourceTypeOverride?: SourceType
): ParcelFactProvenance {
  const provenance = entry?.provenance
  const datasetName = provenance?.datasetName ?? entry?.datasetName ?? factLabel
  const sourceType = sourceTypeOverride ?? provenance?.sourceType ?? entry?.sourceType ?? 'derived_fact'
  const datasetId = provenance?.datasetId ?? sourceDatasetId(datasetName)
  const sourcePath = provenance?.sourcePath ?? entry?.sourcePath
  const confidence = provenance?.confidence ?? entry?.confidence ?? confidenceScoreForType(sourceType)
  return {
    factLabel,
    datasetId,
    datasetName,
    sourceType,
    sourcePath,
    sourceFields,
    rawKey,
    normalizedKey,
    matchKey: `${datasetName} :: ${normalizedKey}`,
    normalizations,
    confidence: confidenceLabel(confidence),
    notes: notes ?? provenance?.notes
  }
}

function manifestAwareFields(label: string, fallback: string[]): string[] {
  const spec = resolveParcelFactSourceManifestEntry(label)
  if (!spec) return fallback
  return spec.sourceFields.length > 0 ? [...spec.sourceFields] : fallback
}

function findEntry(entries: RegistryEntry[], candidates: string[], sourceTypes: SourceType[] = []): RegistryEntry | undefined {
  const normalizedCandidates = candidates.map(normalizeDatasetLabel).filter(Boolean)
  for (const entry of entries) {
    const entryName = normalizeDatasetLabel(entry.provenance?.datasetName ?? entry.datasetName)
    const entryType = entry.provenance?.sourceType ?? entry.sourceType
    if (sourceTypes.length > 0 && !sourceTypes.includes(entryType ?? 'derived_fact')) continue
    if (normalizedCandidates.some((candidate) => entryName === candidate || entryName.includes(candidate) || candidate.includes(entryName))) {
      return entry
    }
  }
  if (sourceTypes.length > 0) {
    const byType = entries.find((entry) => sourceTypes.includes(entry.provenance?.sourceType ?? entry.sourceType ?? 'derived_fact'))
    if (byType) return byType
  }
  return undefined
}

function buildAssessorFact(parcel: ParcelRecord, entry: RegistryEntry | undefined, factLabel: string, sourceFields: string[]): ParcelFactProvenance {
  const manifestFields = manifestAwareFields(factLabel, sourceFields)
  const ain = normalizeAin(parcel.ain || parcel.assessorId)
  const apn = normalizeApn(parcel.assessorId)
  const address = normalizeAddress(parcel.propertyLocation || `${parcel.addressHouseNumber ?? ''} ${parcel.street ?? ''}`.trim())
  return registryEntryToFact(
    factLabel,
    entry,
    manifestFields,
    `${parcel.assessorId}`,
    `AIN ${ain || 'unknown'} | APN ${apn || 'unknown'}${address ? ` | ${address}` : ''}`,
    ['AIN digits normalization', 'APN digits normalization', 'situs address normalization'],
    'Assessor parcel source fields cross-referenced with parcel identity graph.',
    entry?.sourceType ?? 'canonical_dataset'
  )
}

function buildCofoFact(parcel: ParcelRecord, entry: RegistryEntry | undefined, factLabel: string, sourceFields: string[]): ParcelFactProvenance {
  const manifestFields = manifestAwareFields(factLabel, sourceFields)
  const ain = normalizeAin(parcel.ain || parcel.assessorId)
  const apn = normalizeApn(parcel.assessorId)
  const bookPageParcel = parcel.cofoNumber ? `COFO ${parcel.cofoNumber}` : `AIN ${ain || 'unknown'} | APN ${apn || 'unknown'}`
  return registryEntryToFact(
    factLabel,
    entry,
    manifestFields,
    parcel.cofoNumber || parcel.assessorId,
    bookPageParcel,
    ['AIN digits normalization', 'Book/Page/Parcel cross-reference where present'],
    'Certificate of Occupancy cross-reference is keyed to parcel identity and source permit records.',
    entry?.sourceType ?? 'canonical_dataset'
  )
}

function buildPermitFact(
  parcel: ParcelRecord,
  entry: RegistryEntry | undefined,
  factLabel: string,
  sourceFields: string[],
  permitKey: string,
  permitKind: 'building_permit' | 'electrical_permit' | 'building_permit_submitted' | 'inspection'
): ParcelFactProvenance {
  const manifestFields = manifestAwareFields(factLabel, sourceFields)
  const ain = normalizeAin(parcel.ain || parcel.assessorId)
  const apn = normalizeApn(parcel.assessorId)
  return registryEntryToFact(
    factLabel,
    entry,
    manifestFields,
    permitKey,
    `${permitKind} :: AIN ${ain || 'unknown'} | APN ${apn || 'unknown'}`,
    ['APN digits normalization', 'permit number exact match', 'parcel identity backstop'],
    `Permit provenance is traced through the ${permitKind.replace(/_/g, ' ')} dataset and parcel APN/AIN.`,
    entry?.sourceType ?? 'canonical_dataset'
  )
}

function buildDerivedFact(
  parcel: ParcelRecord,
  factLabel: string,
  sourceFields: string[],
  normalizations: string[],
  notes: string,
  sourceType: SourceType = 'derived_fact'
): ParcelFactProvenance {
  const manifestFields = manifestAwareFields(factLabel, sourceFields)
  const ain = normalizeAin(parcel.ain || parcel.assessorId)
  const apn = normalizeApn(parcel.assessorId)
  const address = normalizeAddress(parcel.propertyLocation || `${parcel.addressHouseNumber ?? ''} ${parcel.street ?? ''}`.trim())
  const ownerName = normalizeOwnerName(parcel.contractorName || '')
  return registryEntryToFact(
    factLabel,
    undefined,
    manifestFields,
    `${parcel.assessorId}:${factLabel}`,
    `${factLabel} :: AIN ${ain || 'unknown'} | APN ${apn || 'unknown'}${address ? ` | ${address}` : ''}${ownerName ? ` | ${ownerName}` : ''}`,
    normalizations,
    notes,
    sourceType
  )
}

function buildTerrainFact(parcel: ParcelRecord, factLabel: string): ParcelFactProvenance {
  return buildDerivedFact(
    parcel,
    factLabel,
    ['parcel_terrain_metrics', 'parcel_terrain_products', 'parcel geometry'],
    ['parcel geometry hash', 'elevation samples clipped to parcel polygon', 'persisted terrain products'],
    'Terrain provenance is derived from the parcel geometry hash and persisted terrain analysis outputs.',
    'derived_fact'
  )
}

function buildSunFact(parcel: ParcelRecord, factLabel: string): ParcelFactProvenance {
  return buildDerivedFact(
    parcel,
    factLabel,
    ['parcel_sun_analysis', 'solar position', 'terrain samples'],
    ['date normalized to YYYY-MM-DD', 'parcel geometry hash', 'terrain obstruction sampling'],
    'Sun provenance is derived from the persisted solar analysis for the selected parcel.',
    'derived_fact'
  )
}

function buildViewFact(parcel: ParcelRecord, factLabel: string): ParcelFactProvenance {
  return buildDerivedFact(
    parcel,
    factLabel,
    ['parcel_view_analysis', 'landmark catalog', 'terrain samples'],
    ['stories converted to viewer height', 'parcel geometry hash', '360-degree ray sweep'],
    'View provenance is derived from the persisted viewshed analysis for the selected parcel.',
    'derived_fact'
  )
}

function buildOwnerFact(parcel: ParcelRecord, entry?: RegistryEntry): ParcelFactProvenance {
  const ain = normalizeAin(parcel.ain || parcel.assessorId)
  return registryEntryToFact(
    'Owner Record (SBF)',
    entry,
    ['AIN', 'First Owner Name', 'Mail Address', 'Sale Amount', 'Acres'],
    `AIN ${ain || 'unknown'}`,
    `AIN ${ain || 'unknown'} | SBF owner index`,
    ['AIN digits normalization', 'owner-name normalization', 'mailing address normalization'],
    'Owner provenance is resolved through the SBF owner index keyed by AIN.',
    'sbf_materialized'
  )
}

function pickSourceEntries(entries: RegistryEntry[]) {
  return {
    assessor: findEntry(entries, ['la county assessor parcels', 'assessor parcels', 'parcel data'], ['canonical_dataset']),
    sbf: findEntry(entries, ['secured basic file', 'sbf', 'owner records'], ['sbf_materialized', 'canonical_dataset']),
    cofo: findEntry(entries, ['certificate of occupancy', 'c of o'], ['canonical_dataset']),
    building: findEntry(entries, ['building permits 2020+', 'building permits issued', 'building permits'], ['canonical_dataset']),
    electrical: findEntry(entries, ['electrical permits 2020+', 'electrical permits issued', 'electrical permits'], ['canonical_dataset']),
    submitted: findEntry(entries, ['building permits submitted', 'submitted permits'], ['canonical_dataset']),
    inspections: findEntry(entries, ['inspections'], ['canonical_dataset']),
    boundaries: findEntry(entries, ['parcel boundary lines', 'lacounty parcels', 'parcel polygons'], ['parcel_boundary_archive', 'canonical_dataset'])
  }
}

export async function getParcelDossierProvenance(
  parcel: ParcelRecord,
  store: SourceRegistryLookup
): Promise<ParcelDossierProvenance> {
  const entries = await store.getSourceRegistryEntries().catch(() => [])
  const sources = pickSourceEntries(entries)

  const facts: Record<string, ParcelFactProvenance> = {
    'Total Value': buildAssessorFact(parcel, sources.assessor, 'Total Value', ['Total Value', 'Land Value', 'Improvement Value', 'Taxable Value']),
    'Taxable': buildAssessorFact(parcel, sources.assessor, 'Taxable', ['Taxable Value', 'Homeowners Exemption', 'Real Estate Exemption']),
    'SQFT': buildAssessorFact(parcel, sources.assessor, 'SQFT', ['Square Footage', 'Legal SqFt', 'Geometric SqFt']),
    'Year Built': buildAssessorFact(parcel, sources.assessor, 'Year Built', ['Year Built', 'Effective Year']),
    'City Tax Rate Area': buildAssessorFact(parcel, sources.assessor, 'City Tax Rate Area', ['City Tax Rate Area']),
    'Tax Rate Area Code': buildAssessorFact(parcel, sources.assessor, 'Tax Rate Area Code', ['Tax Rate Area Code']),
    'Classification': buildAssessorFact(parcel, sources.assessor, 'Classification', ['Classification']),
    'Region #': buildAssessorFact(parcel, sources.assessor, 'Region #', ['Region Number']),
    'Cluster Code': buildAssessorFact(parcel, sources.assessor, 'Cluster Code', ['Cluster Code']),
    'Legal Description': buildAssessorFact(parcel, sources.assessor, 'Legal Description', ['Parcel Legal Description']),
    'CofO Number': buildCofoFact(parcel, sources.cofo, 'CofO Number', ['cofo_number', 'assessor book/page/parcel']),
    'Issue Date': buildCofoFact(parcel, sources.cofo, 'Issue Date', ['issue_date']),
    'Status': buildCofoFact(parcel, sources.cofo, 'Status', ['status']),
    'Permit Type': buildCofoFact(parcel, sources.cofo, 'Permit Type', ['permit_type']),
    'Sub-Type': buildCofoFact(parcel, sources.cofo, 'Sub-Type', ['permit_sub_type']),
    'Work Description': buildCofoFact(parcel, sources.cofo, 'Work Description', ['work_description']),
    'Valuation': buildCofoFact(parcel, sources.cofo, 'Valuation', ['valuation']),
    'Zone': buildCofoFact(parcel, sources.cofo, 'Zone', ['permit_type', 'permit_sub_type']),
    'Stories': buildCofoFact(parcel, sources.cofo, 'Stories', ['stories']),
    'Contractor': buildCofoFact(parcel, sources.cofo, 'Contractor', ['contractor_name']),
    'Building Permits': buildPermitFact(parcel, sources.building, 'Building Permits', ['permit_number', 'status', 'work_description', 'valuation'], parcel.latestBuildingPermit ?? parcel.assessorId, 'building_permit'),
    'Building Valuation': buildPermitFact(parcel, sources.building, 'Building Valuation', ['valuation'], parcel.latestBuildingPermit ?? parcel.assessorId, 'building_permit'),
    'Latest Building Permit': buildPermitFact(parcel, sources.building, 'Latest Building Permit', ['permit_number'], parcel.latestBuildingPermit ?? parcel.assessorId, 'building_permit'),
    'Building Status': buildPermitFact(parcel, sources.building, 'Building Status', ['status'], parcel.latestBuildingPermit ?? parcel.assessorId, 'building_permit'),
    'Building Work': buildPermitFact(parcel, sources.building, 'Building Work', ['work_description'], parcel.latestBuildingPermit ?? parcel.assessorId, 'building_permit'),
    'Electrical Permits': buildPermitFact(parcel, sources.electrical, 'Electrical Permits', ['permit_number'], parcel.latestElectricalPermit ?? parcel.assessorId, 'electrical_permit'),
    'Latest Electrical Permit': buildPermitFact(parcel, sources.electrical, 'Latest Electrical Permit', ['permit_number'], parcel.latestElectricalPermit ?? parcel.assessorId, 'electrical_permit'),
    'Electrical Status': buildPermitFact(parcel, sources.electrical, 'Electrical Status', ['status'], parcel.latestElectricalPermit ?? parcel.assessorId, 'electrical_permit'),
    'Electrical Work': buildPermitFact(parcel, sources.electrical, 'Electrical Work', ['work_description'], parcel.latestElectricalPermit ?? parcel.assessorId, 'electrical_permit'),
    'Submitted Building Permits': buildPermitFact(parcel, sources.submitted, 'Submitted Building Permits', ['permit_number'], parcel.latestSubmittedBuildingPermit ?? parcel.assessorId, 'building_permit_submitted'),
    'Latest Submitted Permit': buildPermitFact(parcel, sources.submitted, 'Latest Submitted Permit', ['permit_number'], parcel.latestSubmittedBuildingPermit ?? parcel.assessorId, 'building_permit_submitted'),
    'Submitted Status': buildPermitFact(parcel, sources.submitted, 'Submitted Status', ['status'], parcel.latestSubmittedBuildingPermit ?? parcel.assessorId, 'building_permit_submitted'),
    'Submitted Work': buildPermitFact(parcel, sources.submitted, 'Submitted Work', ['work_description'], parcel.latestSubmittedBuildingPermit ?? parcel.assessorId, 'building_permit_submitted'),
    'Inspections': buildPermitFact(parcel, sources.inspections, 'Inspections', ['inspection_number', 'status'], parcel.latestInspection ?? parcel.assessorId, 'inspection'),
    'Latest Inspection': buildPermitFact(parcel, sources.inspections, 'Latest Inspection', ['inspection_number'], parcel.latestInspection ?? parcel.assessorId, 'inspection'),
    'Inspection Result': buildPermitFact(parcel, sources.inspections, 'Inspection Result', ['status'], parcel.latestInspection ?? parcel.assessorId, 'inspection'),
    'Inspection Type': buildPermitFact(parcel, sources.inspections, 'Inspection Type', ['inspection_type'], parcel.latestInspection ?? parcel.assessorId, 'inspection'),
    'Terrain': buildTerrainFact(parcel, 'Terrain'),
    'Terrain Slope': buildTerrainFact(parcel, 'Terrain Slope'),
    'Slope': buildTerrainFact(parcel, 'Slope'),
    'Relief': buildTerrainFact(parcel, 'Relief'),
    'Aspect': buildTerrainFact(parcel, 'Aspect'),
    'Pad Candidates': buildTerrainFact(parcel, 'Pad Candidates'),
    'Driveway Grade': buildTerrainFact(parcel, 'Driveway Grade'),
    'Retaining Wall': buildTerrainFact(parcel, 'Retaining Wall'),
    'Sun': buildSunFact(parcel, 'Sun'),
    'Sunrise': buildSunFact(parcel, 'Sunrise'),
    'Sunset': buildSunFact(parcel, 'Sunset'),
    'Daylight': buildSunFact(parcel, 'Daylight'),
    'View': buildViewFact(parcel, 'View'),
    'View Score': buildViewFact(parcel, 'View Score'),
    'Max View': buildViewFact(parcel, 'Max View'),
    'Visible Landmarks': buildViewFact(parcel, 'Visible Landmarks'),
    'Assessor ID': buildAssessorFact(parcel, sources.assessor, 'Assessor ID', ['Assessor ID']),
    'AIN': buildAssessorFact(parcel, sources.assessor, 'AIN', ['AIN']),
    'Roll Year': buildAssessorFact(parcel, sources.assessor, 'Roll Year', ['Roll Year']),
    'Row ID': buildAssessorFact(parcel, sources.assessor, 'Row ID', ['Row ID']),
    'Object ID': buildAssessorFact(parcel, sources.assessor, 'Object ID', ['Object ID']),
    'Property Location': buildAssessorFact(parcel, sources.assessor, 'Property Location', ['Property Location']),
    'House #': buildAssessorFact(parcel, sources.assessor, 'House #', ['Address House Number']),
    'Direction': buildAssessorFact(parcel, sources.assessor, 'Direction', ['Direction']),
    'Street': buildAssessorFact(parcel, sources.assessor, 'Street', ['Street']),
    'Unit #': buildAssessorFact(parcel, sources.assessor, 'Unit #', ['Unit Number']),
    'City': buildAssessorFact(parcel, sources.assessor, 'City', ['City']),
    'Zip Code': buildAssessorFact(parcel, sources.assessor, 'Zip Code', ['ZIP Code', 'ZIP+4']),
    'Latitude': buildAssessorFact(parcel, sources.assessor, 'Latitude', ['Latitude']),
    'Longitude': buildAssessorFact(parcel, sources.assessor, 'Longitude', ['Longitude']),
    'Use Type': buildAssessorFact(parcel, sources.assessor, 'Use Type', ['Property Use Type']),
    'Use Code': buildAssessorFact(parcel, sources.assessor, 'Use Code', ['Property Use Code']),
    '1st Digit': buildAssessorFact(parcel, sources.assessor, '1st Digit', ['Use Code 1']),
    '2nd Digit': buildAssessorFact(parcel, sources.assessor, '2nd Digit', ['Use Code 2']),
    '3rd Digit': buildAssessorFact(parcel, sources.assessor, '3rd Digit', ['Use Code 3']),
    '4th Digit': buildAssessorFact(parcel, sources.assessor, '4th Digit', ['Use Code 4']),
    'Eligible': buildDerivedFact(
      parcel,
      'Eligible',
      ['parcel_sb79', 'nearest transit anchor'],
      ['parcel SB79 screening status', 'nearest-stop distance normalization'],
      'SB79 eligibility is derived from the persisted parcel_sb79 screening table.'
    ),
    'Tier': buildDerivedFact(
      parcel,
      'Tier',
      ['parcel_sb79', 'nearest transit anchor'],
      ['parcel SB79 tier normalization', 'distance-to-stop normalization'],
      'SB79 tier is derived from the persisted parcel_sb79 screening table.'
    ),
    'Nearest Transit Distance': buildDerivedFact(
      parcel,
      'Nearest Transit Distance',
      ['parcel_sb79', 'nearest transit anchor'],
      ['feet normalization', 'nearest-stop lookup'],
      'Transit distance is derived from the persisted parcel_sb79 screening table.'
    ),
    '# Buildings': buildAssessorFact(parcel, sources.assessor, '# Buildings', ['Number of Buildings']),
    'Effective Year': buildAssessorFact(parcel, sources.assessor, 'Effective Year', ['Effective Year']),
    'Bedrooms': buildAssessorFact(parcel, sources.assessor, 'Bedrooms', ['Number of Bedrooms']),
    'Bathrooms': buildAssessorFact(parcel, sources.assessor, 'Bathrooms', ['Number of Bathrooms']),
    'Units': buildAssessorFact(parcel, sources.assessor, 'Units', ['Number of Units']),
    'Land Base Year': buildAssessorFact(parcel, sources.assessor, 'Land Base Year', ['Land Base Year']),
    'Improvement Base Yr': buildAssessorFact(parcel, sources.assessor, 'Improvement Base Yr', ['Improvement Base Year']),
    'Land+Improvement': buildAssessorFact(parcel, sources.assessor, 'Land+Improvement', ['Land Value', 'Improvement Value']),
    'Homeowner Exempt': buildAssessorFact(parcel, sources.assessor, 'Homeowner Exempt', ['Homeowners Exemption']),
    'Real Estate Exempt': buildAssessorFact(parcel, sources.assessor, 'Real Estate Exempt', ['Real Estate Exemption']),
    'Fixture Value': buildAssessorFact(parcel, sources.assessor, 'Fixture Value', ['Fixture Value']),
    'Fixture Exempt': buildAssessorFact(parcel, sources.assessor, 'Fixture Exempt', ['Fixture Exemption']),
    'Personal Prop Val': buildAssessorFact(parcel, sources.assessor, 'Personal Prop Val', ['Personal Property Value']),
    'Personal Prop Exempt': buildAssessorFact(parcel, sources.assessor, 'Personal Prop Exempt', ['Personal Property Exemption']),
    'Property Taxable?': buildAssessorFact(parcel, sources.assessor, 'Property Taxable?', ['Property Taxable']),
    'Total Exemption': buildAssessorFact(parcel, sources.assessor, 'Total Exemption', ['Total Exemption']),
    'Taxable Value': buildAssessorFact(parcel, sources.assessor, 'Taxable Value', ['Taxable Value']),
    'Recording Date': buildAssessorFact(parcel, sources.assessor, 'Recording Date', ['Recording Date'])
  }

  return {
    parcelId: parcel.assessorId,
    owner: buildOwnerFact(parcel, sources.sbf),
    facts
  }
}

export function getParcelFactSourceManifest() {
  return loadParcelFactSourceManifest()
}
