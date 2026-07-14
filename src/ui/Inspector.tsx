import { useMemo, useState } from 'react'
import { exiftoolInspect } from '../services/writePipeline'
import type { AssignmentMethod } from '../domain/types'
import { displayPosition, effectiveUtcMs, gpsStatus } from '../domain/types'
import { findNeighbors } from '../domain/trackIndex'
import { useStore } from '../state/store'
import { TrackEditorPanel } from './TrackEditorPanel'
import { formatCoord, formatDeltaMs, formatUtc } from './format'

const METHODS: { key: Extract<AssignmentMethod, 'closest' | 'before' | 'after' | 'interpolated' | 'inherit'>; label: string; hint: string }[] = [
  { key: 'interpolated', label: 'Interpolate', hint: 'Position between the trackpoints before and after the photo time' },
  { key: 'closest', label: 'Closest point', hint: 'Nearest trackpoint in time' },
  { key: 'before', label: 'Point before', hint: 'Last trackpoint before the photo' },
  { key: 'after', label: 'Point after', hint: 'First trackpoint after the photo' },
  { key: 'inherit', label: 'From other photos', hint: 'Interpolate between time-adjacent photos that already have GPS (e.g. phone photos)' },
]

export function Inspector() {
  const draftActive = useStore((s) => s.draft !== undefined)
  const photos = useStore((s) => s.photos)
  const sources = useStore((s) => s.sources)
  const tracks = useStore((s) => s.tracks)
  const selectedIds = useStore((s) => s.selectedIds)
  const activePhotoId = useStore((s) => s.activePhotoId)
  const snapToTrack = useStore((s) => s.snapToTrack)

  const active = activePhotoId ? photos[activePhotoId] : undefined
  const activeSource = active ? sources[active.sourceId] : undefined
  const selectedCount = selectedIds.size
  const [exifDump, setExifDump] = useState<{ fileName: string; text: string } | 'loading' | undefined>()

  const showExifDetails = async () => {
    if (!active?.fileHandle) return
    setExifDump('loading')
    try {
      const file = await active.fileHandle.getFile()
      const text = await exiftoolInspect(active.fileName, await file.arrayBuffer())
      setExifDump({ fileName: active.fileName, text })
    } catch (err) {
      setExifDump({
        fileName: active.fileName,
        text: `ExifTool failed: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  const neighbors = useMemo(() => {
    if (!active || !activeSource) return undefined
    const t = effectiveUtcMs(active, activeSource)
    if (t === undefined) return undefined
    return findNeighbors(Object.values(tracks), t)
  }, [active, activeSource, tracks])

  const runAssign = (method: AssignmentMethod) => {
    const store = useStore.getState()
    if (store.selectedIds.size === 0) {
      store.notify('info', 'Select photos first (filmstrip, map, or timeline).')
      return
    }
    const summary = store.assignSelected(method)
    const parts = [`${summary.assigned} assigned`]
    if (summary.degraded) parts.push(`${summary.degraded} degraded to closest (gap too large)`)
    if (summary.noMatch) parts.push(`${summary.noMatch} without match`)
    if (summary.noTime) parts.push(`${summary.noTime} without usable time`)
    store.notify(summary.assigned > 0 ? 'success' : 'info', parts.join(', '))
  }

  if (draftActive) {
    return <TrackEditorPanel />
  }

  if (selectedCount === 0) {
    return (
      <div className="inspector">
        <h3>Position</h3>
        <p className="muted">
          Select photos, then assign GPS positions here — from GPX tracks, from other geotagged
          photos, or by dragging markers on the map.
        </p>
      </div>
    )
  }

  const pos = active ? displayPosition(active) : undefined
  const effT = active && activeSource ? effectiveUtcMs(active, activeSource) : undefined

  return (
    <div className="inspector">
      <h3>
        {selectedCount === 1 && active ? active.fileName : `${selectedCount} photos selected`}
      </h3>

      {active && selectedCount === 1 && (
        <div className="inspector-details">
          {active.thumbUrl && <img className="inspector-thumb" src={active.thumbUrl} alt="" />}
          <table>
            <tbody>
              <tr><td>Source</td><td>{activeSource?.name ?? '?'}</td></tr>
              <tr><td>Camera</td><td>{active.meta?.cameraModel ?? '—'}</td></tr>
              <tr>
                <td>Time</td>
                <td>
                  {formatUtc(effT)}
                  {active.meta?.timeSource === 'file' && <span className="warn"> (file date — no EXIF time!)</span>}
                </td>
              </tr>
              <tr><td>Status</td><td><span className={`dot dot-${gpsStatus(active)}`} /> {gpsStatus(active)}{active.assignment ? ` (${active.assignment.method}${active.assignment.degraded ? ', degraded' : ''})` : ''}</td></tr>
              <tr>
                <td>Position</td>
                <td>
                  {pos
                    ? `${formatCoord(pos.lat, true)}, ${formatCoord(pos.lon, false)}${pos.ele !== undefined ? `, ${pos.ele.toFixed(0)}m` : ''}`
                    : active.scanState === 'done'
                      ? active.meta?.gpsEmpty
                        ? 'GPS tags present but empty'
                        : 'no GPS in this file'
                      : active.scanState === 'error'
                        ? 'metadata scan failed'
                        : 'scanning…'}
                </td>
              </tr>
              {!pos && active.scanState === 'done' && active.meta?.gpsEmpty && (
                <tr>
                  <td className="warn">Hint</td>
                  <td className="warn">
                    Android strips position data from photos when a browser reads them. You can
                    still assign a position here and overwrite the file with it.
                  </td>
                </tr>
              )}
              {active.scanError && (
                <tr><td className="warn">Scan error</td><td className="warn">{active.scanError}</td></tr>
              )}
              {neighbors?.before && (
                <tr><td>Track before</td><td>{formatDeltaMs(neighbors.before.deltaMs)}</td></tr>
              )}
              {neighbors?.after && (
                <tr><td>Track after</td><td>{formatDeltaMs(neighbors.after.deltaMs)}</td></tr>
              )}
              {active.writeError && <tr><td className="warn">Write error</td><td className="warn">{active.writeError}</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      <h4>Assign position {selectedCount > 1 ? `(${selectedCount} photos)` : ''}</h4>
      <div className="method-buttons">
        {METHODS.map((m) => (
          <button key={m.key} title={m.hint} onClick={() => runAssign(m.key)}>
            {m.label}
          </button>
        ))}
      </div>

      <label className="checkbox-row" title="While dragging a marker on the map, snap it to the nearest GPX track">
        <input
          type="checkbox"
          checked={snapToTrack}
          onChange={(e) => useStore.getState().setSnapToTrack(e.target.checked)}
        />
        Drag snaps to track
      </label>
      <p className="muted small">Drag any marker on the map to set a position manually.</p>

      <div className="inspector-actions">
        {active && selectedCount === 1 && active.fileHandle && (
          <button
            title="Run ExifTool (WASM, ~25 MB download on first use) and show every metadata tag in this file — useful when GPS seems missing"
            onClick={() => void showExifDetails()}
          >
            EXIF details (ExifTool)…
          </button>
        )}
        {active && selectedCount === 1 && activeSource && active.meta && (
          <button
            title="Set this source's clock offset by clicking where this photo was actually taken on a track"
            onClick={() => {
              const tz = active.meta!.tzOffsetMin ?? activeSource.assumedTzOffsetMin
              const base = active.meta!.captureLocalMs - tz * 60_000
              useStore.getState().startCalibrate(activeSource.id, base, active.fileName)
            }}
          >
            Calibrate clock from this photo…
          </button>
        )}
        <button onClick={() => useStore.getState().clearAssignment([...selectedIds])}>
          Clear assigned position
        </button>
      </div>

      {exifDump !== undefined && (
        <div className="modal-backdrop" onClick={() => setExifDump(undefined)}>
          <div className="modal exif-dump" onClick={(e) => e.stopPropagation()}>
            {exifDump === 'loading' ? (
              <>
                <h3>Reading metadata…</h3>
                <p className="muted small">First use downloads ExifTool (~25 MB) — this can take a moment.</p>
              </>
            ) : (
              <>
                <h3>{exifDump.fileName}</h3>
                <p className="muted small">
                  Every tag ExifTool finds in the file. GPS lines (if any) contain “GPS”.
                </p>
                <pre>{exifDump.text}</pre>
              </>
            )}
            <div className="modal-actions">
              <button onClick={() => setExifDump(undefined)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
