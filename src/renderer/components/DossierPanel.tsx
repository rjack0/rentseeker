import type { DossierResponse } from '@shared/types'

import { buildDossierSummary, groupDossierFacts } from '@renderer/lib/workbench'

interface DossierPanelProps {
  dossier?: DossierResponse
  onSelectEntity?: (entityId: string) => void
}

export function DossierPanel({ dossier, onSelectEntity }: DossierPanelProps) {
  if (!dossier) {
    return (
      <aside className="glass-panel dossier-panel empty">
        <div className="panel-header">
          <div>
            <div className="panel-kicker">Dossier</div>
            <h3>Nothing selected</h3>
          </div>
        </div>
        <p>
          Select a record, parcel, phone, permit, or person to inspect the linked facts and the edges
          that connect it to the rest of the workbench.
        </p>
      </aside>
    )
  }

  const groupedFacts = groupDossierFacts(dossier.facts)
  const summary = buildDossierSummary(dossier)

  return (
    <aside className="glass-panel dossier-panel">
      <div className="panel-header">
        <div>
          <div className="panel-kicker">Dossier</div>
          <h3>{dossier.title}</h3>
        </div>
        <div className="panel-chip">{dossier.entityType}</div>
      </div>

      {summary.spotlight.length > 0 ? (
        <div className="dossier-section">
          <h4>Summary</h4>
          <div className="dossier-summary-grid">
            {summary.spotlight.map((item) => (
              <div key={`${item.label}-${item.value}`} className={`dossier-summary-card ${item.tone ?? 'default'}`}>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {summary.metrics.length > 0 ? (
        <div className="dossier-section">
          <h4>Signals</h4>
          <div className="dossier-metric-grid">
            {summary.metrics.map((item) => (
              <div key={`${item.label}-${item.value}`} className="dossier-metric-card">
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {groupedFacts.map((group) => (
        <div key={group.title} className="dossier-section">
          <h4>{group.title}</h4>
          <div className="dossier-fact-list">
            {group.items.map((fact) => (
              <div key={`${fact.key}-${fact.value}`} className="dossier-fact">
                <span>{fact.key}</span>
                <strong>{fact.value}</strong>
              </div>
            ))}
          </div>
        </div>
      ))}

      <div className="dossier-section">
        <h4>Linked Entities</h4>
        <div className="dossier-link-list">
          {dossier.linkedEntities.map((link) => (
            <button
              key={`${link.entityId}-${link.linkType}`}
              className="dossier-link dossier-link-button"
              onClick={() => onSelectEntity?.(link.entityId)}
            >
              <span>{link.linkType}</span>
              <strong>{link.label}</strong>
              <small>{link.entityType}</small>
            </button>
          ))}
        </div>
      </div>
    </aside>
  )
}
