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

function PointTimeEditor({ index, t, stretchFrom }: { index: number; t: number; stretchFrom?: number }) {
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
    if (stretchFrom !== undefined && stretchFrom !== index) {
      const before = store.draft?.points
      store.stretchDraft(stretchFrom, index, ms)
      if (useStore.getState().draft?.points === before) {
        store.notify('error', 'Stretch rejected — the new time must stay on the same side of the anchor')
        setValue(toLocalInput(t))
      }
    } else {
      store.setDraftTimeAt(index, ms)
    }
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
  const anchorIndex = useStore((s) => s.draftAnchorIndex)
  const placement = useStore((s) => s.draftPlacement)
  const [stretchMode, setStretchMode] = useState(true)
  if (!draft) return null

  const selected = selectedIndex !== undefined ? draft.points[selectedIndex] : undefined
  const isEndpoint = selectedIndex === 0 || selectedIndex === draft.points.length - 1
  const anchorUsable = anchorIndex !== undefined && anchorIndex !== selectedIndex && anchorIndex < draft.points.length

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
            {anchorIndex === selectedIndex ? ' ⚓' : ''}
          </h4>
          <div className="muted small">{formatUtc(selected.t)}</div>
          <button
            title="An anchor stays fixed while you stretch: select another point, change its time, and everything between scales proportionally"
            onClick={() => useStore.getState().setDraftAnchor(selectedIndex)}
          >
            {anchorIndex === selectedIndex ? 'Remove stretch anchor' : '⚓ Set as stretch anchor'}
          </button>
          {anchorUsable && (
            <label className="checkbox-row small" title="Scale all times between the anchor and this point proportionally when committing the new time; points beyond shift along">
              <input type="checkbox" checked={stretchMode} onChange={(e) => setStretchMode(e.target.checked)} />
              Stretch section from anchor (point {anchorIndex! + 1})
            </label>
          )}
          <label className="small">
            Time (UTC)
            <PointTimeEditor
              index={selectedIndex}
              t={selected.t}
              stretchFrom={anchorUsable && stretchMode ? anchorIndex : undefined}
            />
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
