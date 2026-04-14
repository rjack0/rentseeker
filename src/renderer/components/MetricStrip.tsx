import type { DashboardMetric } from '@shared/types'

interface MetricStripProps {
  metrics: DashboardMetric[]
}

export function MetricStrip({ metrics }: MetricStripProps) {
  return (
    <div className="metric-strip">
      {metrics.map((metric) => (
        <div key={metric.label} className="metric-card">
          <div className="metric-label">{metric.label}</div>
          <div className="metric-value">{metric.value}</div>
          <p>{metric.helper}</p>
        </div>
      ))}
    </div>
  )
}

