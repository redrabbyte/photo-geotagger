import { useEffect, useMemo, useRef, useState } from 'react'
import { effectiveUtcMs } from '../domain/types'
import { useStore } from '../state/store'
import { formatUtc } from './format'

interface TimedPhoto {
  id: string
  t: number
  color: string
  selected: boolean
}

const HEIGHT = 64
const TRACK_LANE_H = 8
const TICK_TOP = 26

export function Timeline() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const photos = useStore((s) => s.photos)
  const sources = useStore((s) => s.sources)
  const tracks = useStore((s) => s.tracks)
  const selectedIds = useStore((s) => s.selectedIds)
  const [brush, setBrush] = useState<{ x0: number; x1: number } | null>(null)
  const [hoverX, setHoverX] = useState<number | null>(null)
  const [width, setWidth] = useState(800)

  const timed: TimedPhoto[] = useMemo(() => {
    const out: TimedPhoto[] = []
    for (const p of Object.values(photos)) {
      const src = sources[p.sourceId]
      if (!src) continue
      const t = effectiveUtcMs(p, src)
      if (t === undefined) continue
      out.push({ id: p.id, t, color: src.color, selected: selectedIds.has(p.id) })
    }
    out.sort((a, b) => a.t - b.t)
    return out
  }, [photos, sources, selectedIds])

  const domain = useMemo(() => {
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
    if (!Number.isFinite(min)) return null
    const pad = Math.max(60_000, (max - min) * 0.02)
    return { min: min - pad, max: max + pad }
  }, [timed, tracks])

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

    // Track coverage bars.
    let lane = 0
    for (const track of Object.values(tracks)) {
      for (const seg of track.segments) {
        const x0 = xOf(track.points[seg.startIdx].t)
        const x1 = xOf(track.points[seg.endIdx].t)
        ctx.fillStyle = track.color
        ctx.globalAlpha = 0.85
        ctx.fillRect(x0, 6 + (lane % 2) * (TRACK_LANE_H + 2), Math.max(2, x1 - x0), TRACK_LANE_H)
      }
      lane++
    }
    ctx.globalAlpha = 1

    // Photo ticks.
    for (const p of timed) {
      const x = xOf(p.t)
      ctx.fillStyle = p.color
      ctx.fillRect(x - 1, TICK_TOP, 2, p.selected ? 26 : 18)
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

    if (hoverX !== null) {
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'
      ctx.beginPath()
      ctx.moveTo(hoverX + 0.5, 0)
      ctx.lineTo(hoverX + 0.5, HEIGHT)
      ctx.stroke()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timed, tracks, domain, width, brush, hoverX])

  const onMouseDown = (e: React.MouseEvent) => {
    if (!domain) return
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    setBrush({ x0: x, x1: x })

    const onMove = (ev: MouseEvent) => {
      const mx = ev.clientX - rect.left
      setBrush((b) => (b ? { ...b, x1: mx } : b))
    }
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      const mx = ev.clientX - rect.left
      const t0 = tOf(Math.min(x, mx))
      const t1 = tOf(Math.max(x, mx))
      setBrush(null)
      if (Math.abs(mx - x) < 4) return // treat as click, not brush
      const ids = timed.filter((p) => p.t >= t0 && p.t <= t1).map((p) => p.id)
      useStore.getState().setSelection(ids)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div className="timeline">
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: HEIGHT }}
        onMouseDown={onMouseDown}
        onMouseMove={(e) => {
          const rect = canvasRef.current!.getBoundingClientRect()
          setHoverX(e.clientX - rect.left)
        }}
        onMouseLeave={() => setHoverX(null)}
        title={hoverX !== null && domain ? formatUtc(tOf(hoverX)) : 'Drag to select photos by time range'}
      />
    </div>
  )
}
