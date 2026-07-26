import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Photo } from '../domain/types'
import { displayPosition, effectiveUtcMs, gpsStatus, isDirty } from '../domain/types'
import { positionAtTime } from '../domain/positionAtTime'
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
  const cursorMs = useStore((s) => s.timelineCursorMs)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [viewWidth, setViewWidth] = useState(1200)
  // Touch-friendly multi-select: taps toggle instead of replacing selection.
  const [multiSelect, setMultiSelect] = useState(false)
  // Filter: everything → only photos without a position (Android-stripped
  // excluded) → also photos whose GPS tags were stripped empty.
  const [filterMode, setFilterMode] = useState<'all' | 'untagged' | 'untagged+stripped'>('all')
  // Range mode ("from–to"): first tap marks the start, second tap selects the range.
  const [rangeMode, setRangeMode] = useState(false)
  const [rangeStart, setRangeStart] = useState<string | null>(null)
  const lastClickedRef = useRef<string | null>(null)
  // Desktop drag-to-scroll state; `moved` also suppresses the trailing click.
  const dragScroll = useRef({ moved: false })

  const onStripMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    const el = scrollRef.current
    if (!el) return
    e.preventDefault() // no text selection while dragging
    const startX = e.clientX
    const startScroll = el.scrollLeft
    dragScroll.current.moved = false
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX
      if (Math.abs(dx) > 4) dragScroll.current.moved = true
      if (dragScroll.current.moved) el.scrollLeft = startScroll - dx
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      // The click event fires after mouseup — reset the flag afterwards.
      setTimeout(() => {
        dragScroll.current.moved = false
      }, 0)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const allCount = Object.keys(photos).length
  // The stripped filter state only exists when stripped files are present.
  const hasStripped = useMemo(() => Object.values(photos).some((p) => p.meta?.gpsEmpty), [photos])
  useEffect(() => {
    if (!hasStripped) setFilterMode((m) => (m === 'untagged+stripped' ? 'untagged' : m))
  }, [hasStripped])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const obs = new ResizeObserver(() => setViewWidth(el.clientWidth))
    obs.observe(el)
    setViewWidth(el.clientWidth)
    // The strip has no vertical axis — plain wheel scrolls it horizontally.
    // Non-passive: the page behind must not scroll instead.
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return // native horizontal scroll
      e.preventDefault()
      el.scrollLeft += e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      obs.disconnect()
      el.removeEventListener('wheel', onWheel)
    }
    // The empty state renders without the scroll container — re-attach when
    // the first photos arrive (the ref is null before that).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allCount === 0])
  const timeOf = useCallback(
    (p: Photo) => {
      const src = sources[p.sourceId]
      return (src && effectiveUtcMs(p, src)) ?? p.lastModified
    },
    [sources]
  )

  const ordered: Photo[] = useMemo(() => {
    let list = Object.values(photos)
    if (filterMode === 'untagged') {
      // Stripped photos (empty GPS tags) had a position on the phone — they
      // are not "missing" a tag, so the base filter leaves them out.
      list = list.filter((p) => gpsStatus(p) === 'none' && !p.meta?.gpsEmpty)
    } else if (filterMode === 'untagged+stripped') {
      list = list.filter((p) => gpsStatus(p) === 'none')
    }
    return list.sort((a, b) => timeOf(a) - timeOf(b) || a.id.localeCompare(b.id))
  }, [photos, filterMode, timeOf])

  /**
   * Scroll to the moment the user pointed at (timeline click, or a photo
   * clicked elsewhere). The active photo is picked from ALL photos, so with a
   * filter on it often has no slot in the strip — then scroll to the shown
   * photo nearest that time instead of leaving the strip behind.
   */
  useEffect(() => {
    const el = scrollRef.current
    if (!el || ordered.length === 0) return
    let idx = activePhotoId ? ordered.findIndex((p) => p.id === activePhotoId) : -1
    if (idx < 0) {
      const activePhoto = activePhotoId ? photos[activePhotoId] : undefined
      const target = activePhoto ? timeOf(activePhoto) : cursorMs
      if (target === undefined) return
      let best = Infinity
      ordered.forEach((p, i) => {
        const delta = Math.abs(timeOf(p) - target)
        if (delta < best) {
          best = delta
          idx = i
        }
      })
    }
    if (idx < 0) return
    const left = idx * ITEM_W
    if (left < el.scrollLeft + ITEM_W || left > el.scrollLeft + el.clientWidth - ITEM_W * 2) {
      el.scrollTo({ left: left - el.clientWidth / 2 + ITEM_W / 2, behavior: 'smooth' })
    }
    // Re-runs on every cursor move too: clicking a second spot whose nearest
    // photo is already active would otherwise not scroll at all.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePhotoId, cursorMs])

  const first = Math.max(0, Math.floor(scrollLeft / ITEM_W) - 4)
  const count = Math.ceil(viewWidth / ITEM_W) + 8
  const visible = ordered.slice(first, first + count)

  // Thumbnails are generated lazily for what is (nearly) visible. Debounced:
  // during a scan the time-sorted order reshuffles with every metadata flush,
  // and the "visible window" would sweep across the whole set, requesting
  // thumbs for photos the user never looked at.
  useEffect(() => {
    const ids = visible.filter((p) => !p.thumbUrl).map((p) => p.id)
    if (ids.length === 0) return
    const timer = setTimeout(() => ensureThumbs(ids), 400)
    return () => clearTimeout(timer)
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
    // A drag-scroll gesture ends with a click on whatever item is under the
    // cursor — swallow it.
    if (dragScroll.current.moved) return
    const store = useStore.getState()
    // Move the timeline cursor (and view, if needed) to this photo's time.
    const src = store.sources[photo.sourceId]
    const t = src ? effectiveUtcMs(photo, src) : undefined
    if (t !== undefined) store.revealInTimeline(t)
    // Fly the map there too — to the photo's own position, or (like a
    // timeline click) to wherever tracks/other photos place that moment.
    const pos =
      displayPosition(photo) ??
      (t !== undefined
        ? positionAtTime(Object.values(store.tracks), Object.values(store.photos), store.sources, t)
        : undefined)
    if (pos) store.flyTo(pos)
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
          className={filterMode !== 'all' ? 'primary' : ''}
          title={
            hasStripped
              ? 'Cycle the filter: all photos → only photos without any position (Android-stripped ones excluded — they had GPS on the phone) → untagged plus stripped photos (GPS tags present but emptied)'
              : 'Toggle the filter: all photos ↔ only photos without any position'
          }
          onClick={() =>
            setFilterMode((m) =>
              m === 'all' ? 'untagged' : m === 'untagged' && hasStripped ? 'untagged+stripped' : 'all'
            )
          }
        >
          {filterMode === 'all'
            ? 'untagged only'
            : filterMode === 'untagged'
              ? `untagged ${ordered.length}/${allCount}`
              : `untagged+stripped ${ordered.length}/${allCount}`}
        </button>
      </div>
      <div
        className="filmstrip"
        ref={scrollRef}
        onMouseDown={onStripMouseDown}
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
              className={`film-item${selected ? ' selected' : ''}`}
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
