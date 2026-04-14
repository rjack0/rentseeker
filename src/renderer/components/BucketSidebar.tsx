import type { CSSProperties } from 'react'

import type { BucketKey, BucketSummary } from '@shared/types'

import { partitionBuckets } from '@renderer/lib/workbench'

interface BucketSidebarProps {
  buckets: BucketSummary[]
  activeBucket: BucketKey
  workspacePath?: string
  onSelect: (bucket: BucketKey) => void
}

function BucketSection({
  title,
  buckets,
  activeBucket,
  onSelect
}: {
  title: string
  buckets: BucketSummary[]
  activeBucket: BucketKey
  onSelect: (bucket: BucketKey) => void
}) {
  if (buckets.length === 0) {
    return null
  }

  return (
    <>
      <div className="sidebar-section-label">{title}</div>
      <div className="bucket-list">
        {buckets.map((bucket) => {
          const active = bucket.key === activeBucket
          return (
            <button
              key={bucket.key}
              className={`bucket-button ${active ? 'active' : ''}`}
              style={{ '--bucket-accent': bucket.accent } as CSSProperties}
              onClick={() => onSelect(bucket.key)}
            >
              <div className="bucket-button-topline">
                <span>{bucket.label}</span>
                <span className="bucket-count">{bucket.count}</span>
              </div>
              <p>{bucket.description}</p>
            </button>
          )
        })}
      </div>
    </>
  )
}

export function BucketSidebar({ buckets, activeBucket, workspacePath, onSelect }: BucketSidebarProps) {
  const { dataBuckets, controlBuckets } = partitionBuckets(buckets)
  const workspaceFile = workspacePath?.split(/[\\/]/).pop()

  return (
    <aside className="bucket-sidebar">
      <div className="sidebar-brand">
        <div className="sidebar-brand-mark">PX</div>
        <div>
          <h1>RentSeeker</h1>
          <p>Universal entity search, linkage, and run control.</p>
        </div>
      </div>

      <BucketSection title="Data Buckets" buckets={dataBuckets} activeBucket={activeBucket} onSelect={onSelect} />
      <BucketSection title="Control Buckets" buckets={controlBuckets} activeBucket={activeBucket} onSelect={onSelect} />

      <div className="sidebar-footer-card">
        <span>Workspace</span>
        <strong>{workspaceFile ?? 'phoenix-workspace.duckdb'}</strong>
        <p>The local DuckDB file is the spine for uploads, linked entities, and run results.</p>
      </div>
    </aside>
  )
}
