import { useEffect, useMemo, useRef, useState } from 'react'
import { displayPosition, effectiveUtcMs } from '../domain/types'
import { positionAtTime } from '../domain/positionAtTime'
import { useStore } from '../state/store'
import { formatUtc } from './format'

interface TimedPhoto {
  id: string
  t: number
  color: string
  selected: boolean
  /** Photo has a position (original GPS or assigned). */
  hasPos: boolean
  /** Not scanned yet: t is the file's mtime, refined once EXIF arrives. */
  provisional: boolean
}

const HEIGHT = 72
const DRAFT_LANE_Y = 2
const DRAFT_LANE_H = 10
const TRACK_LANE_Y = 15
const TRACK_LANE_H = 8
const TICK_TOP = 36
const MIN_SPAN_MS = 5_000

export function Timeline() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const photos = useStore((s) => s.photos)
  const sources = useStore((s) => s.sources)
  const tracks = useStore((s) => s.tracks)
  const selectedIds = useStore((s) => s.selectedIds)
  const cursorMs = useStore((s) => s.timelineCursorMs)
  const draft = useStore((s) => s.draft)
  const [brush, setBrush] = useState<{ x0: number; x1: number } | null>(null)
  const [hoverX, setHoverX] = useState<number | null>(null)
  const [width, setWidth] = useState(800)
  // Zoomed/panned view window; null = fit all data.
  const [view, setView] = useState<{ min: number; max: number } | null>(null)

  const timed: TimedPhoto[] = useMemo(() => {
    const out: TimedPhoto[] = []
    for (const p of Object.values(photos)) {
      const src = sources[p.sourceId]
      if (!src) continue
      // Unscanned photos appear immediately at their file mtime and move to
      // the exact EXIF position once the scan reaches them.
      const exact = effectiveUtcMs(p, src)
      const t = exact ?? (p.lastModified > 0 ? p.lastModified : undefined)
      if (t === undefined) continue
      out.push({
        id: p.id,
        t,
        color: src.color,
        selected: selectedIds.has(p.id),
        hasPos: displayPosition(p) !== undefined,
        provisional: exact === undefined,
      })
    }
    out.sort((a, b) => a.t - b.t)
    return out
  }, [photos, sources, selectedIds])

  const dataDomain = useMemo(() => {
    let min = Infinity
    let max = -Infinity
    for (const p of timed) {
      min = Math.min(min, p.t)
      max = Math.max(max, p.t)
    }
    for (const t of Object.values(tracks)) {
      min = Math.min(min, t.startMs)
      max = Math.max(max, t.endMs)
    }
    if (draft && draft.points.length > 0) {
      min = Math.min(min, draft.points[0].t)
      max = Math.max(max, draft.points[draft.points.length - 1].t)
    }
    if (!Number.isFinite(min)) return null
    const pad = Math.max(60_000, (max - min) * 0.02)
    return { min: min - pad, max: max + pad }
  }, [timed, tracks, draft])

  const domain = view ?? dataDomain

  useEffect(() => {
    const el = canvasRef.current?.parentElement
    if (!el) return
    const obs = new ResizeObserver(() => setWidth(el.clientWidth))
    obs.observe(el)
    setWidth(el.clientWidth)
    return () => obs.disconnect()
  }, [])

  const xOf = (t: number) => (domain ? ((t - domain.min) / (domain.max - domain.min)) * width : 0)
  const tOf = (x: number) => (domain ? domain.min + (x / width) * (domain.max - domain.min) : 0)

  const draftRange = useMemo(() => {
    if (!draft || draft.points.length === 0) return null
    return { start: draft.points[0].t, end: draft.points[draft.points.length - 1].t }
  }, [draft])

  const zoomAround = (anchorT: number, factor: number) => {
    const d = domain
    if (!d) return
    const span = Math.max(MIN_SPAN_MS, (d.max - d.min) * factor)
    let min = anchorT - (anchorT - d.min) * (span / (d.max - d.min))
    let max = min + span
    // When zoomed out beyond the data, snap back to fit.
    if (dataDomain && min <= dataDomain.min && max >= dataDomain.max) {
      setView(null)
      return
    }
    setView({ min, max })
  }

  const panBy = (deltaMs: number) => {
    const d = domain
    if (!d) return
    setView({ min: d.min + deltaMs, max: d.max + deltaMs })
  }

  // Wheel zoom/pan needs a non-passive listener to preventDefault.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const x = e.clientX - rect.left
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const d = domain
        if (d) panBy(((d.max - d.min) / width) * e.deltaX)
      } else {
        zoomAround(tOf(x), Math.exp(e.deltaY * 0.002))
      }
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain, width, dataDomain])

  // ---- drawing ----
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = HEIGHT * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, width, HEIGHT)
    if (!domain) {
      ctx.fillStyle = '#9a9a9a'
      ctx.font = '12px system-ui'
      ctx.fillText('Timeline — add photos and GPX tracks to see coverage', 12, HEIGHT / 2)
      return
    }

    // Draft bar (drag middle to shift, drag the end handles to stretch).
    if (draftRange) {
      const x0 = xOf(draftRange.start)
      const x1 = xOf(draftRange.end)
      ctx.fillStyle = 'rgba(255, 213, 79, 0.35)'
      ctx.fillRect(x0, DRAFT_LANE_Y, Math.max(4, x1 - x0), DRAFT_LANE_H)
      ctx.strokeStyle = '#ffd54f'
      ctx.setLineDash([4, 3])
      ctx.strokeRect(x0 + 0.5, DRAFT_LANE_Y + 0.5, Math.max(4, x1 - x0) - 1, DRAFT_LANE_H - 1)
      ctx.setLineDash([])
      // End handles for stretching.
      ctx.fillStyle = '#ffd54f'
      ctx.fillRect(x0 - 2, DRAFT_LANE_Y - 1, 4, DRAFT_LANE_H + 2)
      ctx.fillRect(x1 - 2, DRAFT_LANE_Y - 1, 4, DRAFT_LANE_H + 2)
      ctx.font = '9px system-ui'
      ctx.fillText('⇔ drag middle: shift · drag ends: stretch', Math.max(2, x0), DRAFT_LANE_Y + DRAFT_LANE_H + 8)
    }

    // Track coverage bars.
    let lane = 0
    for (const track of Object.values(tracks)) {
      for (const seg of track.segments) {
        const x0 = xOf(track.points[seg.startIdx].t)
        const x1 = xOf(track.points[seg.endIdx].t)
        ctx.fillStyle = track.color
        ctx.globalAlpha = 0.85
        ctx.fillRect(x0, TRACK_LANE_Y + (lane % 2) * (TRACK_LANE_H + 2), Math.max(2, x1 - x0), TRACK_LANE_H)
      }
      lane++
    }
    ctx.globalAlpha = 1

    // Photo ticks: dim without a position, short while unscanned (mtime
    // placeholder), green cap when GPS is present.
    for (const p of timed) {
      const x = xOf(p.t)
      if (x < -2 || x > width + 2) continue
      ctx.globalAlpha = p.provisional ? 0.25 : p.hasPos ? 1 : 0.4
      ctx.fillStyle = p.color
      ctx.fillRect(x - 1, TICK_TOP, 2, p.provisional ? 10 : p.selected ? 26 : 18)
      ctx.globalAlpha = 1
      if (p.hasPos) {
        ctx.fillStyle = '#6fca7c'
        ctx.fillRect(x - 1.5, TICK_TOP - 4, 3, 3)
      }
      if (p.selected) {
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(x - 1, TICK_TOP + 26, 2, 4)
      }
    }

    // Brush overlay.
    if (brush) {
      const x0 = Math.min(brush.x0, brush.x1)
      const x1 = Math.max(brush.x0, brush.x1)
      ctx.fillStyle = 'rgba(100, 149, 237, 0.25)'
      ctx.fillRect(x0, 0, x1 - x0, HEIGHT)
      ctx.strokeStyle = 'rgba(100, 149, 237, 0.9)'
      ctx.strokeRect(x0 + 0.5, 0.5, x1 - x0 - 1, HEIGHT - 1)
    }

    // Time cursor (also the default start for new manual tracks).
    if (cursorMs !== undefined && cursorMs >= domain.min && cursorMs <= domain.max) {
      const cx = xOf(cursorMs)
      ctx.strokeStyle = '#ffd54f'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(cx, 0)
      ctx.lineTo(cx, HEIGHT)
      ctx.stroke()
      ctx.lineWidth = 1
      ctx.fillStyle = '#ffd54f'
      ctx.beginPath()
      ctx.moveTo(cx - 5, 0)
      ctx.lineTo(cx + 5, 0)
      ctx.lineTo(cx, 7)
      ctx.closePath()
      ctx.fill()
    }

    if (hoverX !== null) {
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'
      ctx.beginPath()
      ctx.moveTo(hoverX + 0.5, 0)
      ctx.lineTo(hoverX + 0.5, HEIGHT)
      ctx.stroke()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timed, tracks, domain, width, brush, hoverX, cursorMs, draftRange])

  /** What part of the draft bar a coordinate hits: an end handle, the middle, or nothing. */
  const draftHit = (x: number, y: number): 'start' | 'end' | 'middle' | null => {
    if (!draftRange || y > DRAFT_LANE_Y + DRAFT_LANE_H + 4) return null
    const x0 = xOf(draftRange.start)
    const x1 = xOf(draftRange.end)
    const grip = 8
    if (Math.abs(x - x0) <= grip) return 'start'
    if (Math.abs(x - x1) <= grip) return 'end'
    if (x > x0 && x < x1) return 'middle'
    return null
  }

  /** Begin a stretch drag: one end moves, the other stays anchored. */
  const makeStretcher = (which: 'start' | 'end') => {
    const points = useStore.getState().draft?.points
    if (!points || points.length < 2) return null
    const anchorIndex = which === 'start' ? points.length - 1 : 0
    const moveIndex = which === 'start' ? 0 : points.length - 1
    const base = points.map((p) => ({ ...p }))
    return (x: number) => {
      useStore.getState().stretchDraft(anchorIndex, moveIndex, Math.round(tOf(x)), base)
    }
  }

  /** Click: set cursor, fly the map, focus the nearest photo. */
  const handleClick = (x: number) => {
    const state = useStore.getState()
    const t = tOf(x)
    state.setTimelineCursor(t)
    const point = positionAtTime(Object.values(state.tracks), Object.values(state.photos), state.sources, t)
    if (point) state.flyTo(point)
    // Focus the photo nearest in time (filmstrip scrolls to it).
    let best: TimedPhoto | undefined
    for (const p of timed) {
      if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p
    }
    if (best) {
      state.setSelection([best.id])
      state.setActivePhoto(best.id)
    }
  }

  const msPerPx = domain ? (domain.max - domain.min) / width : 0

  // ---- mouse interactions: draft-shift drag, brush, click ----
  const onMouseDown = (e: React.MouseEvent) => {
    if (!domain) return
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    const hit = draftHit(x, y)
    if (hit === 'start' || hit === 'end') {
      const stretch = makeStretcher(hit)
      if (!stretch) return
      const onMove = (ev: MouseEvent) => stretch(ev.clientX - rect.left)
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
      return
    }
    if (hit === 'middle') {
      let lastX = x
      const onMove = (ev: MouseEvent) => {
        const mx = ev.clientX - rect.left
        useStore.getState().shiftDraftTimes((mx - lastX) * msPerPx)
        lastX = mx
      }
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
      return
    }

    setBrush({ x0: x, x1: x })
    const onMove = (ev: MouseEvent) => {
      const mx = ev.clientX - rect.left
      setBrush((b) => (b ? { ...b, x1: mx } : b))
    }
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      const mx = ev.clientX - rect.left
      setBrush(null)
      if (Math.abs(mx - x) < 4) {
        handleClick(x)
        return
      }
      const t0 = tOf(Math.min(x, mx))
      const t1 = tOf(Math.max(x, mx))
      const ids = timed.filter((p) => p.t >= t0 && p.t <= t1).map((p) => p.id)
      useStore.getState().setSelection(ids)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // ---- touch interactions: pinch zoom, pan, draft-shift, tap ----
  const touchState = useRef<{
    mode: 'pan' | 'pinch' | 'draft' | 'stretch'
    lastX: number
    startX: number
    moved: boolean
    pinchDist?: number
    stretch?: (x: number) => void
  } | null>(null)

  const onTouchStart = (e: React.TouchEvent) => {
    if (!domain) return
    const rect = canvasRef.current!.getBoundingClientRect()
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX
      touchState.current = { mode: 'pinch', lastX: 0, startX: 0, moved: true, pinchDist: Math.abs(dx) }
      return
    }
    const x = e.touches[0].clientX - rect.left
    const y = e.touches[0].clientY - rect.top
    const hit = draftHit(x, y)
    if (hit === 'start' || hit === 'end') {
      const stretch = makeStretcher(hit)
      touchState.current = stretch
        ? { mode: 'stretch', lastX: x, startX: x, moved: false, stretch }
        : null
      return
    }
    touchState.current = {
      mode: hit === 'middle' ? 'draft' : 'pan',
      lastX: x,
      startX: x,
      moved: false,
    }
  }

  const onTouchMove = (e: React.TouchEvent) => {
    const st = touchState.current
    if (!st || !domain) return
    const rect = canvasRef.current!.getBoundingClientRect()
    if (st.mode === 'pinch' && e.touches.length === 2) {
      const dist = Math.abs(e.touches[0].clientX - e.touches[1].clientX)
      if (st.pinchDist && dist > 10) {
        const centerX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left
        zoomAround(tOf(centerX), st.pinchDist / dist)
        st.pinchDist = dist
      }
      return
    }
    if (e.touches.length !== 1) return
    const x = e.touches[0].clientX - rect.left
    const dx = x - st.lastX
    if (Math.abs(x - st.startX) > 6) st.moved = true
    if (st.mode === 'stretch') {
      st.stretch?.(x)
    } else if (st.mode === 'draft') {
      useStore.getState().shiftDraftTimes(dx * msPerPx)
    } else if (st.moved) {
      panBy(-dx * msPerPx)
    }
    st.lastX = x
  }

  const onTouchEnd = () => {
    const st = touchState.current
    touchState.current = null
    if (st && st.mode === 'pan' && !st.moved) handleClick(st.startX)
  }

  return (
    <div className="timeline">
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: HEIGHT, touchAction: 'none' }}
        onMouseDown={onMouseDown}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onMouseMove={(e) => {
          const rect = canvasRef.current!.getBoundingClientRect()
          setHoverX(e.clientX - rect.left)
        }}
        onMouseLeave={() => setHoverX(null)}
        onDoubleClick={() => setView(null)}
        title={
          hoverX !== null && domain
            ? `${formatUtc(tOf(hoverX))} — wheel: zoom, drag: select, double-click: fit`
            : 'Drag to select photos by time range; wheel to zoom'
        }
      />
      {view && (
        <button className="timeline-fit" title="Reset zoom to fit all data" onClick={() => setView(null)}>
          ⤢ fit
        </button>
      )}
    </div>
  )
}
