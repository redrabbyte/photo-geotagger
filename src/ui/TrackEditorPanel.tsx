import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import { exportDraftGpx } from '../services/appActions'
import { formatUtc, fromUtcInput, toUtcInput } from './format'

function PointTimeEditor({ index, t, stretchFrom }: { index: number; t: number; stretchFrom?: number }) {
  const [value, setValue] = useState(toUtcInput(t))
  useEffect(() => setValue(toUtcInput(t)), [t, index])

  /**
   * quiet = called from onChange: commit valid values immediately but stay
   * silent on partial input. Mobile browsers don't blur inputs when the user
   * taps a canvas, so waiting for blur used to lose the edit entirely.
   */
  const commit = (raw: string, quiet: boolean) => {
    const ms = fromUtcInput(raw)
    const store = useStore.getState()
    if (ms === undefined) {
      if (!quiet) {
        store.notify('error', 'Invalid time')
        setValue(toUtcInput(t))
      }
      return
    }
    if (stretchFrom !== undefined && stretchFrom !== index) {
      const before = store.draft?.points
      store.stretchDraft(stretchFrom, index, ms)
      if (!quiet && useStore.getState().draft?.points === before) {
        store.notify('error', 'Stretch rejected — the new time must stay on the same side of the anchor')
        setValue(toUtcInput(t))
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
      onChange={(e) => {
        setValue(e.target.value)
        commit(e.target.value, true)
      }}
      onBlur={() => commit(value, false)}
      onKeyDown={(e) => e.key === 'Enter' && commit(value, false)}
    />
  )
}

function AppendTrackChooser({ currentTrackId }: { currentTrackId?: string }) {
  const tracks = useStore((s) => s.tracks)
  const others = Object.values(tracks).filter((t) => t.id !== currentTrackId)
  if (others.length === 0) return null

  const append = (trackId: string) => {
    if (!trackId) return
    const store = useStore.getState()
    const result = store.appendTrackToDraft(trackId)
    if (typeof result === 'string') {
      store.notify('error', result)
    } else {
      store.notify(
        'success',
        `Appended ${result.added} point(s)` +
          (result.shiftedByMs > 0
            ? `, shifted +${Math.round(result.shiftedByMs / 60_000)}min to stay chronological`
            : '')
      )
    }
  }

  return (
    <label className="small append-chooser" title="Append another track's points to the end of this one (times kept; shifted forward only if they would overlap). The other track itself stays unchanged.">
      Append track
      <select value="" onChange={(e) => append(e.target.value)}>
        <option value="" disabled>
          choose…
        </option>
        {others.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name} ({t.points.length} pts)
          </option>
        ))}
      </select>
    </label>
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
          <div className="button-row">
            <button
              disabled={selectedIndex === 0}
              title="Remove every point before this one; this point becomes the new start"
              onClick={() => {
                const n = useStore.getState().trimDraftAt(selectedIndex, 'before')
                if (n > 0) useStore.getState().notify('info', `Removed ${n} point(s) before`)
              }}
            >
              ✂ all before
            </button>
            <button
              disabled={selectedIndex === draft.points.length - 1}
              title="Remove every point after this one; this point becomes the new end"
              onClick={() => {
                const n = useStore.getState().trimDraftAt(selectedIndex, 'after')
                if (n > 0) useStore.getState().notify('info', `Removed ${n} point(s) after`)
              }}
            >
              ✂ all after
            </button>
          </div>
        </div>
      )}

      <AppendTrackChooser currentTrackId={draft.trackId} />

      <div className="inspector-actions">
        <button
          disabled={draft.points.length < 2}
          title="Reverse the track's direction: point order flips, times are mirrored within the same window (start time stays, leg durations reverse)"
          onClick={() => useStore.getState().reverseDraft()}
        >
          ⇄ Reverse direction
        </button>
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
