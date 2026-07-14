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
  const [confirmStripped, setConfirmStripped] = useState(false)

  const dirty = useMemo(() => Object.values(photos).filter(isDirty), [photos])
  const dirtyRaw = dirty.filter((p) => p.kind !== 'jpeg').length
  // Files whose GPS Android stripped on read: writing bakes the stripped copy in.
  const stripped = useMemo(() => dirty.filter((p) => p.meta?.gpsEmpty), [dirty])
  const writing = writeProgress !== undefined

  const startWrite = () => {
    if (stripped.length > 0) setConfirmStripped(true)
    else void writeDirtyFlow()
  }

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
          onClick={startWrite}
        >
          Write GPS to {dirty.length} file{dirty.length === 1 ? '' : 's'}
        </button>
      )}

      {confirmStripped && (
        <div className="modal-backdrop" onClick={() => setConfirmStripped(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>
              {stripped.length} file{stripped.length === 1 ? ' was' : 's were'} read without position data
            </h3>
            <p>
              Android strips position data from photos when a browser reads them — the original
              file may still contain its real location, but this app only ever received a
              stripped copy.
            </p>
            <p>
              <strong>Writing replaces the file with that stripped copy</strong> plus your newly
              assigned position. Whatever location the original held is then permanently gone.
              Only proceed for these files if your assigned position is what you want in them.
            </p>
            <div className="modal-actions">
              <button onClick={() => setConfirmStripped(false)}>Cancel</button>
              {dirty.length > stripped.length && (
                <button
                  onClick={() => {
                    setConfirmStripped(false)
                    const strippedIds = new Set(stripped.map((p) => p.id))
                    void writeDirtyFlow(dirty.filter((p) => !strippedIds.has(p.id)).map((p) => p.id))
                  }}
                >
                  Skip {stripped.length} stripped file{stripped.length === 1 ? '' : 's'}, write {dirty.length - stripped.length}
                </button>
              )}
              <button
                className="primary"
                onClick={() => {
                  setConfirmStripped(false)
                  void writeDirtyFlow()
                }}
              >
                Write all {dirty.length}
              </button>
            </div>
          </div>
        </div>
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
