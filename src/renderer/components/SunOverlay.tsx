/**
 * SunOverlay — Sun Simulator UI for ParcelExplorer
 * 
 * The ONE bright element in the Industrial Theatre dark theme.
 * Renders a sun path arc, hourly shadow indicators, and a
 * time scrubber for visualizing sunlight across a parcel.
 */

import { useState, useCallback, useEffect } from 'react'
import type { Geometry } from 'geojson'
import type { SunAnalysis, SunAnalysisResponse } from '@shared/types'

const api = (window as any).rentSeeker

interface SunOverlayProps {
  parcelId: string | null
  lat: number | null
  lng: number | null
  parcelGeometry?: Geometry | null
  initialAnalysis?: SunAnalysis | null
  initialReason?: string | null
  statusLabel?: string | null
  visible: boolean
  onClose: () => void
}

export function SunOverlay({ parcelId, lat, lng, parcelGeometry, initialAnalysis = null, initialReason = null, statusLabel = null, visible, onClose }: SunOverlayProps) {
  const [analysis, setAnalysis] = useState<SunAnalysis | null>(initialAnalysis)
  const [loading, setLoading] = useState(false)
  const [notComputedReason, setNotComputedReason] = useState<string | null>(initialReason)
  const [selectedHour, setSelectedHour] = useState(12)
  const [season, setSeason] = useState<'summer' | 'equinox' | 'winter'>('summer')

  const dateForSeason = useCallback(() => {
    const year = new Date().getFullYear()
    switch (season) {
      case 'summer': return `${year}-06-21`
      case 'winter': return `${year}-12-21`
      case 'equinox': return `${year}-03-20`
    }
  }, [season])

  const runAnalysis = useCallback(async () => {
    if (!parcelId || !lat || !lng) return
    setLoading(true)
    try {
      const resp = await api.getSunAnalysis(parcelId, lat, lng, dateForSeason(), parcelGeometry ?? null) as SunAnalysisResponse
      if (resp?.computed && resp.analysis) {
        setAnalysis(resp.analysis)
        setNotComputedReason(null)
      } else {
        setAnalysis(null)
        setNotComputedReason(resp?.reason ?? 'Not computed')
      }
    } catch (err) {
      console.error('[SunOverlay] Analysis failed:', err)
      setAnalysis(null)
      setNotComputedReason(err instanceof Error ? err.message : String(err))
    }
    setLoading(false)
  }, [parcelId, lat, lng, parcelGeometry, dateForSeason])

  useEffect(() => {
    setAnalysis(initialAnalysis)
    setNotComputedReason(initialReason)
  }, [initialAnalysis, initialReason, parcelId])

  useEffect(() => {
    if (visible && parcelId) {
      void runAnalysis()
    }
  }, [visible, parcelId, season, runAnalysis])

  if (!visible) return null

  const sunriseFormatted = analysis
    ? `${Math.floor(analysis.sunriseHour)}:${String(Math.round((analysis.sunriseHour % 1) * 60)).padStart(2, '0')}`
    : '--:--'
  const sunsetFormatted = analysis
    ? `${Math.floor(analysis.sunsetHour)}:${String(Math.round((analysis.sunsetHour % 1) * 60)).padStart(2, '0')}`
    : '--:--'

  const currentObstruction = analysis?.hourlyObstruction.find(h => h.hour === selectedHour)
  const isExposed = currentObstruction ? currentObstruction.obstructionPct < 0.5 : true

  return (
    <div className="pe-sun-overlay">
      <div className="pe-sun-header">
        <div className="pe-sun-icon">☀</div>
        <h3>Sun Simulator</h3>
        {statusLabel && <span className="pe-overlay-status-chip">{statusLabel}</span>}
        <button className="pe-sun-close" onClick={onClose}>✕</button>
      </div>

  {loading && <div className="pe-sun-loading">Calculating solar path...</div>}

  {!loading && !analysis && notComputedReason && (
    <div className="pe-sun-loading">Sun analysis not computed: {notComputedReason}</div>
  )}

      {analysis && !loading && (
        <>
          {/* Sun path arc visualization */}
          <div className="pe-sun-arc">
            <svg viewBox="0 0 300 160" className="pe-sun-arc-svg">
              {/* Horizon line */}
              <line x1="10" y1="140" x2="290" y2="140" stroke="rgba(255,255,255,0.2)" strokeWidth="1" />
              <text x="15" y="155" fill="rgba(255,255,255,0.3)" fontSize="9">E</text>
              <text x="145" y="155" fill="rgba(255,255,255,0.3)" fontSize="9">S</text>
              <text x="275" y="155" fill="rgba(255,255,255,0.3)" fontSize="9">W</text>

              {/* Sun path arc */}
              <path
                d={`M 30 140 Q 150 ${20 + (season === 'winter' ? 60 : 0)} 270 140`}
                fill="none"
                stroke="rgba(255,200,50,0.6)"
                strokeWidth="2"
                strokeDasharray="4 2"
              />

              {/* Sun positions */}
              {analysis.sunPath
                .filter(p => p.altitudeDeg > 0 && p.minute === 0)
                .map((pos, i) => {
                  // Map azimuth to x (east=30, south=150, west=270)
                  const x = 30 + (pos.azimuthDeg - 90) / 180 * 240
                  // Map altitude to y (0=140, 90=10)
                  const y = 140 - (pos.altitudeDeg / 90) * 130
                  const isSelected = pos.hour === selectedHour
                  const hourObs = analysis.hourlyObstruction.find(h => h.hour === pos.hour)
                  const blocked = hourObs ? hourObs.obstructionPct > 0.5 : false

                  return (
                    <g key={i} onClick={() => setSelectedHour(pos.hour)} style={{ cursor: 'pointer' }}>
                      <circle
                        cx={Math.max(20, Math.min(280, x))}
                        cy={Math.max(10, Math.min(140, y))}
                        r={isSelected ? 10 : 6}
                        fill={blocked ? 'rgba(100,100,100,0.6)' : 'rgba(255,200,50,0.9)'}
                        stroke={isSelected ? '#fff' : 'none'}
                        strokeWidth={isSelected ? 2 : 0}
                      />
                      {isSelected && (
                        <text
                          x={Math.max(20, Math.min(280, x))}
                          y={Math.max(10, Math.min(140, y)) - 14}
                          fill="#fff"
                          fontSize="10"
                          textAnchor="middle"
                        >
                          {pos.hour}:00
                        </text>
                      )}
                    </g>
                  )
                })}
            </svg>
          </div>

          {/* Time scrubber */}
          <div className="pe-sun-scrubber">
            <input
              type="range"
              min={5}
              max={20}
              value={selectedHour}
              onChange={(e) => setSelectedHour(Number(e.target.value))}
              className="pe-sun-slider"
            />
            <div className="pe-sun-time-label">
              <span>{selectedHour}:00</span>
              <span className={`pe-sun-status ${isExposed ? 'exposed' : 'shaded'}`}>
                {isExposed ? '☀ Direct Sun' : '▓ Shaded'}
              </span>
            </div>
          </div>

          {/* Season selector */}
          <div className="pe-sun-seasons">
            {(['summer', 'equinox', 'winter'] as const).map(s => (
              <button
                key={s}
                className={`pe-sun-season-btn ${season === s ? 'active' : ''}`}
                onClick={() => setSeason(s)}
              >
                {s === 'summer' ? '☀ Jun 21' : s === 'winter' ? '❄ Dec 21' : '🌗 Mar 20'}
              </button>
            ))}
          </div>

          {/* Stats */}
          <div className="pe-sun-stats">
            <div className="pe-sun-stat">
              <span className="pe-sun-stat-label">Sunrise</span>
              <span className="pe-sun-stat-value">{sunriseFormatted}</span>
            </div>
            <div className="pe-sun-stat">
              <span className="pe-sun-stat-label">Sunset</span>
              <span className="pe-sun-stat-value">{sunsetFormatted}</span>
            </div>
            <div className="pe-sun-stat">
              <span className="pe-sun-stat-label">Daylight</span>
              <span className="pe-sun-stat-value">{analysis.totalDaylightHours.toFixed(1)}h</span>
            </div>
            <div className="pe-sun-stat highlight">
              <span className="pe-sun-stat-label">Direct Sun</span>
              <span className="pe-sun-stat-value">{analysis.directSunlightHours}h</span>
            </div>
          </div>

          {/* Obstructors */}
          {analysis.obstructors.length > 0 && (
            <div className="pe-sun-obstructors">
              <h4>Shadow Sources</h4>
              {analysis.obstructors.map((obs, i) => (
                <div key={i} className="pe-sun-obstruction-item">
                  <span className="pe-sun-obs-dir">{Math.round(obs.azimuthDeg)}°</span>
                  <span className="pe-sun-obs-desc">{obs.description}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/* ═══════════════ SUN TOGGLE BUTTON ═══════════════ */

interface SunButtonProps {
  active: boolean
  onToggle: () => void
}

export function SunToggleButton({ active, onToggle }: SunButtonProps) {
  return (
    <button
      className={`pe-sun-toggle ${active ? 'active' : ''}`}
      onClick={onToggle}
      title="Sun Simulator"
    >
      <span className="pe-sun-toggle-icon">☀</span>
    </button>
  )
}
