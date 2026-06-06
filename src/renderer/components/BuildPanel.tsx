/**
 * BuildPanel — Construction Simulator UI for ParcelExplorer
 * 
 * Triggered when a parcel is selected. Shows available building templates
 * based on UseCode, runs simulations, displays fit scores and earthwork
 * estimates. Per 3DBuild.md: "every 3D model on the map must come from
 * a stored build run."
 */

import { useState, useCallback, useEffect, useMemo } from 'react'
import type { Geometry } from 'geojson'
import type { BuildRunOutput, TerrainMetrics } from '@shared/types'
import { geometryFingerprint } from '@shared/sourceRegistry'

const api = (window as any).rentSeeker

interface BuildPanelProps {
  parcelId: string | null
  lat: number | null
  lng: number | null
  useCode: string | null
  squareFootage: number | null
  terrainMetrics: TerrainMetrics | null
  parcelGeometry?: Geometry | null
  visible: boolean
  onClose: () => void
  onRunComplete?: (run: BuildRunOutput) => void
}

// Building templates (must match buildSimulator.ts)
const TEMPLATES = [
  { id: 'sfr-2story', name: 'SFR (2-Story)', icon: '🏠', useCodes: ['0100', '0101', '0102', '010V'] },
  { id: 'sfr-3story', name: 'SFR (3-Story)', icon: '🏡', useCodes: ['0100', '0101', '0102', '010V'] },
  { id: 'duplex', name: 'Duplex', icon: '🏘', useCodes: ['0200', '0201', '0210'] },
  { id: 'adu', name: 'ADU', icon: '🏗', useCodes: ['0100', '0101', '0200'] },
  { id: 'small-apt', name: 'Apartment (4-unit)', icon: '🏢', useCodes: ['0300', '0301', '0302'] },
  { id: 'hillside-modern', name: 'Hillside Modern', icon: '🏔', useCodes: ['0100', '0101', '010V'] },
  { id: 'bucket-home', name: 'Bucket Home', icon: '⛏', useCodes: ['0100', '0101'] }
]

function fitScoreColor(score: number): string {
  if (score >= 75) return '#00ffc8'
  if (score >= 50) return '#ffcf5c'
  if (score >= 25) return '#ff8c42'
  return '#ff4444'
}

function flagLabel(flag: string): string {
  return flag.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

export function BuildPanel({ parcelId, lat, lng, useCode, squareFootage, terrainMetrics, parcelGeometry, visible, onClose, onRunComplete }: BuildPanelProps) {
  const [results, setResults] = useState<Map<string, BuildRunOutput>>(new Map())
  const [loading, setLoading] = useState<string | null>(null)
  const [selectedResult, setSelectedResult] = useState<string | null>(null)
  const [stories, setStories] = useState(2)

  // Filter templates by use code compatibility
  const availableTemplates = useMemo(() => {
    if (!useCode) return TEMPLATES
    const code = useCode.slice(0, 4)
    return TEMPLATES.filter(t =>
      t.useCodes.some(uc => code.startsWith(uc.slice(0, 2))) || t.useCodes.includes(code)
    )
  }, [useCode])

  // Run a simulation
  const runSimulation = useCallback(async (templateId: string) => {
    if (!parcelId || !lat || !lng) return
    setLoading(templateId)
    try {
      const result = await api.runBuildSimulation(
        { parcelId, templateId, stories, parcelGeometry },
        lat, lng, squareFootage || 5000
      )
      setResults(prev => new Map(prev).set(templateId, result))
      setSelectedResult(templateId)
      onRunComplete?.(result)
    } catch (err) {
      console.error('[BuildPanel] Simulation failed:', err)
    }
    setLoading(null)
  }, [parcelId, lat, lng, stories, squareFootage, parcelGeometry, onRunComplete])

  // Clear results when parcel changes
  useEffect(() => {
    setResults(new Map())
    setSelectedResult(null)
    if (!parcelId) return
    api.getBuildRunsForParcel(parcelId, geometryFingerprint(parcelGeometry ?? null))
      .then((runs: BuildRunOutput[]) => {
        const next = new Map<string, BuildRunOutput>()
        for (const run of runs) next.set(run.templateId, run)
        setResults(next)
        if (runs[0]) {
          setSelectedResult(runs[0].templateId)
          onRunComplete?.(runs[0])
        }
      })
      .catch(() => undefined)
  }, [parcelId, parcelGeometry, onRunComplete])

  if (!visible) return null

  const activeResult = selectedResult ? results.get(selectedResult) : null

  return (
    <div className="pe-build-panel">
      <div className="pe-build-header">
        <div className="pe-build-icon">🏗</div>
        <h3>Construction Simulator</h3>
        <button className="pe-build-close" onClick={onClose}>✕</button>
      </div>

      {/* Terrain summary */}
      {terrainMetrics && (
        <div className="pe-build-terrain-summary">
          <div className="pe-build-terrain-item">
            <span className="pe-build-t-label">Slope</span>
            <span className="pe-build-t-value" style={{ color: terrainMetrics.bestFitSlopePct > 30 ? '#ff6b6b' : terrainMetrics.bestFitSlopePct > 15 ? '#ffcf5c' : '#00ffc8' }}>
              {terrainMetrics.bestFitSlopePct.toFixed(1)}%
            </span>
          </div>
          <div className="pe-build-terrain-item">
            <span className="pe-build-t-label">Relief</span>
            <span className="pe-build-t-value">{terrainMetrics.demRelief.toFixed(0)}ft</span>
          </div>
          <div className="pe-build-terrain-item">
            <span className="pe-build-t-label">Pad Area</span>
            <span className="pe-build-t-value">{terrainMetrics.largestPadAreaSqft.toFixed(0)} sqft</span>
          </div>
          <div className="pe-build-terrain-item">
            <span className="pe-build-t-label">Drive Grade</span>
            <span className="pe-build-t-value">{terrainMetrics.drivewayGradeBestPct.toFixed(1)}%</span>
          </div>
        </div>
      )}

      {/* Story selector */}
      <div className="pe-build-stories">
        <label>Stories:</label>
        <div className="pe-build-story-btns">
          {[1, 2, 3, 4].map(s => (
            <button
              key={s}
              className={`pe-build-story-btn ${stories === s ? 'active' : ''}`}
              onClick={() => setStories(s)}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Template grid */}
      <div className="pe-build-templates">
        {availableTemplates.map(t => {
          const result = results.get(t.id)
          const isLoading = loading === t.id
          return (
            <button
              key={t.id}
              className={`pe-build-template-btn ${selectedResult === t.id ? 'selected' : ''} ${result ? 'has-result' : ''}`}
              onClick={() => result ? setSelectedResult(t.id) : runSimulation(t.id)}
              disabled={isLoading}
            >
              <span className="pe-build-tmpl-icon">{t.icon}</span>
              <span className="pe-build-tmpl-name">{t.name}</span>
              {isLoading && <span className="pe-build-tmpl-loading">⏳</span>}
              {result && (
                <span className="pe-build-tmpl-score" style={{ color: fitScoreColor(result.fitScore) }}>
                  {result.fitScore}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Active simulation result */}
      {activeResult && (
        <div className="pe-build-result">
          <div className="pe-build-result-header">
            <span className="pe-build-result-score" style={{ color: fitScoreColor(activeResult.fitScore) }}>
              {activeResult.fitScore}
            </span>
            <span className="pe-build-result-label">
              FIT SCORE
            </span>
          </div>

          <div className="pe-build-result-grid">
            <div className="pe-build-r-item">
              <span className="pe-build-r-label">Footprint</span>
              <span className="pe-build-r-value">{activeResult.footprintSqft.toLocaleString()} sqft</span>
            </div>
            <div className="pe-build-r-item">
              <span className="pe-build-r-label">Floor Area</span>
              <span className="pe-build-r-value">{activeResult.floorAreaSqft.toLocaleString()} sqft</span>
            </div>
            <div className="pe-build-r-item">
              <span className="pe-build-r-label">Height</span>
              <span className="pe-build-r-value">{activeResult.buildingHeightFt}ft</span>
            </div>
            <div className="pe-build-r-item">
              <span className="pe-build-r-label">Units</span>
              <span className="pe-build-r-value">{activeResult.estimatedUnits}</span>
            </div>
          </div>

          <div className="pe-build-earthwork">
            <h4>Earthwork</h4>
            <div className="pe-build-result-grid">
              <div className="pe-build-r-item">
                <span className="pe-build-r-label">Cut</span>
                <span className="pe-build-r-value">{activeResult.estimatedCutCy.toLocaleString()} CY</span>
              </div>
              <div className="pe-build-r-item">
                <span className="pe-build-r-label">Fill</span>
                <span className="pe-build-r-value">{activeResult.estimatedFillCy.toLocaleString()} CY</span>
              </div>
              <div className="pe-build-r-item">
                <span className="pe-build-r-label">Retaining Wall</span>
                <span className="pe-build-r-value">{activeResult.estimatedRetainingWallFt}ft × {activeResult.estimatedAvgRetainingHeightFt.toFixed(1)}ft</span>
              </div>
              <div className="pe-build-r-item">
                <span className="pe-build-r-label">Driveway</span>
                <span className="pe-build-r-value">{activeResult.estimatedDrivewayGradePct.toFixed(1)}%</span>
              </div>
              <div className="pe-build-r-item">
                <span className="pe-build-r-label">Flat Pad</span>
                <span className="pe-build-r-value">{activeResult.estimatedFlatPadSqft.toLocaleString()} sqft</span>
              </div>
            </div>
          </div>

          {/* Constraint flags */}
          {activeResult.constraintFlags.length > 0 && (
            <div className="pe-build-flags">
              {activeResult.constraintFlags.map(flag => (
                <span key={flag} className="pe-build-flag">{flagLabel(flag)}</span>
              ))}
            </div>
          )}

          <div className="pe-build-run-id">
            Run: {activeResult.runId.slice(0, 8)}
          </div>
        </div>
      )}
    </div>
  )
}

/* ═══════════════ BUILD TOGGLE BUTTON ═══════════════ */

interface BuildButtonProps {
  active: boolean
  onToggle: () => void
}

export function BuildToggleButton({ active, onToggle }: BuildButtonProps) {
  return (
    <button
      className={`pe-build-toggle ${active ? 'active' : ''}`}
      onClick={onToggle}
      title="Construction Simulator"
    >
      <span className="pe-build-toggle-icon">🏗</span>
    </button>
  )
}
