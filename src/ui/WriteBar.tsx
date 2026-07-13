import { useMemo, useState } from 'react'
import { isDirty } from '../domain/types'
import { useStore } from '../state/store'
import { writeDirtyFlow } from '../services/appActions'
import type { WriteMode } from '../services/writePipeline'

export function WriteBar() {
  const photos = useStore((s) => s.photos)
  const settings = useStore((s) => s.settings)
  const writeProgress = useStore((s) => s.writeProgress)
  const [confirmExiftool, setConfirmExiftool] = useState(false)

  const dirty = useMemo(() => Object.values(photos).filter(isDirty), [photos])
  const dirtyRaw = dirty.filter((p) => p.kind !== 'jpeg').length
  const writing = writeProgress !== undefined

  const onModeChange = (mode: WriteMode) => {
    if (mode === 'exiftool') {
      setConfirmExiftool(true)
      return
    }
    useStore.getState().setSettings({ writeMode: mode })
  }

  return (
    <div className="write-bar">
      <span className="app-title">
        Photo Geotagger
        <span className="build-time" title="Build time (UTC)">
          {__BUILD_TIME__.slice(0, 16).replace('T', ' ')}
        </span>
      </span>

      <span className="write-mode" title="How GPS is written back to your files">
        <label>Write mode</label>
        <select value={settings.writeMode} onChange={(e) => onModeChange(e.target.value as WriteMode)} disabled={writing}>
          <option value="safe">Safe — JPEG in place, XMP sidecars for RAW/HEIC</option>
          <option value="exiftool">ExifTool (WASM) — write into any format incl. RAW</option>
        </select>
      </span>

      <label className="checkbox-row" title="Copy each file to <name>.orig before the first write">
        <input
          type="checkbox"
          checked={settings.backupOriginals}
          onChange={(e) => useStore.getState().setSettings({ backupOriginals: e.target.checked })}
          disabled={writing}
        />
        Backup originals
      </label>

      <span className="spacer" />

      {writing ? (
        <span className="write-progress">
          Writing {writeProgress.done + 1}/{writeProgress.total}: {writeProgress.current}
          <progress value={writeProgress.done} max={writeProgress.total} />
        </span>
      ) : (
        <button
          className="primary"
          disabled={dirty.length === 0}
          title={
            settings.writeMode === 'safe' && dirtyRaw > 0
              ? `${dirtyRaw} RAW/HEIC file(s) will get .xmp sidecars`
              : undefined
          }
          onClick={() => void writeDirtyFlow()}
        >
          Write GPS to {dirty.length} file{dirty.length === 1 ? '' : 's'}
        </button>
      )}

      {confirmExiftool && (
        <div className="modal-backdrop" onClick={() => setConfirmExiftool(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Write directly into RAW files?</h3>
            <p>
              ExifTool mode rewrites every file in place — including RAW formats like Sony .ARW —
              using ExifTool 13.42 compiled to WebAssembly (~25 MB, downloads on first write).
            </p>
            <p>
              Every rewritten file is verified (GPS re-read, size sanity-checked) before it
              replaces the original, but in-browser RAW writing is less battle-tested than
              desktop ExifTool. Keeping <strong>Backup originals</strong> enabled is strongly
              recommended.
            </p>
            <div className="modal-actions">
              <button onClick={() => setConfirmExiftool(false)}>Cancel</button>
              <button
                className="primary"
                onClick={() => {
                  useStore.getState().setSettings({ writeMode: 'exiftool', backupOriginals: true })
                  setConfirmExiftool(false)
                }}
              >
                Use ExifTool mode
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
