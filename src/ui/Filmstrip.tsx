import { useEffect, useMemo, useRef, useState } from 'react'
import type { Photo } from '../domain/types'
import { effectiveUtcMs, gpsStatus, isDirty } from '../domain/types'
import { useStore } from '../state/store'
import { formatUtc } from './format'

const ITEM_W = 108
const STATUS_LABEL: Record<string, string> = {
  original: 'GPS from file',
  assigned: 'assigned',
  manual: 'manual',
  none: 'no GPS',
}

export function Filmstrip() {
  const photos = useStore((s) => s.photos)
  const sources = useStore((s) => s.sources)
  const selectedIds = useStore((s) => s.selectedIds)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [viewWidth, setViewWidth] = useState(1200)
  const lastClickedRef = useRef<string | null>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const obs = new ResizeObserver(() => setViewWidth(el.clientWidth))
    obs.observe(el)
    setViewWidth(el.clientWidth)
    return () => obs.disconnect()
  }, [])

  const ordered: Photo[] = useMemo(() => {
    const list = Object.values(photos)
    const timeOf = (p: Photo) => {
      const src = sources[p.sourceId]
      return (src && effectiveUtcMs(p, src)) ?? p.lastModified
    }
    return list.sort((a, b) => timeOf(a) - timeOf(b) || a.id.localeCompare(b.id))
  }, [photos, sources])

  const first = Math.max(0, Math.floor(scrollLeft / ITEM_W) - 4)
  const count = Math.ceil(viewWidth / ITEM_W) + 8
  const visible = ordered.slice(first, first + count)

  const onItemClick = (photo: Photo, e: React.MouseEvent) => {
    const store = useStore.getState()
    if (e.shiftKey && lastClickedRef.current) {
      const a = ordered.findIndex((p) => p.id === lastClickedRef.current)
      const b = ordered.findIndex((p) => p.id === photo.id)
      if (a >= 0 && b >= 0) {
        const range = ordered.slice(Math.min(a, b), Math.max(a, b) + 1).map((p) => p.id)
        store.setSelection([...new Set([...store.selectedIds, ...range])])
        store.setActivePhoto(photo.id)
        return
      }
    }
    store.toggleSelected(photo.id, e.ctrlKey || e.metaKey)
    lastClickedRef.current = photo.id
  }

  if (ordered.length === 0) {
    return <div className="filmstrip filmstrip-empty">Add a photo folder to get started</div>
  }

  return (
    <div
      className="filmstrip"
      ref={scrollRef}
      onScroll={(e) => {
        setScrollLeft(e.currentTarget.scrollLeft)
        setViewWidth(e.currentTarget.clientWidth)
      }}
    >
      <div className="filmstrip-inner" style={{ width: ordered.length * ITEM_W }}>
        {visible.map((p, i) => {
          const idx = first + i
          const src = sources[p.sourceId]
          const status = gpsStatus(p)
          const t = src ? effectiveUtcMs(p, src) : undefined
          const selected = selectedIds.has(p.id)
          return (
            <div
              key={p.id}
              className={`film-item status-${status}${selected ? ' selected' : ''}`}
              style={{ left: idx * ITEM_W, borderTopColor: src?.color ?? '#888' }}
              onClick={(e) => onItemClick(p, e)}
              title={`${p.fileName}\n${formatUtc(t)}\n${STATUS_LABEL[status]}${p.scanError ? `\nscan error: ${p.scanError}` : ''}${p.writeError ? `\nwrite error: ${p.writeError}` : ''}`}
            >
              {p.thumbUrl ? (
                <img src={p.thumbUrl} alt="" draggable={false} />
              ) : (
                <div className="film-placeholder">{p.kind.toUpperCase()}</div>
              )}
              <div className="film-caption">
                <span className="film-name">{p.fileName}</span>
                <span className={`dot dot-${status}`} />
                {isDirty(p) && <span className="dirty-flag" title="Unsaved position">●</span>}
                {p.writeState === 'written' && <span className="written-flag" title={`Written (${p.writeTarget})`}>✓</span>}
                {p.writeState === 'write-error' && <span className="error-flag" title={p.writeError}>!</span>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
