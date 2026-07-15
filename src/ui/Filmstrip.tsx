import { useEffect, useMemo, useRef, useState } from 'react'
import type { Photo } from '../domain/types'
import { effectiveUtcMs, gpsStatus, isDirty } from '../domain/types'
import { useStore } from '../state/store'
import { ensureThumbs } from '../services/appActions'
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
  const activePhotoId = useStore((s) => s.activePhotoId)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [viewWidth, setViewWidth] = useState(1200)
  // Touch-friendly multi-select: taps toggle instead of replacing selection.
  const [multiSelect, setMultiSelect] = useState(false)
  // Hide photos that already have a position (original GPS, sidecar, or assigned).
  const [hideTagged, setHideTagged] = useState(false)
  // Range mode ("from–to"): first tap marks the start, second tap selects the range.
  const [rangeMode, setRangeMode] = useState(false)
  const [rangeStart, setRangeStart] = useState<string | null>(null)
  const lastClickedRef = useRef<string | null>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const obs = new ResizeObserver(() => setViewWidth(el.clientWidth))
    obs.observe(el)
    setViewWidth(el.clientWidth)
    return () => obs.disconnect()
  }, [])

  const allCount = Object.keys(photos).length
  const ordered: Photo[] = useMemo(() => {
    let list = Object.values(photos)
    if (hideTagged) list = list.filter((p) => gpsStatus(p) === 'none')
    const timeOf = (p: Photo) => {
      const src = sources[p.sourceId]
      return (src && effectiveUtcMs(p, src)) ?? p.lastModified
    }
    return list.sort((a, b) => timeOf(a) - timeOf(b) || a.id.localeCompare(b.id))
  }, [photos, sources, hideTagged])

  // Scroll the active photo into view (e.g. after a timeline click).
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !activePhotoId) return
    const idx = ordered.findIndex((p) => p.id === activePhotoId)
    if (idx < 0) return
    const left = idx * ITEM_W
    if (left < el.scrollLeft + ITEM_W || left > el.scrollLeft + el.clientWidth - ITEM_W * 2) {
      el.scrollTo({ left: left - el.clientWidth / 2 + ITEM_W / 2, behavior: 'smooth' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePhotoId])

  const first = Math.max(0, Math.floor(scrollLeft / ITEM_W) - 4)
  const count = Math.ceil(viewWidth / ITEM_W) + 8
  const visible = ordered.slice(first, first + count)

  // Thumbnails are generated lazily for what is (nearly) visible.
  useEffect(() => {
    const ids = visible.filter((p) => !p.thumbUrl).map((p) => p.id)
    if (ids.length > 0) ensureThumbs(ids)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first, count, ordered])

  const selectRange = (fromId: string, toId: string, additive: boolean) => {
    const store = useStore.getState()
    const a = ordered.findIndex((p) => p.id === fromId)
    const b = ordered.findIndex((p) => p.id === toId)
    if (a < 0 || b < 0) return
    const range = ordered.slice(Math.min(a, b), Math.max(a, b) + 1).map((p) => p.id)
    store.setSelection(additive ? [...new Set([...store.selectedIds, ...range])] : range)
    store.setActivePhoto(toId)
  }

  const onItemClick = (photo: Photo, e: React.MouseEvent) => {
    const store = useStore.getState()
    // Move the timeline cursor (and view, if needed) to this photo's time.
    const src = store.sources[photo.sourceId]
    const t = src ? effectiveUtcMs(photo, src) : undefined
    if (t !== undefined) store.revealInTimeline(t)
    if (rangeMode) {
      if (!rangeStart) {
        setRangeStart(photo.id)
        store.toggleSelected(photo.id, true)
      } else {
        selectRange(rangeStart, photo.id, true)
        setRangeStart(null)
      }
      return
    }
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
    store.toggleSelected(photo.id, e.ctrlKey || e.metaKey || multiSelect)
    lastClickedRef.current = photo.id
  }

  if (allCount === 0) {
    return <div className="filmstrip filmstrip-empty">Add a photo folder to get started</div>
  }

  return (
    <div className="filmstrip-wrap">
      <div className="filmstrip-toolbar">
        <button
          className={multiSelect ? 'primary' : ''}
          title="Multi-select mode: every tap adds/removes a photo from the selection (for touch screens without Ctrl/Shift)"
          onClick={() => setMultiSelect((v) => !v)}
        >
          ☑ multi
        </button>
        <button
          className={rangeMode ? 'primary' : ''}
          title="Range select: tap the first photo, then the last — everything in between is selected (added to the current selection)"
          onClick={() => {
            setRangeMode((v) => !v)
            setRangeStart(null)
          }}
        >
          {rangeMode && rangeStart ? 'a…?' : 'a…b'}
        </button>
        {selectedIds.size > 0 && (
          <>
            <span className="muted small">{selectedIds.size} selected</span>
            <button onClick={() => useStore.getState().setSelection([])}>none</button>
          </>
        )}
        <button
          title="Select all photos (with the filter active: all shown photos)"
          onClick={() => useStore.getState().setSelection(ordered.map((p) => p.id))}
        >
          all
        </button>
        <button
          className={hideTagged ? 'primary' : ''}
          title="Show only photos that have no position yet — original GPS, sidecar GPS, and assigned positions are hidden"
          onClick={() => setHideTagged((v) => !v)}
        >
          {hideTagged ? `untagged ${ordered.length}/${allCount}` : 'untagged only'}
        </button>
      </div>
      <div
        className="filmstrip"
        ref={scrollRef}
      onScroll={(e) => {
        setScrollLeft(e.currentTarget.scrollLeft)
        setViewWidth(e.currentTarget.clientWidth)
      }}
    >
      {ordered.length === 0 && (
        <div className="filmstrip-empty">All photos have a position — filter active</div>
      )}
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
                {p.scanState === 'error' && <span className="error-flag" title={p.scanError}>!</span>}
              </div>
            </div>
          )
        })}
        </div>
      </div>
    </div>
  )
}
