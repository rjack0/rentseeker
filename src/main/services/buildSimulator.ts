/**
 * BuildSimulator — Parcel-native construction simulation
 * 
 * Given a parcel + terrain metrics + zoning envelope + building template,
 * computes placement coordinates, estimated earthwork (cut/fill),
 * retaining wall requirements, driveway grade, and fit score.
 * 
 * Every simulation is persisted as a build_run, not an ephemeral visual.
 * Per 3DBuild.md: "every 3D model on the map must come from a stored
 * build run, not an ephemeral visual test."
 */

import { randomUUID } from 'crypto'
import type { BuildRunInput, BuildRunOutput, TerrainMetrics, BuildTemplate } from '@shared/types'
import { computeTerrainMetrics } from './terrainEngine'
import { rentSeekerStore } from './rentSeekerStore'

/* ═══════════════ DEFAULT TEMPLATES ═══════════════ */

export const DEFAULT_TEMPLATES: BuildTemplate[] = [
  {
    id: 'sfr-2story',
    name: 'Single Family Residence (2-Story)',
    footprintSqft: 1200,
    stories: 2,
    heightFt: 28,
    useCodes: ['0100', '0101', '0102', '010V']
  },
  {
    id: 'sfr-3story',
    name: 'Single Family Residence (3-Story)',
    footprintSqft: 1000,
    stories: 3,
    heightFt: 37,
    useCodes: ['0100', '0101', '0102', '010V']
  },
  {
    id: 'duplex',
    name: 'Duplex',
    footprintSqft: 1500,
    stories: 2,
    heightFt: 28,
    useCodes: ['0200', '0201', '0210']
  },
  {
    id: 'adu',
    name: 'ADU (Accessory Dwelling Unit)',
    footprintSqft: 600,
    stories: 1,
    heightFt: 14,
    useCodes: ['0100', '0101', '0200']
  },
  {
    id: 'small-apt',
    name: 'Small Apartment (4-unit)',
    footprintSqft: 2400,
    stories: 3,
    heightFt: 38,
    useCodes: ['0300', '0301', '0302']
  },
  {
    id: 'hillside-modern',
    name: 'Hillside Modern (Cantilevered)',
    footprintSqft: 1800,
    stories: 3,
    heightFt: 42,
    useCodes: ['0100', '0101', '010V']
  },
  {
    id: 'bucket-home',
    name: 'Bucket Home (Excavated Foundation)',
    footprintSqft: 2000,
    stories: 2,
    heightFt: 24,
    useCodes: ['0100', '0101']
  }
]

/* ═══════════════ EARTHWORK ESTIMATION ═══════════════ */

const CY_PER_CUFT = 1 / 27 // 27 cubic feet per cubic yard

/**
 * Estimate cut volume needed to create a level pad on a sloped lot.
 * Uses terrain metrics to approximate the wedge of earth that must be removed.
 */
function estimateCutVolume(
  terrain: TerrainMetrics,
  footprintSqft: number,
  stories: number,
  foundationDepthFt: number = 3
): { cutCy: number; fillCy: number; avgRetainingHeightFt: number } {
  const sideLength = Math.sqrt(footprintSqft)
  const slopeFraction = terrain.bestFitSlopePct / 100

  // On a slope, the cut face height at the uphill side:
  // h = sideLength * tan(slope) + foundation depth
  const cutFaceHeight = sideLength * slopeFraction + foundationDepthFt

  // Volume of the wedge removed (triangular prism):
  // V = 0.5 * width * cutFaceHeight * depth
  const cutVolumeCuft = 0.5 * sideLength * cutFaceHeight * sideLength
  const cutCy = cutVolumeCuft * CY_PER_CUFT

  // Fill volume (downhill side requires fill or stilts):
  // On steep slopes (>25%), we assume stilts instead of fill
  let fillCy = 0
  if (slopeFraction < 0.25) {
    const fillHeight = Math.max(0, cutFaceHeight - foundationDepthFt) * 0.3
    fillCy = 0.5 * sideLength * fillHeight * sideLength * CY_PER_CUFT
  }

  // Average retaining wall height
  const avgRetainingHeightFt = cutFaceHeight * 0.6

  return { cutCy: Math.round(cutCy), fillCy: Math.round(fillCy), avgRetainingHeightFt }
}

/**
 * Estimate retaining wall length based on the cut perimeter.
 * On a slope, you need retaining on the uphill side + both sides.
 */
function estimateRetainingWallLength(
  terrain: TerrainMetrics,
  footprintSqft: number
): number {
  const sideLength = Math.sqrt(footprintSqft)

  // If flat (<5%), minimal retaining
  if (terrain.bestFitSlopePct < 5) return 0

  // Uphill face: full width + partial sides
  const uphillFace = sideLength
  const sideWalls = sideLength * Math.min(1, terrain.bestFitSlopePct / 50) * 2

  return Math.round(uphillFace + sideWalls)
}

/**
 * Estimate driveway grade from street to building pad.
 */
function estimateDrivewayGrade(terrain: TerrainMetrics): number {
  // Use the terrain's best available grade, or estimate from slope
  if (terrain.drivewayGradeBestPct > 0) return terrain.drivewayGradeBestPct

  // Approximate: driveway traverses half the lot depth at lot slope
  return terrain.bestFitSlopePct * 0.6
}

/**
 * Estimate the largest flat pad area achievable with cut/fill.
 */
function estimateFlatPadArea(
  terrain: TerrainMetrics,
  footprintSqft: number
): number {
  // If terrain already has a pad candidate, use it
  if (terrain.largestPadAreaSqft > footprintSqft * 0.8) {
    return terrain.largestPadAreaSqft
  }

  // Otherwise, the pad area depends on how much cut is feasible
  // Steep lots get smaller effective pads
  const slopeReduction = Math.max(0.3, 1 - terrain.bestFitSlopePct / 100)
  return Math.round(footprintSqft * slopeReduction)
}

function generateFoundationSkirt(
  terrain: TerrainMetrics,
  footprintSqft: number,
  centerLng: number,
  centerLat: number
): BuildRunOutput['foundationSkirt'] {
  const sideFt = Math.sqrt(footprintSqft)
  const halfMeters = (sideFt / 2) / 3.28084
  const dLat = halfMeters / 111139
  const dLng = halfMeters / 92383
  const slopeRiseFt = sideFt * (terrain.bestFitSlopePct / 100)
  const uphillHeightFt = Math.max(0, slopeRiseFt / 2 + 2)
  const downhillHeightFt = Math.max(0, 2 - slopeRiseFt / 2)
  const baseElevationFt = terrain.demMeanZ

  return {
    baseElevationFt,
    uphillHeightFt,
    downhillHeightFt,
    vertices: [
      [centerLng - dLng, centerLat - dLat, baseElevationFt - downhillHeightFt],
      [centerLng + dLng, centerLat - dLat, baseElevationFt - downhillHeightFt],
      [centerLng + dLng, centerLat + dLat, baseElevationFt + uphillHeightFt],
      [centerLng - dLng, centerLat + dLat, baseElevationFt + uphillHeightFt]
    ]
  }
}

/* ═══════════════ FIT SCORING ═══════════════ */

/**
 * Calculate a fit score (0-100) for how well this building works on this parcel.
 */
function calculateFitScore(
  terrain: TerrainMetrics,
  template: BuildTemplate,
  input: BuildRunInput,
  earthwork: { cutCy: number; fillCy: number; avgRetainingHeightFt: number }
): { fitScore: number; constraintFlags: string[] } {
  let score = 100
  const flags: string[] = []

  // Slope penalties
  if (terrain.bestFitSlopePct > 45) {
    score -= 40
    flags.push('EXTREME_SLOPE')
  } else if (terrain.bestFitSlopePct > 30) {
    score -= 25
    flags.push('STEEP_SLOPE')
  } else if (terrain.bestFitSlopePct > 15) {
    score -= 10
    flags.push('MODERATE_SLOPE')
  }

  // Cut volume penalties (per 3DBuild.md: >3000 CY is expensive)
  if (earthwork.cutCy > 5000) {
    score -= 20
    flags.push('EXCESSIVE_EXCAVATION')
  } else if (earthwork.cutCy > 3000) {
    score -= 10
    flags.push('SIGNIFICANT_EXCAVATION')
  }

  // Retaining wall height penalties
  if (earthwork.avgRetainingHeightFt > 16) {
    score -= 15
    flags.push('TALL_RETAINING_WALL')
  } else if (earthwork.avgRetainingHeightFt > 10) {
    score -= 5
    flags.push('MODERATE_RETAINING_WALL')
  }

  // Driveway grade penalties
  const driveGrade = estimateDrivewayGrade(terrain)
  if (driveGrade > 25) {
    score -= 15
    flags.push('EXTREME_DRIVEWAY_GRADE')
  } else if (driveGrade > 15) {
    score -= 5
    flags.push('STEEP_DRIVEWAY')
  }

  // Height limit check
  if (input.maxHeightFt && template.heightFt > input.maxHeightFt) {
    score -= 20
    flags.push('EXCEEDS_HEIGHT_LIMIT')
  }

  // Floor Area Ratio check
  if (input.maxFar) {
    const lotSqft = template.footprintSqft * 5 // rough estimate
    const far = (template.footprintSqft * template.stories) / lotSqft
    if (far > input.maxFar) {
      score -= 15
      flags.push('EXCEEDS_FAR')
    }
  }

  // Terrain confidence bonus/penalty
  if (terrain.terrainConfidence < 0.5) {
    flags.push('LOW_TERRAIN_CONFIDENCE')
  }

  return { fitScore: Math.max(0, Math.min(100, score)), constraintFlags: flags }
}

/* ═══════════════ MAIN API ═══════════════ */

/**
 * Run a build simulation for a parcel.
 */
export async function runBuildSimulation(
  input: BuildRunInput,
  parcelLat: number,
  parcelLng: number,
  lotSqft: number = 5000,
  existingTerrain?: TerrainMetrics
): Promise<BuildRunOutput> {
  // Find the template
  const template = DEFAULT_TEMPLATES.find(t => t.id === input.templateId)
    ?? DEFAULT_TEMPLATES[0]

  // Get or compute terrain metrics
  const terrain = existingTerrain
    ?? await computeTerrainMetrics(input.parcelId, parcelLat, parcelLng, lotSqft)

  // Compute earthwork
  const earthwork = estimateCutVolume(terrain, template.footprintSqft, input.stories)
  const retainingWallFt = estimateRetainingWallLength(terrain, template.footprintSqft)
  const drivewayGrade = estimateDrivewayGrade(terrain)
  const flatPad = estimateFlatPadArea(terrain, template.footprintSqft)

  // Calculate fit score
  const { fitScore, constraintFlags } = calculateFitScore(terrain, template, input, earthwork)

  // Calculate placement coordinates
  // Z from terrain, pitch/roll from slope
  const slopeRad = Math.atan(terrain.bestFitSlopePct / 100)
  const aspectRad = terrain.aspectDeg * (Math.PI / 180)

  const output: BuildRunOutput = {
    runId: randomUUID(),
    parcelId: input.parcelId,
    templateId: template.id,
    createdAt: new Date().toISOString(),
    footprintSqft: template.footprintSqft,
    buildingHeightFt: input.stories * 11,
    floorAreaSqft: template.footprintSqft * input.stories,
    estimatedUnits: template.id.includes('apt') ? 4 : template.id.includes('duplex') ? 2 : 1,
    estimatedCutCy: earthwork.cutCy,
    estimatedFillCy: earthwork.fillCy,
    estimatedRetainingWallFt: retainingWallFt,
    estimatedAvgRetainingHeightFt: earthwork.avgRetainingHeightFt,
    estimatedDrivewayGradePct: drivewayGrade,
    estimatedFlatPadSqft: flatPad,
    fitScore,
    constraintFlags,
    placementLng: parcelLng,
    placementLat: parcelLat,
    placementZ: terrain.demMeanZ,
    placementPitchDeg: slopeRad * (180 / Math.PI) * Math.cos(aspectRad),
    placementRollDeg: slopeRad * (180 / Math.PI) * Math.sin(aspectRad),
    foundationSkirt: generateFoundationSkirt(terrain, template.footprintSqft, parcelLng, parcelLat)
  }

  await rentSeekerStore.recordBuildRun(input, output, terrain).catch((err) => {
    console.error('[BuildSimulator] Failed to persist build run:', err)
  })

  return output
}
