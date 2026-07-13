import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import { exportDraftGpx } from '../services/appActions'
import { formatUtc } from './format'

/** Epoch ms → value for <input type="datetime-local" step="1"> (shown as UTC). */
function toLocalInput(t: number): string {
  return new Date(t).toISOString().slice(0, 19)
}

function fromLocalInput(v: string): number | undefined {
  const t = Date.parse(`${v}Z`)
  return Number.isFinite(t) ? t : undefined
}

function PointTimeEditor({ index, t }: { index: number; t: number }) {
  const [value, setValue] = useState(toLocalInput(t))
  useEffect(() => setValue(toLocalInput(t)), [t, index])

  const commit = () => {
    const ms = fromLocalInput(value)
    const store = useStore.getState()
    if (ms === undefined) {
      store.notify('error', 'Invalid time')
      setValue(toLocalInput(t))
      return
    }
    store.setDraftTimeAt(index, ms)
  }

  return (
    <input
      type="datetime-local"
      step={1}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  )
}

export function TrackEditorPanel() {
  const draft = useStore((s) => s.draft)
  const selectedIndex = useStore((s) => s.draftSelectedIndex)
  const placement = useStore((s) => s.draftPlacement)
  if (!draft) return null

  const selected = selectedIndex !== undefined ? draft.points[selectedIndex] : undefined
  const isEndpoint = selectedIndex === 0 || selectedIndex === draft.points.length - 1

  const save = () => {
    const store = useStore.getState()
    const err = store.commitDraft()
    if (err) store.notify('error', err)
    else store.notify('success', 'Track saved to the map — use it for matching or export it as .gpx')
  }

  return (
    <div className="inspector">
      <h3>{draft.trackId ? 'Edit track' : 'New track'}</h3>
      <input
        className="draft-name"
        value={draft.name}
        onChange={(e) => useStore.getState().setDraftName(e.target.value)}
        placeholder="Track name"
      />

      {placement ? (
        <p className="muted">Click the map to place the {placement.which} point.</p>
      ) : (
        <p className="muted small">
          Drag points to move them. Drag the yellow line to insert a point — its time is
          interpolated from distance. Click a point to edit its time.
        </p>
      )}

      <div className="draft-legend">
        <span><span className="dot" style={{ background: '#ff7043' }} /> manual time</span>
        <span><span className="dot" style={{ background: '#4fc3f7' }} /> interpolated</span>
      </div>

      <p className="muted small">{draft.points.length} point(s)</p>

      {selected && selectedIndex !== undefined && (
        <div className="draft-point-editor">
          <h4>
            Point {selectedIndex + 1} — {selected.manual ? 'manual' : 'interpolated'}
          </h4>
          <div className="muted small">{formatUtc(selected.t)}</div>
          <label className="small">
            Time (UTC)
            <PointTimeEditor index={selectedIndex} t={selected.t} />
          </label>
          {!isEndpoint && (
            <button onClick={() => useStore.getState().deleteDraftPointAt(selectedIndex)}>
              Delete point
            </button>
          )}
        </div>
      )}

      <div className="inspector-actions">
        <button className="primary" disabled={draft.points.length < 2} onClick={save}>
          {draft.trackId ? 'Apply changes' : 'Save track'}
        </button>
        <button disabled={draft.points.length < 2} onClick={() => void exportDraftGpx()}>
          Export as .gpx
        </button>
        <button onClick={() => useStore.getState().cancelDraft()}>Cancel</button>
      </div>
    </div>
  )
}
