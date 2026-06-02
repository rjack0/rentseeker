/**
 * OwnerPanel — Gold-crowned owner intelligence display
 * 
 * This is the KING panel. Shows owner name prominently in gold,
 * with sale history, portfolio link, and owner-click navigation.
 * Clicking the owner name highlights ALL their parcels on the map.
 */

import { useState, useEffect, useCallback } from 'react'
import type { OwnerRecord, OwnerPortfolio } from '@shared/types'

const api = (window as any).rentSeeker

/* ═══════════════ FORMATTERS ═══════════════ */

function fmtCurrency(val: number): string {
  if (!val) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(val)
}

function fmtDate(raw: string): string {
  if (!raw || raw.length < 6) return '—'
  // SBF dates are often YYMMDD or YYYYMMDD format
  if (raw.length === 8) {
    return `${raw.slice(4, 6)}/${raw.slice(6, 8)}/${raw.slice(0, 4)}`
  }
  return raw
}

function fmtAcres(val: number): string {
  if (!val) return '—'
  return val < 1 ? `${(val * 43560).toFixed(0)} sqft` : `${val.toFixed(2)} ac`
}

/* ═══════════════ OWNER PANEL ═══════════════ */

interface OwnerPanelProps {
  ain: string | null
  onSelectOwner: (ownerName: string) => void
}

export function OwnerPanel({ ain, onSelectOwner }: OwnerPanelProps) {
  const [owner, setOwner] = useState<OwnerRecord | null>(null)
  const [portfolio, setPortfolio] = useState<OwnerPortfolio | null>(null)
  const [showPortfolio, setShowPortfolio] = useState(false)
  const [loading, setLoading] = useState(false)

  // Fetch owner data when AIN changes
  useEffect(() => {
    if (!ain) { setOwner(null); setPortfolio(null); return }
    setLoading(true)
    api.getOwnerByAin(ain)
      .then((rec: OwnerRecord | null) => {
        setOwner(rec)
        setPortfolio(null)
        setShowPortfolio(false)
      })
      .catch(() => setOwner(null))
      .finally(() => setLoading(false))
  }, [ain])

  // Fetch portfolio when requested
  const loadPortfolio = useCallback(async () => {
    if (!owner?.ownerName) return
    setShowPortfolio(true)
    try {
      const p = await api.getOwnerPortfolio(owner.ownerName, 100)
      setPortfolio(p)
    } catch { /* noop */ }
  }, [owner?.ownerName])

  if (!ain) return null
  if (loading) return (
    <div className="op-panel">
      <div className="op-loading">Loading owner data...</div>
    </div>
  )
  if (!owner) return (
    <div className="op-panel">
      <div className="op-no-data">No SBF owner record for this parcel</div>
    </div>
  )

  return (
    <div className="op-panel">
      {/* Crown header — KING DATA */}
      <div className="op-crown-header">
        <span className="op-crown">👑</span>
        <span className="op-crown-label">SBF OWNER</span>
      </div>

      {/* Owner name — clickable */}
      <button
        className="op-owner-name"
        onClick={() => {
          onSelectOwner(owner.ownerName)
          loadPortfolio()
        }}
        title="Click to see all parcels by this owner"
      >
        {owner.ownerName}
      </button>

      {/* Property details */}
      <div className="op-details">
        <div className="op-row op-source-row">
          <span className="op-label">Source</span>
          <span className="op-value">Secured Basic File (SBF) · AIN {owner.ain}</span>
        </div>
        <div className="op-row">
          <span className="op-label">Address</span>
          <span className="op-value">{owner.situsAddress || '—'}</span>
        </div>
        <div className="op-row">
          <span className="op-label">City</span>
          <span className="op-value">{owner.situsCity}</span>
        </div>
        <div className="op-row">
          <span className="op-label">Zoning</span>
          <span className="op-value op-zoning">{owner.zoningCode || '—'}</span>
        </div>
        <div className="op-row">
          <span className="op-label">Use</span>
          <span className="op-value">{owner.useCode} {owner.designType}</span>
        </div>
      </div>

      {/* Value bar */}
      <div className="op-value-bar">
        <div className="op-val-item">
          <span className="op-val-label">Land</span>
          <span className="op-val-amount">{fmtCurrency(owner.landValue)}</span>
        </div>
        <div className="op-val-divider" />
        <div className="op-val-item">
          <span className="op-val-label">Imp</span>
          <span className="op-val-amount">{fmtCurrency(owner.impValue)}</span>
        </div>
        <div className="op-val-divider" />
        <div className="op-val-item op-val-total">
          <span className="op-val-label">Total</span>
          <span className="op-val-amount">{fmtCurrency(owner.totalValue)}</span>
        </div>
      </div>

      {/* Property stats */}
      <div className="op-stats">
        <div className="op-stat">
          <span className="op-stat-val">{owner.yearBuilt || '—'}</span>
          <span className="op-stat-label">Built</span>
        </div>
        <div className="op-stat">
          <span className="op-stat-val">{owner.sqftMain ? owner.sqftMain.toLocaleString() : '—'}</span>
          <span className="op-stat-label">Sqft</span>
        </div>
        <div className="op-stat">
          <span className="op-stat-val">{fmtAcres(owner.acres)}</span>
          <span className="op-stat-label">Lot</span>
        </div>
        <div className="op-stat">
          <span className="op-stat-val">{owner.bedrooms || '—'}/{owner.bathrooms || '—'}</span>
          <span className="op-stat-label">Bed/Bath</span>
        </div>
      </div>

      {/* Sale history */}
      <div className="op-sales">
        <div className="op-sales-title">Sale History</div>
        {owner.saleAmount > 0 && (
          <div className="op-sale-row">
            <span className="op-sale-date">{fmtDate(owner.saleDate)}</span>
            <span className="op-sale-amount">{fmtCurrency(owner.saleAmount)}</span>
          </div>
        )}
        {owner.lastSale2Amount > 0 && (
          <div className="op-sale-row op-sale-prev">
            <span className="op-sale-date">{fmtDate(owner.lastSale2Date)}</span>
            <span className="op-sale-amount">{fmtCurrency(owner.lastSale2Amount)}</span>
          </div>
        )}
        {owner.lastSale3Amount > 0 && (
          <div className="op-sale-row op-sale-prev">
            <span className="op-sale-date">{fmtDate(owner.lastSale3Date)}</span>
            <span className="op-sale-amount">{fmtCurrency(owner.lastSale3Amount)}</span>
          </div>
        )}
        {!owner.saleAmount && <div className="op-sale-row op-sale-none">No sale records</div>}
      </div>

      {/* Portfolio section */}
      {showPortfolio && portfolio && (
        <div className="op-portfolio">
          <div className="op-portfolio-header">
            <span className="op-portfolio-icon">📊</span>
            <span className="op-portfolio-title">Owner Portfolio</span>
          </div>
          <div className="op-portfolio-stats">
            <div className="op-pf-stat">
              <span className="op-pf-val">{portfolio.totalParcels}</span>
              <span className="op-pf-label">Parcels</span>
            </div>
            <div className="op-pf-stat">
              <span className="op-pf-val">{fmtCurrency(portfolio.totalValue)}</span>
              <span className="op-pf-label">Total Value</span>
            </div>
            <div className="op-pf-stat">
              <span className="op-pf-val">{portfolio.totalAcres.toFixed(1)}</span>
              <span className="op-pf-label">Acres</span>
            </div>
          </div>
          <div className="op-portfolio-cities">
            {portfolio.cities.map(c => (
              <span key={c} className="op-pf-city">{c}</span>
            ))}
          </div>
          <div className="op-portfolio-list">
            {portfolio.parcels.slice(0, 20).map(p => (
              <div key={p.ain} className="op-pf-parcel">
                <span className="op-pf-ain">{p.ain}</span>
                <span className="op-pf-addr">{p.situsAddress}</span>
                <span className="op-pf-val-sm">{fmtCurrency(p.totalValue)}</span>
              </div>
            ))}
            {portfolio.totalParcels > 20 && (
              <div className="op-pf-more">+{portfolio.totalParcels - 20} more parcels</div>
            )}
          </div>
        </div>
      )}

      {/* Show portfolio button if not already shown */}
      {!showPortfolio && (
        <button className="op-portfolio-btn" onClick={loadPortfolio}>
          Show All Parcels by This Owner →
        </button>
      )}
    </div>
  )
}
