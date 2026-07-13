import { useEffect, useMemo, useState } from 'react'
import { isStale } from '../domain/matching'
import { useStore } from '../state/store'
import {
  addFilesFlow,
  addGpxFlow,
  addSourceFlow,
  listRestorableGpx,
  listRestorableSources,
  type RestorableGpx,
  type RestorableSource,
} from '../services/appActions'
import { positionAtTime } from '../domain/positionAtTime'
import { formatOffset, parseOffset } from './format'

function OffsetEditor({ sourceId, value }: { sourceId: string; value: number }) {
  const [text, setText] = useState(formatOffset(value))
  useEffect(() => setText(formatOffset(value)), [value])

  const commit = () => {
    const ms = parseOffset(text)
    const store = useStore.getState()
    if (ms === undefined) {
      store.notify('error', `Cannot parse offset "${text}" — use ±hh:mm:ss`)
      setText(formatOffset(value))
      return
    }
    store.updateSource(sourceId, { clockOffsetMs: ms })
  }

  return (
    <span className="offset-editor" title="Clock correction added to this source's photo times (±hh:mm:ss). Use when the camera clock was wrong.">
      <input
        value={text}
        size={9}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
      <button title="+1 hour (DST / timezone off-by-one)" onClick={() => useStore.getState().updateSource(sourceId, { clockOffsetMs: value + 3600_000 })}>+1h</button>
      <button title="-1 hour" onClick={() => useStore.getState().updateSource(sourceId, { clockOffsetMs: value - 3600_000 })}>−1h</button>
    </span>
  )
}

export function SourcesPanel() {
  const sources = useStore((s) => s.sources)
  const photos = useStore((s) => s.photos)
  const tracks = useStore((s) => s.tracks)
  const scanning = useStore((s) => s.scanning)
  const [restorable, setRestorable] = useState<RestorableSource[]>([])
  const [restorableGpx, setRestorableGpx] = useState<RestorableGpx[]>([])
  const [showNewTrack, setShowNewTrack] = useState(false)

  useEffect(() => {
    listRestorableSources().then(setRestorable).catch(() => setRestorable([]))
    listRestorableGpx().then(setRestorableGpx).catch(() => setRestorableGpx([]))
  }, [])

  const counts = useMemo(() => {
    const bySource: Record<string, { total: number; withGps: number; stale: number }> = {}
    for (const p of Object.values(photos)) {
      const c = (bySource[p.sourceId] ??= { total: 0, withGps: 0, stale: 0 })
      c.total++
      if (p.meta?.originalGps || p.assignment) c.withGps++
      const src = sources[p.sourceId]
      if (src && isStale(p, src)) c.stale++
    }
    return bySource
  }, [photos, sources])

  const sourceList = Object.values(sources)
  const trackList = Object.values(tracks)
  const shownRestorable = restorable.filter((r) => !sourceList.some((s) => s.name === r.name))
  const shownRestorableGpx = restorableGpx.filter((g) => !trackList.some((t) => t.fileName === g.name))

  const reassignStale = (sourceId: string) => {
    const store = useStore.getState()
    const staleIds = Object.values(store.photos)
      .filter((p) => p.sourceId === sourceId && store.sources[sourceId] && isStale(p, store.sources[sourceId]))
      .map((p) => p.id)
    if (staleIds.length === 0) return
    const prevSelection = [...store.selectedIds]
    store.setSelection(staleIds)
    // Re-run each photo's original method; group by method for correctness.
    const byMethod = new Map<string, string[]>()
    for (const id of staleIds) {
      const m = store.photos[id].assignment?.method
      if (m && m !== 'manual' && m !== 'manual-on-track') {
        byMethod.set(m, [...(byMethod.get(m) ?? []), id])
      }
    }
    let total = 0
    for (const [method, ids] of byMethod) {
      store.setSelection(ids)
      total += store.assignSelected(method as Parameters<typeof store.assignSelected>[0]).assigned
    }
    store.setSelection(prevSelection)
    store.notify('success', `Re-matched ${total} photo(s) with the new clock offset`)
  }

  return (
    <div className="sources-panel">
      <div className="panel-header">
        <h3>Sources</h3>
        <span className="button-row">
          <button onClick={() => void addSourceFlow()}>+ Folder</button>
          <button title="Pick individual image files instead of a whole folder" onClick={() => void addFilesFlow()}>+ Files</button>
        </span>
      </div>
      {scanning && <div className="scanning-note">Scanning photos…</div>}

      {sourceList.length === 0 && <p className="muted">Each folder becomes a source (e.g. “Phone”, “Sony A7”) with its own color and clock correction.</p>}

      {sourceList.map((s) => {
        const c = counts[s.id] ?? { total: 0, withGps: 0, stale: 0 }
        return (
          <div className="source-item" key={s.id}>
            <div className="source-row">
              <span className="color-chip" style={{ background: s.color }} />
              <input
                className="source-name"
                value={s.name}
                onChange={(e) => useStore.getState().updateSource(s.id, { name: e.target.value })}
              />
              <span className="muted">{c.withGps}/{c.total}</span>
              <button className="remove" title="Remove source (files are untouched)" onClick={() => useStore.getState().removeSource(s.id)}>×</button>
            </div>
            <div className="source-row">
              <span className="muted small">Clock</span>
              <OffsetEditor sourceId={s.id} value={s.clockOffsetMs} />
            </div>
            <div className="source-row">
              <span className="muted small" title="Timezone assumed for photos whose EXIF has no timezone offset">TZ</span>
              <select
                value={s.assumedTzOffsetMin}
                onChange={(e) => useStore.getState().updateSource(s.id, { assumedTzOffsetMin: parseInt(e.target.value, 10) })}
              >
                {Array.from({ length: 27 }, (_, i) => (i - 12) * 60).map((min) => (
                  <option key={min} value={min}>
                    UTC{min === 0 ? '' : formatOffset(min * 60_000).slice(0, 6)}
                  </option>
                ))}
              </select>
              {c.stale > 0 && (
                <button className="warn-btn" title="Clock offset changed after matching — recompute" onClick={() => reassignStale(s.id)}>
                  re-match {c.stale} stale
                </button>
              )}
            </div>
          </div>
        )
      })}

      {(shownRestorable.length > 0 || shownRestorableGpx.length > 0) && (
        <div className="restore-block">
          <h4>Previous session</h4>
          {shownRestorable.map((r, i) => (
            <button key={`s${i}`} onClick={() => void r.restore()}>
              ↻ {r.name}
            </button>
          ))}
          {shownRestorableGpx.map((g, i) => (
            <button key={`g${i}`} onClick={() => void g.restore()}>
              ↻ {g.name} <span className="muted small">(GPX)</span>
            </button>
          ))}
        </div>
      )}

      <div className="panel-header">
        <h3>GPX tracks</h3>
        <span className="button-row">
          <button onClick={() => void addGpxFlow()}>+ GPX</button>
          <button title="Draw a track by hand: set start/end time, place points on the map" onClick={() => setShowNewTrack(true)}>
            + New track
          </button>
        </span>
      </div>
      {trackList.length === 0 && <p className="muted">Tracks found inside source folders load automatically.</p>}
      {trackList.map((t) => (
        <div className="track-item" key={t.id}>
          <span className="color-chip" style={{ background: t.color }} />
          <span
            className="track-name clickable"
            title={`${t.fileName} — ${t.points.length} points. Click to jump to the track start on the map.`}
            onClick={() => useStore.getState().flyTo({ lat: t.points[0].lat, lon: t.points[0].lon }, 13)}
          >
            {t.name}
          </span>
          <span className="muted small">{t.points.length} pts</span>
          <button
            className="remove"
            title="Edit this track on the map (move points, insert points, adjust times, export as GPX)"
            onClick={() => {
              useStore.getState().startEditTrack(t.id)
              useStore.getState().flyTo({ lat: t.points[0].lat, lon: t.points[0].lon }, 13)
            }}
          >
            ✎
          </button>
          <button className="remove" onClick={() => useStore.getState().removeTrack(t.id)}>×</button>
        </div>
      ))}

      {showNewTrack && <NewTrackDialog onClose={() => setShowNewTrack(false)} />}
    </div>
  )
}

function NewTrackDialog({ onClose }: { onClose: () => void }) {
  const cursorMs = useStore((s) => s.timelineCursorMs)
  const defaultStart = cursorMs ?? Date.now()
  const [name, setName] = useState('Manual track')
  const [startText, setStartText] = useState(new Date(defaultStart).toISOString().slice(0, 19))
  const [endText, setEndText] = useState(new Date(defaultStart + 3600_000).toISOString().slice(0, 19))

  const create = () => {
    const store = useStore.getState()
    const startT = Date.parse(`${startText}Z`)
    const endT = Date.parse(`${endText}Z`)
    if (!Number.isFinite(startT) || !Number.isFinite(endT)) {
      store.notify('error', 'Invalid start or end time')
      return
    }
    if (endT < startT) {
      store.notify('error', 'End time must be after the start time')
      return
    }
    // Start point defaults to the position nearest the start time (timeline
    // cursor); if nothing is known, the user places it with a map click.
    const startPoint = positionAtTime(
      Object.values(store.tracks),
      Object.values(store.photos),
      store.sources,
      startT
    )
    store.startNewDraft(name.trim() || 'Manual track', startT, endT, startPoint)
    if (startPoint) store.flyTo(startPoint)
    onClose()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>New manual track</h3>
        <p className="muted small">
          Times are UTC. The start defaults to the timeline cursor (click the timeline to set it).
          After creating, {`you'll`} place the start/end on the map, then refine by dragging.
        </p>
        <label className="small">Name <input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="small">Start (UTC) <input type="datetime-local" step={1} value={startText} onChange={(e) => setStartText(e.target.value)} /></label>
        <label className="small">End (UTC) <input type="datetime-local" step={1} value={endText} onChange={(e) => setEndText(e.target.value)} /></label>
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={create}>Create & place on map</button>
        </div>
      </div>
    </div>
  )
}
