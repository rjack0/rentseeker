/**
 * LoadingCinema — Cinematic loading experience for RentSeeker
 * 
 * Full-screen dark canvas with:
 *   - Large animated "RentSeeker" title
 *   - Each dataset loads in with its own color + animation
 *   - Row counts animate up as data loads
 *   - L-System fractal city draws itself in the background
 *   - Progress bar across bottom
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import type { CSSProperties, RefObject } from 'react'
import type { DataLoadStep } from '@shared/types'

/* ═══════════════ DATASET CONFIG ═══════════════ */

export const DATASET_MANIFEST: DataLoadStep[] = [
  { datasetName: 'LA County Assessor Parcels', color: '#00d4ff', status: 'pending', rowCount: 0, elapsedMs: 0 },
  { datasetName: 'Secured Basic File (SBF)', color: '#ffde59', status: 'pending', rowCount: 0, elapsedMs: 0 },
  { datasetName: 'Certificate of Occupancy', color: '#ff7a45', status: 'pending', rowCount: 0, elapsedMs: 0 },
  { datasetName: 'Building Permits 2020+', color: '#a78bfa', status: 'pending', rowCount: 0, elapsedMs: 0 },
  { datasetName: 'Electrical Permits 2020+', color: '#34d399', status: 'pending', rowCount: 0, elapsedMs: 0 },
  { datasetName: 'Building Permits Submitted', color: '#f472b6', status: 'pending', rowCount: 0, elapsedMs: 0 },
  { datasetName: 'Inspections', color: '#94a3b8', status: 'pending', rowCount: 0, elapsedMs: 0 },
  { datasetName: 'Parcel Boundary Lines', color: '#abff02', status: 'pending', rowCount: 0, elapsedMs: 0 }
]

/* ═══════════════ L-SYSTEM ENGINE ═══════════════ */

interface LState {
  x: number
  y: number
  angle: number
}

/**
 * Lindenmayer system that draws a fractal city grid.
 * Axiom: F+F+F+F (square seed)
 * Rules:
 *   F → F+F-F-FF+F+F-F (produces organic block patterns)
 *   + → turn right 90°
 *   - → turn left 90°
 *   [ → push state (branch)
 *   ] → pop state (return)
 */
function generateLSystem(iterations: number): string {
  // Plan 01 intent: organic street grid.
  // Axiom + rule chosen to draw city-block branching linework.
  let current = 'F'
  const rules: Record<string, string> = {
    'F': 'F[+F]F[-F]F'
  }

  for (let i = 0; i < iterations; i++) {
    let next = ''
    for (const ch of current) {
      next += rules[ch] ?? ch
    }
    current = next
    // Cap length to prevent memory issues
    if (current.length > 200000) break
  }
  return current
}

/**
 * Pre-compute all line segments from the L-system string.
 * Returns an array of [x1, y1, x2, y2] segments.
 */
function lSystemToSegments(
  system: string,
  startX: number,
  startY: number,
  stepSize: number,
  angleDelta: number = 90
): [number, number, number, number][] {
  const segments: [number, number, number, number][] = []
  let x = startX
  let y = startY
  let angle = 0
  const stack: LState[] = []
  const rad = (a: number) => (a * Math.PI) / 180

  for (const ch of system) {
    switch (ch) {
      case 'F': {
        const nx = x + stepSize * Math.cos(rad(angle))
        const ny = y + stepSize * Math.sin(rad(angle))
        segments.push([x, y, nx, ny])
        x = nx
        y = ny
        break
      }
      case '+':
        angle += angleDelta
        break
      case '-':
        angle -= angleDelta
        break
      case '[':
        stack.push({ x, y, angle })
        break
      case ']': {
        const s = stack.pop()
        if (s) { x = s.x; y = s.y; angle = s.angle }
        break
      }
    }
  }
  return segments
}

/* ═══════════════ L-SYSTEM CANVAS ═══════════════ */

function useLSystemAnimation(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  active: boolean,
  progressPct: number
) {
  const animFrameRef = useRef<number>(0)
  const segmentIndexRef = useRef(0)
  const targetIndexRef = useRef(0)
  const segmentsRef = useRef<[number, number, number, number][]>([])
  const transformRef = useRef<{ scale: number; offsetX: number; offsetY: number } | null>(null)

  useEffect(() => {
    if (!active) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Size canvas to window
    const dpr = window.devicePixelRatio || 1
    canvas.width = window.innerWidth * dpr
    canvas.height = window.innerHeight * dpr
    ctx.scale(dpr, dpr)

    // Generate L-system (2 iterations keeps it manageable)
    const system = generateLSystem(3)
    const stepSize = Math.max(2, Math.min(window.innerWidth, window.innerHeight) / 180)
    const segments = lSystemToSegments(
      system,
      window.innerWidth * 0.15,
      window.innerHeight * 0.5,
      stepSize
    )
    segmentsRef.current = segments

    // Determine bounds and center
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const [x1, y1, x2, y2] of segments) {
      minX = Math.min(minX, x1, x2)
      maxX = Math.max(maxX, x1, x2)
      minY = Math.min(minY, y1, y2)
      maxY = Math.max(maxY, y1, y2)
    }
    const scaleX = (window.innerWidth * 0.8) / (maxX - minX || 1)
    const scaleY = (window.innerHeight * 0.8) / (maxY - minY || 1)
    const scale = Math.min(scaleX, scaleY, 1)
    const offsetX = (window.innerWidth - (maxX - minX) * scale) / 2 - minX * scale
    const offsetY = (window.innerHeight - (maxY - minY) * scale) / 2 - minY * scale
    transformRef.current = { scale, offsetX, offsetY }

    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight)
    segmentIndexRef.current = 0
    targetIndexRef.current = 0

    const segmentsPerFrame = Math.max(1, Math.floor(segments.length / 420))

    function draw() {
      if (!ctx) return
      const target = targetIndexRef.current
      const end = Math.min(segmentIndexRef.current + segmentsPerFrame, target)

      for (let i = segmentIndexRef.current; i < end; i++) {
        const [x1, y1, x2, y2] = segments[i]
        const progress = i / segments.length
        const alpha = 0.08 + progress * 0.12

        ctx.beginPath()
        ctx.moveTo(x1 * scale + offsetX, y1 * scale + offsetY)
        ctx.lineTo(x2 * scale + offsetX, y2 * scale + offsetY)
        ctx.strokeStyle = i % 5 === 0 ? `rgba(171, 255, 2, ${alpha})` : `rgba(255, 255, 255, ${alpha * 0.65})`
        ctx.lineWidth = 0.5
        ctx.stroke()
      }

      segmentIndexRef.current = end

      if (segmentIndexRef.current < targetIndexRef.current) {
        animFrameRef.current = requestAnimationFrame(draw)
      }
    }

    animFrameRef.current = requestAnimationFrame(draw)

    return () => {
      cancelAnimationFrame(animFrameRef.current)
    }
  }, [active, canvasRef])

  useEffect(() => {
    if (!active) return
    const segments = segmentsRef.current
    if (!segments.length) return
    const target = Math.max(0, Math.min(segments.length, Math.floor((progressPct / 100) * segments.length)))
    targetIndexRef.current = target
    if (segmentIndexRef.current < target) {
      cancelAnimationFrame(animFrameRef.current)
      animFrameRef.current = requestAnimationFrame(() => {
        const canvas = canvasRef.current
        const ctx = canvas?.getContext('2d')
        const t = transformRef.current
        if (!ctx || !t) return
        // continue drawing with the same loop logic
        const segmentsPerFrame = Math.max(1, Math.floor(segments.length / 420))
        const draw = () => {
          const end = Math.min(segmentIndexRef.current + segmentsPerFrame, targetIndexRef.current)
          for (let i = segmentIndexRef.current; i < end; i++) {
            const [x1, y1, x2, y2] = segments[i]
            const progress = i / segments.length
            const alpha = 0.08 + progress * 0.12
            ctx.beginPath()
            ctx.moveTo(x1 * t.scale + t.offsetX, y1 * t.scale + t.offsetY)
            ctx.lineTo(x2 * t.scale + t.offsetX, y2 * t.scale + t.offsetY)
            ctx.strokeStyle = i % 5 === 0 ? `rgba(171, 255, 2, ${alpha})` : `rgba(255, 255, 255, ${alpha * 0.65})`
            ctx.lineWidth = 0.5
            ctx.stroke()
          }
          segmentIndexRef.current = end
          if (segmentIndexRef.current < targetIndexRef.current) {
            animFrameRef.current = requestAnimationFrame(draw)
          }
        }
        animFrameRef.current = requestAnimationFrame(draw)
      })
    }
  }, [active, progressPct, canvasRef])
}

/* ═══════════════ ANIMATED NUMBER ═══════════════ */

function AnimatedNumber({ value, duration = 1200 }: { value: number; duration?: number }) {
  const [display, setDisplay] = useState(0)
  const frameRef = useRef<number>(0)

  useEffect(() => {
    const start = display
    const diff = value - start
    const t0 = performance.now()

    function tick() {
      const elapsed = performance.now() - t0
      const pct = Math.min(1, elapsed / duration)
      // Ease out cubic
      const eased = 1 - Math.pow(1 - pct, 3)
      setDisplay(Math.round(start + diff * eased))
      if (pct < 1) frameRef.current = requestAnimationFrame(tick)
    }

    frameRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frameRef.current)
  }, [value])

  return <span>{display.toLocaleString()}</span>
}

/* ═══════════════ LOADING CINEMA COMPONENT ═══════════════ */

interface LoadingCinemaProps {
  steps: DataLoadStep[]
  onComplete?: () => void
  revealing?: boolean
  assembling?: boolean
}

export function LoadingCinema({ steps, onComplete, revealing = false, assembling = false }: LoadingCinemaProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [visibleStepNames, setVisibleStepNames] = useState<string[]>([])

  const allDone = steps.every(s => s.status === 'done' || s.status === 'error')
  const totalRows = steps.reduce((s, step) => s + step.rowCount, 0)
  const doneSteps = steps.filter(s => s.status === 'done').length
  const overallPct = steps.length > 0 ? (doneSteps / steps.length) * 100 : 0

  // Animate L-system in background
  useLSystemAnimation(canvasRef, true, overallPct)

  // Only reveal steps as they actually start (loading/done/error), so the list reflects real progress.
  useEffect(() => {
    setVisibleStepNames((current) => {
      const next = new Set(current)
      for (const step of steps) {
        if (step.status !== 'pending') next.add(step.datasetName)
      }
      return [...next]
    })
  }, [steps])

  return (
    <div className={`lc-container ${revealing ? 'revealing' : ''} ${assembling ? 'assembling' : ''}`}>
      {/* L-System background canvas */}
      <canvas ref={canvasRef} className="lc-canvas" />

      {/* Content overlay */}
      <div className="lc-content">
        {/* Title */}
        <div className="lc-title">
          <span className="lc-title-rent">Rent</span>
          <span className="lc-title-seeker">Seeker</span>
        </div>
        <div className="lc-subtitle">Live Parcel Assembly</div>

        {/* Dataset loading list */}
        <div className="lc-datasets">
          {steps.filter(step => visibleStepNames.includes(step.datasetName)).map((step, i) => {
            const displayName =
              step.status === 'loading'
                ? step.datasetName.replace(/\bready\b/ig, 'loading').replace(/\bloaded\b/ig, 'loading')
                : step.datasetName

            const variant =
              /owner|secured basic file|\(sbf\)/i.test(step.datasetName) ? 'right'
              : /certificate of occupancy|cofo/i.test(step.datasetName) ? 'up'
              : /building permits 2020\+|electrical permits 2020\+/i.test(step.datasetName) ? 'type'
              : /submitted/i.test(step.datasetName) ? 'glitch'
              : 'left'

            const animClass =
              step.status === 'done' ? 'lc-step-done' :
              step.status === 'loading' ? 'lc-step-loading' :
              step.status === 'error' ? 'lc-step-error' :
              'lc-step-pending'

            const animStyle = {
              '--step-color': step.color,
              '--step-delay': `${i * 0.15}s`
            } as CSSProperties

            return (
              <div key={step.datasetName} className={`lc-step ${animClass} lc-step-${variant}`} style={animStyle}>
                <div className="lc-step-indicator" />
                <div className="lc-step-name">{displayName}</div>
                <div className="lc-step-count">
                  {step.status === 'done' && <AnimatedNumber value={step.rowCount} />}
                  {step.status === 'loading' && <span className="lc-step-spinner">⟳</span>}
                  {step.status === 'error' && <span className="lc-step-err">✕</span>}
                </div>
                {step.status !== 'pending' && step.elapsedMs > 0 && (
                  <div className="lc-step-time">{(step.elapsedMs / 1000).toFixed(1)}s</div>
                )}
              </div>
            )
          })}
        </div>

        {/* Total row counter */}
        <div className="lc-total">
          <span className="lc-total-label">Records Indexed</span>
          <span className="lc-total-value"><AnimatedNumber value={totalRows} /></span>
        </div>

        {/* Progress bar */}
        <div className="lc-progress-bar">
          <div
            className="lc-progress-fill"
            style={{ width: `${overallPct}%` }}
          />
        </div>

        {allDone && (
          <div className="lc-ready">
            <span className="lc-ready-text">Intelligence Ready</span>
          </div>
        )}
      </div>
    </div>
  )
}
