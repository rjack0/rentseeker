import { describe, expect, it } from 'vitest'

import type { BucketSummary, ConnectionGraph, DossierItem, DossierResponse } from '../src/shared/types'
import { buildDossierSummary, buildSpatialCollections, groupDossierFacts, partitionBuckets } from '../src/renderer/lib/workbench'

describe('partitionBuckets', () => {
  it('separates data and control buckets', () => {
    const buckets: BucketSummary[] = [
      { key: 'records', label: 'Records', description: '', accent: '#fff', count: 3, kind: 'data' as const },
      { key: 'query-lab', label: 'Query Lab', description: '', accent: '#fff', count: 1, kind: 'control' as const }
    ]

    const result = partitionBuckets(buckets)

    expect(result.dataBuckets).toHaveLength(1)
    expect(result.controlBuckets).toHaveLength(1)
    expect(result.dataBuckets[0]?.key).toBe('records')
    expect(result.controlBuckets[0]?.key).toBe('query-lab')
  })
})

describe('groupDossierFacts', () => {
  it('clusters facts into operator-friendly sections', () => {
    const facts: DossierItem[] = [
      { key: 'owner_name', value: 'John Martin', valueKind: 'name' },
      { key: 'address', value: '123 Main St', valueKind: 'address' },
      { key: 'permit_value', value: '150000', valueKind: 'permit_value' },
      { key: 'sb79_flag', value: 'true', valueKind: 'sb79_flag' }
    ]

    const groups = groupDossierFacts(facts)

    expect(groups.map((group) => group.title)).toEqual([
      'Identity',
      'Property Spine',
      'Permits & Timelines',
      'Regulatory'
    ])
  })
})

describe('buildSpatialCollections', () => {
  it('produces point and line features for spatially-linked entities', () => {
    const graph: ConnectionGraph = {
      title: 'Connected dossier',
      focusId: 'record:1',
      nodes: [
        {
          id: 'parcel:1',
          label: 'Parcel 1',
          nodeType: 'parcel',
          bucket: 'parcels',
          weight: 4,
          lat: 34.1,
          lng: -118.2
        },
        {
          id: 'permit:1',
          label: 'Permit 1',
          nodeType: 'permit',
          bucket: 'permits',
          weight: 3,
          lat: 34.11,
          lng: -118.21
        },
        {
          id: 'person:1',
          label: 'John Martin',
          nodeType: 'person',
          bucket: 'people',
          weight: 2
        }
      ],
      edges: [
        {
          id: 'edge:1',
          source: 'parcel:1',
          target: 'permit:1',
          label: 'permit_site',
          strength: 2
        },
        {
          id: 'edge:2',
          source: 'person:1',
          target: 'permit:1',
          label: 'permit_party',
          strength: 2
        }
      ]
    }

    const result = buildSpatialCollections(graph, 'permit:1')

    expect(result.pointFeatures.features).toHaveLength(2)
    expect(result.lineFeatures.features).toHaveLength(1)
    expect(result.nodeData).toHaveLength(2)
    expect(result.arcData).toHaveLength(1)
    expect(result.pointFeatures.features[1]?.properties?.selected).toBe(1)
  })
})

describe('buildDossierSummary', () => {
  it('surfaces a concise spotlight and metrics for the dossier pane', () => {
    const dossier: DossierResponse = {
      entityId: 'record:1',
      title: '123 Main St',
      entityType: 'record',
      facts: [
        { key: 'owner_name', value: 'John Martin', valueKind: 'name' },
        { key: 'address', value: '123 Main St', valueKind: 'address' },
        { key: 'parcel_apn', value: 'APN-100-200', valueKind: 'parcel_apn' },
        { key: 'permit_number', value: 'PRM-9', valueKind: 'permit_number' },
        { key: 'permit_value', value: '150000', valueKind: 'permit_value' },
        { key: 'sb79_flag', value: 'true', valueKind: 'sb79_flag' }
      ],
      linkedEntities: [
        { entityId: 'parcel:1', label: 'APN-100-200', entityType: 'parcel', linkType: 'record_contains' },
        { entityId: 'permit:1', label: 'PRM-9', entityType: 'permit', linkType: 'record_contains' },
        { entityId: 'person:1', label: 'John Martin', entityType: 'person', linkType: 'record_contains' }
      ]
    }

    const result = buildDossierSummary(dossier)

    expect(result.spotlight[0]?.label).toBe('Primary Subject')
    expect(result.spotlight.some((item) => item.label === 'Permit Value')).toBe(true)
    expect(result.metrics.some((item) => item.label === 'Linked Entities')).toBe(true)
  })
})
