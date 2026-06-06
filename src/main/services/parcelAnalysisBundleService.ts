import type { Geometry } from 'geojson'

import type {
  ParcelAnalysisBundleRequest,
  ParcelAnalysisBundleResponse,
  SunAnalysisResponse,
  TerrainMetricsResponse,
  ViewAnalysisResponse
} from '@shared/types'
import { geometryFingerprint } from '@shared/sourceRegistry'
import { computeTerrainMetrics } from './terrainEngine'
import { computeSunAnalysis } from './sunSimulator'
import { computeViewAnalysis } from './viewAnalysis'
import { getParcelDossierProvenance } from './parcelProvenanceService'
import { rentSeekerStore } from './rentSeekerStore'

export async function getParcelAnalysisBundle(request: ParcelAnalysisBundleRequest): Promise<ParcelAnalysisBundleResponse> {
  const geometry = request.geometry ?? null
  const geometryHash = geometryFingerprint(geometry)

  let terrain: TerrainMetricsResponse
  try {
    const cached = await rentSeekerStore.getTerrainMetrics(request.parcelId, geometryHash)
    if (cached) {
      terrain = { computed: true, cached: true, metrics: cached }
    } else {
      const metrics = await computeTerrainMetrics(request.parcelId, request.lat, request.lng, request.lotSqft ?? 5000, geometry)
      terrain = { computed: true, cached: false, metrics }
    }
  } catch (err: any) {
    terrain = {
      computed: false,
      cached: false,
      reason: err?.message || 'Terrain metrics not computed',
      metrics: null
    }
  }

  let sun: SunAnalysisResponse
  try {
    const cached = await rentSeekerStore.getSunAnalysis(request.parcelId, request.date, geometryHash)
    if (cached) {
      sun = { computed: true, cached: true, analysis: cached }
    } else {
      const analysis = await computeSunAnalysis(request.parcelId, request.lat, request.lng, request.date, geometry)
      sun = { computed: true, cached: false, analysis }
    }
  } catch (err: any) {
    sun = {
      computed: false,
      cached: false,
      reason: err?.message || 'Sun analysis not computed',
      analysis: null
    }
  }

  let view: ViewAnalysisResponse
  try {
    const cached = await rentSeekerStore.getViewAnalysis(request.parcelId, request.stories, geometryHash)
    if (cached) {
      view = { computed: true, cached: true, analysis: cached }
    } else {
      const analysis = await computeViewAnalysis(request.parcelId, request.lat, request.lng, request.stories, geometry)
      view = { computed: true, cached: false, analysis }
    }
  } catch (err: any) {
    view = {
      computed: false,
      cached: false,
      reason: err?.message || 'View analysis not computed',
      analysis: null
    }
  }

  let buildRuns = await rentSeekerStore.getBuildRunsForParcel(request.parcelId, geometryHash).catch(() => [])
  if (buildRuns.length === 0) {
    buildRuns = await rentSeekerStore.getBuildRunsForParcel(request.parcelId).catch(() => [])
  }
  const terrainProduct = await rentSeekerStore.getLatestTerrainProduct(request.parcelId, 'surface_grid').catch(() => null)
  const provenance = await getParcelDossierProvenance(request.parcel ?? {
    assessorId: request.parcelId,
    ain: request.parcelId.replace(/[^0-9]/g, ''),
    rollYear: 0,
    zipCode: '',
    cityTaxRateArea: '',
    taxRateAreaCode: '',
    propertyLocation: '',
    propertyUseType: '',
    propertyUseCode: '',
    useCode1: '',
    useCode2: '',
    useCode3: '',
    useCode4: '',
    numberOfBuildings: 0,
    yearBuilt: 0,
    effectiveYear: 0,
    squareFootage: request.lotSqft ?? 0,
    numberOfBedrooms: 0,
    numberOfBathrooms: 0,
    numberOfUnits: 0,
    recordingDate: '',
    landValue: 0,
    landBaseYear: 0,
    improvementValue: 0,
    improvementBaseYear: 0,
    totalValueLandImprovement: 0,
    homeOwnersExemption: 0,
    realEstateExemption: 0,
    fixtureValue: 0,
    fixtureExemption: 0,
    personalPropertyValue: 0,
    personalPropertyExemption: 0,
    propertyTaxable: '',
    totalValue: 0,
    totalExemption: 0,
    taxableValue: 0,
    classification: '',
    regionNumber: '',
    clusterCode: '',
    parcelLegalDescription: '',
    addressHouseNumber: '',
    addressHouseNumberFraction: '',
    direction: '',
    street: '',
    unitNumber: '',
    city: '',
    zipCodeFull: '',
    rowId: '',
    latitude: request.lat,
    longitude: request.lng,
    objectId: '',
    dataSource: 'parcel',
    dataSources: []
  } as any, rentSeekerStore)

  return {
    parcelId: request.parcelId,
    geometryHash,
    terrain,
    sun,
    view,
    buildRuns,
    terrainProduct,
    provenance
  }
}
