/**
 * ViewOverlay — View Analysis UI for ParcelExplorer
 * 
 * Shows which LA landmarks are visible from a parcel at a given
 * building height (stories × 11ft). Renders a viewshed compass,
 * visible/blocked landmark list, and a view score.
 */

import { useState, useCallback, useEffect } from 'react'
import type { Geometry } from 'geojson'
import type { ViewAnalysis, ViewAnalysisResponse } from '@shared/types'

const api = (window as any).rentSeeker

interface ViewOverlayProps {
  parcelId: string | null
  lat: number | null
  lng: number | null
  parcelGeometry?: Geometry | null
  visible: boolean
  onClose: () => void
}

export function ViewOverlay({ parcelId, lat, lng, parcelGeometry, visible, onClose }: ViewOverlayProps) {
  const [analysis, setAnalysis] = useState<ViewAnalysis | null>(null)
  const [loading, setLoading] = useState(false)
  const [notComputedReason, setNotComputedReason] = useState<string | null>(null)
  const [stories, setStories] = useState(2)

  const runAnalysis = useCallback(async () => {
    if (!parcelId || !lat || !lng) return
    setLoading(true)
    try {
      const resp = await api.getViewAnalysis(parcelId, lat, lng, stories, parcelGeometry ?? null) as ViewAnalysisResponse
      if (resp?.computed && resp.analysis) {
        setAnalysis(resp.analysis)
        setNotComputedReason(null)
      } else {
        setAnalysis(null)
        setNotComputedReason(resp?.reason ?? 'Not computed')
      }
    } catch (err) {
      console.error('[ViewOverlay] Analysis failed:', err)
      setAnalysis(null)
      setNotComputedReason(err instanceof Error ? err.message : String(err))
    }
    setLoading(false)
  }, [parcelId, lat, lng, parcelGeometry, stories])

  useEffect(() => {
    if (visible && parcelId) {
      void runAnalysis()
    }
  }, [visible, parcelId, stories, runAnalysis])

  if (!visible) return null

  return (
    <div className="pe-view-overlay">
      <div className="pe-view-header">
        <div className="pe-view-icon">🏔</div>
        <h3>View Analysis</h3>
        <button className="pe-view-close" onClick={onClose}>✕</button>
      </div>

      {/* Height selector */}
      <div className="pe-view-height">
        <label>Building Height:</label>
        <div className="pe-view-story-buttons">
          {[1, 2, 3, 4].map(s => (
            <button
              key={s}
              className={`pe-view-story-btn ${stories === s ? 'active' : ''}`}
              onClick={() => setStories(s)}
            >
              {s} {s === 1 ? 'Story' : 'Stories'}
              <span className="pe-view-story-ft">{s * 11}ft</span>
            </button>
          ))}
        </div>
      </div>

      {loading && <div className="pe-view-loading">Computing viewshed ({stories * 11}ft)...</div>}
      {!loading && !analysis && notComputedReason && (
        <div className="pe-view-loading">View analysis not computed: {notComputedReason}</div>
      )}

      {analysis && !loading && (
        <>
          {/* View Score */}
          <div className="pe-view-score-container">
            <div className="pe-view-score-ring">
              <svg viewBox="0 0 120 120" className="pe-view-score-svg">
                <circle cx="60" cy="60" r="50" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="8" />
                <circle
                  cx="60" cy="60" r="50"
                  fill="none"
                  stroke={analysis.viewScore >= 70 ? '#00ffc8' : analysis.viewScore >= 40 ? '#ffcf5c' : '#ff6b6b'}
                  strokeWidth="8"
                  strokeDasharray={`${(analysis.viewScore / 100) * 314} 314`}
                  strokeLinecap="round"
                  transform="rotate(-90 60 60)"
                />
                <text x="60" y="55" fill="#fff" fontSize="28" fontWeight="bold" textAnchor="middle" dominantBaseline="middle">
                  {analysis.viewScore}
                </text>
                <text x="60" y="75" fill="rgba(255,255,255,0.5)" fontSize="10" textAnchor="middle">
                  VIEW SCORE
                </text>
              </svg>
            </div>
            <div className="pe-view-score-meta">
              <div>Max view: {analysis.maxViewDistanceMi.toFixed(1)} mi</div>
              <div>Height: {analysis.viewerHeightFt}ft ({stories} stories)</div>
            </div>
          </div>

          {/* Viewshed compass */}
          <div className="pe-view-compass">
            <svg viewBox="0 0 200 200" className="pe-view-compass-svg">
              {/* Compass ring */}
              <circle cx="100" cy="100" r="85" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
              <circle cx="100" cy="100" r="60" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
              <circle cx="100" cy="100" r="35" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="1" />

              {/* Cardinal directions */}
              <text x="100" y="12" fill="rgba(255,255,255,0.4)" fontSize="10" textAnchor="middle">N</text>
              <text x="192" y="104" fill="rgba(255,255,255,0.4)" fontSize="10" textAnchor="middle">E</text>
              <text x="100" y="198" fill="rgba(255,255,255,0.4)" fontSize="10" textAnchor="middle">S</text>
              <text x="8" y="104" fill="rgba(255,255,255,0.4)" fontSize="10" textAnchor="middle">W</text>

              {/* Viewshed rays */}
              {analysis.viewshed.map((ray, i) => {
                const maxDist = 25 // max miles for compass scale
                const lengthPct = ray.obstructedAtMi !== null
                  ? Math.min(1, ray.obstructedAtMi / maxDist)
                  : 1
                const length = lengthPct * 80

                const azRad = (ray.azimuthDeg - 90) * (Math.PI / 180)
                const x2 = 100 + Math.cos(azRad) * length
                const y2 = 100 + Math.sin(azRad) * length

                const blocked = ray.obstructedAtMi !== null
                return (
                  <line
                    key={i}
                    x1="100" y1="100"
                    x2={x2} y2={y2}
                    stroke={blocked ? 'rgba(255,100,100,0.4)' : 'rgba(0,255,200,0.5)'}
                    strokeWidth={blocked ? 1 : 2}
                  />
                )
              })}

              {/* Center dot */}
              <circle cx="100" cy="100" r="4" fill="#00ffc8" />

              {/* Landmark markers */}
              {analysis.visibleLandmarks.map((vl, i) => {
                const dist = Math.min(1, vl.distanceMi / 25)
                const azRad = (vl.bearingDeg - 90) * (Math.PI / 180)
                const x = 100 + Math.cos(azRad) * (dist * 75)
                const y = 100 + Math.sin(azRad) * (dist * 75)
                return (
                  <g key={i}>
                    <circle cx={x} cy={y} r="5" fill="rgba(255,200,50,0.9)" stroke="#fff" strokeWidth="1" />
                    <text x={x} y={y - 8} fill="#ffcf5c" fontSize="7" textAnchor="middle">
                      {vl.landmark.name.split(' ')[0]}
                    </text>
                  </g>
                )
              })}
            </svg>
          </div>

          {/* Landmark lists */}
          <div className="pe-view-landmarks">
            {analysis.visibleLandmarks.length > 0 && (
              <div className="pe-view-landmark-section">
                <h4>✓ Visible</h4>
                {analysis.visibleLandmarks.map((vl, i) => (
                  <div key={i} className="pe-view-landmark-item visible">
                    <span className="pe-view-lm-icon">
                      {vl.landmark.category === 'skyline' ? '🏙' :
                       vl.landmark.category === 'monument' ? '🏛' :
                       vl.landmark.category === 'ocean' ? '🌊' : '⛰'}
                    </span>
                    <span className="pe-view-lm-name">{vl.landmark.name}</span>
                    <span className="pe-view-lm-dist">{vl.distanceMi.toFixed(1)} mi</span>
                    <span className="pe-view-lm-bearing">{Math.round(vl.bearingDeg)}°</span>
                  </div>
                ))}
              </div>
            )}

            {analysis.blockedLandmarks.length > 0 && (
              <div className="pe-view-landmark-section">
                <h4>✕ Blocked</h4>
                {analysis.blockedLandmarks.map((bl, i) => (
                  <div key={i} className="pe-view-landmark-item blocked">
                    <span className="pe-view-lm-icon">
                      {bl.landmark.category === 'skyline' ? '🏙' :
                       bl.landmark.category === 'monument' ? '🏛' :
                       bl.landmark.category === 'ocean' ? '🌊' : '⛰'}
                    </span>
                    <span className="pe-view-lm-name">{bl.landmark.name}</span>
                    <span className="pe-view-lm-blocked">{bl.blockedByDescription}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/* ═══════════════ VIEW TOGGLE BUTTON ═══════════════ */

interface ViewButtonProps {
  active: boolean
  onToggle: () => void
}

export function ViewToggleButton({ active, onToggle }: ViewButtonProps) {
  return (
    <button
      className={`pe-view-toggle ${active ? 'active' : ''}`}
      onClick={onToggle}
      title="View Analysis"
    >
      <span className="pe-view-toggle-icon">🏔</span>
    </button>
  )
}
