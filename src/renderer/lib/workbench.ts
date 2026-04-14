import type { Feature, FeatureCollection, LineString, Point } from 'geojson'

import type { BucketSummary, ConnectionGraph, DossierItem, DossierResponse } from '@shared/types'

export interface SpatialNodeDatum {
  id: string
  label: string
  bucket: string
  nodeType: string
  weight: number
  position: [number, number]
  selected: boolean
}

export interface SpatialArcDatum {
  id: string
  label: string
  strength: number
  source: string
  target: string
  sourcePosition: [number, number]
  targetPosition: [number, number]
}

export interface DossierSummaryCard {
  label: string
  value: string
  tone?: 'default' | 'accent' | 'success'
}

export function partitionBuckets(buckets: BucketSummary[]): {
  dataBuckets: BucketSummary[]
  controlBuckets: BucketSummary[]
} {
  return {
    dataBuckets: buckets.filter((bucket) => bucket.kind === 'data'),
    controlBuckets: buckets.filter((bucket) => bucket.kind === 'control')
  }
}

function factGroupForKey(key: string): string {
  if (/owner|client|contractor|person|name/.test(key)) return 'Identity'
  if (/address|parcel|deed|latitude|longitude/.test(key)) return 'Property Spine'
  if (/permit|occupancy|valuation|value/.test(key)) return 'Permits & Timelines'
  if (/phone|email/.test(key)) return 'Contact'
  if (/sb79|sb9|zoning|rule/.test(key)) return 'Regulatory'
  return 'Other'
}

export function groupDossierFacts(
  facts: DossierItem[]
): Array<{ title: string; items: DossierItem[] }> {
  const groups = new Map<string, DossierItem[]>()

  for (const fact of facts) {
    const title = factGroupForKey(fact.key.toLowerCase())
    const current = groups.get(title) ?? []
    current.push(fact)
    groups.set(title, current)
  }

  return Array.from(groups.entries()).map(([title, items]) => ({ title, items }))
}

export function buildSpatialCollections(
  graph: ConnectionGraph,
  selectedId?: string
): {
  pointFeatures: FeatureCollection<Point>
  lineFeatures: FeatureCollection<LineString>
  nodeData: SpatialNodeDatum[]
  arcData: SpatialArcDatum[]
} {
  const points: Array<Feature<Point>> = []
  const lines: Array<Feature<LineString>> = []
  const nodeData: SpatialNodeDatum[] = []
  const arcData: SpatialArcDatum[] = []
  const coordinates = new Map<string, [number, number]>()

  for (const node of graph.nodes) {
    if (node.lat === null || node.lat === undefined || node.lng === null || node.lng === undefined) {
      continue
    }
    const coordinate: [number, number] = [node.lng, node.lat]
    coordinates.set(node.id, coordinate)
    nodeData.push({
      id: node.id,
      label: node.label,
      bucket: node.bucket,
      nodeType: node.nodeType,
      weight: node.weight,
      position: coordinate,
      selected: node.id === selectedId
    })
    points.push({
      type: 'Feature',
      properties: {
        id: node.id,
        label: node.label,
        nodeType: node.nodeType,
        weight: node.weight,
        selected: node.id === selectedId ? 1 : 0
      },
      geometry: {
        type: 'Point',
        coordinates: coordinate
      }
    })
  }

  for (const edge of graph.edges) {
    const source = coordinates.get(edge.source)
    const target = coordinates.get(edge.target)
    if (!source || !target) {
      continue
    }
    arcData.push({
      id: edge.id,
      label: edge.label,
      strength: edge.strength,
      source: edge.source,
      target: edge.target,
      sourcePosition: source,
      targetPosition: target
    })
    lines.push({
      type: 'Feature',
      properties: {
        id: edge.id,
        label: edge.label,
        strength: edge.strength
      },
      geometry: {
        type: 'LineString',
        coordinates: [source, target]
      }
    })
  }

  return {
    pointFeatures: {
      type: 'FeatureCollection',
      features: points
    },
    lineFeatures: {
      type: 'FeatureCollection',
      features: lines
    },
    nodeData,
    arcData
  }
}

function firstFactValue(facts: DossierItem[], keys: string[]): string | undefined {
  const lowerKeys = new Set(keys.map((key) => key.toLowerCase()))
  return facts.find((fact) => lowerKeys.has(fact.key.toLowerCase()))?.value
}

function countBy<T extends string>(values: T[]): Array<{ key: T; count: number }> {
  const counts = new Map<T, number>()
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1))
  return Array.from(counts.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count)
}

export function buildDossierSummary(dossier?: DossierResponse): {
  spotlight: DossierSummaryCard[]
  metrics: DossierSummaryCard[]
} {
  if (!dossier) {
    return { spotlight: [], metrics: [] }
  }

  const spotlight: DossierSummaryCard[] = []
  const metrics: DossierSummaryCard[] = []

  const subject = firstFactValue(dossier.facts, ['client_name', 'owner_name', 'contractor_name', 'person_name'])
  const address = firstFactValue(dossier.facts, ['address'])
  const parcel = firstFactValue(dossier.facts, ['parcel_ain', 'parcel_apn'])
  const permit = firstFactValue(dossier.facts, ['permit_number'])
  const permitValue = firstFactValue(dossier.facts, ['permit_value'])
  const permitDuration = firstFactValue(dossier.facts, ['permit_duration_days', 'permit_duration_months'])
  const zoning = firstFactValue(dossier.facts, ['zoning'])
  const sb79 = firstFactValue(dossier.facts, ['sb79_flag'])
  const sb9 = firstFactValue(dossier.facts, ['sb9_flag'])

  if (subject) spotlight.push({ label: 'Primary Subject', value: subject, tone: 'accent' })
  if (address) spotlight.push({ label: 'Address', value: address })
  if (parcel) spotlight.push({ label: 'Parcel Spine', value: parcel })
  if (permit) spotlight.push({ label: 'Permit', value: permit })
  if (permitValue) spotlight.push({ label: 'Permit Value', value: permitValue, tone: 'success' })
  if (permitDuration) spotlight.push({ label: 'Delivery Time', value: permitDuration })
  if (zoning) spotlight.push({ label: 'Zoning', value: zoning })
  if (sb79) spotlight.push({ label: 'SB 79', value: sb79 })
  if (sb9) spotlight.push({ label: 'SB 9', value: sb9 })

  metrics.push({ label: 'Facts', value: String(dossier.facts.length) })
  metrics.push({ label: 'Linked Entities', value: String(dossier.linkedEntities.length) })

  const dominantEntityType = countBy(dossier.linkedEntities.map((link) => link.entityType))[0]
  if (dominantEntityType) {
    metrics.push({
      label: 'Dominant Links',
      value: `${dominantEntityType.key} (${dominantEntityType.count})`
    })
  }

  const dominantLinkType = countBy(dossier.linkedEntities.map((link) => link.linkType))[0]
  if (dominantLinkType) {
    metrics.push({
      label: 'Dominant Edge',
      value: `${dominantLinkType.key} (${dominantLinkType.count})`
    })
  }

  return {
    spotlight: spotlight.slice(0, 6),
    metrics: metrics.slice(0, 4)
  }
}
