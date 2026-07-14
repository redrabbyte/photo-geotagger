import { useMemo, useState } from 'react'
import { isDirty } from '../domain/types'
import { useStore } from '../state/store'
import { writeDirtyFlow, writeTimesFlow } from '../services/appActions'
import { timeCorrectionFor, type WriteMode } from '../services/writePipeline'

export function WriteBar() {
  const photos = useStore((s) => s.photos)
  const settings = useStore((s) => s.settings)
  const writeProgress = useStore((s) => s.writeProgress)
  const sources = useStore((s) => s.sources)
  const [confirmExiftool, setConfirmExiftool] = useState(false)
  // Pending flow awaiting the stripped-files confirmation.
  const [confirmStripped, setConfirmStripped] = useState<'gps' | 'time' | null>(null)

  const dirty = useMemo(() => Object.values(photos).filter(isDirty), [photos])
  const dirtyRaw = dirty.filter((p) => p.kind !== 'jpeg').length
  // Photos whose file needs a clock/timezone fix (independent of GPS).
  const timeFix = useMemo(
    () =>
      Object.values(photos).filter((p) => {
        if (!p.fileHandle || p.writeState === 'writing') return false
        const src = sources[p.sourceId]
        return src !== undefined && timeCorrectionFor(p, src) !== undefined
      }),
    [photos, sources]
  )
  const writing = writeProgress !== undefined

  const flowTargets = (flow: 'gps' | 'time') => (flow === 'gps' ? dirty : timeFix)
  // Files whose GPS Android stripped on read: writing bakes the stripped copy in.
  const strippedIn = (flow: 'gps' | 'time') => flowTargets(flow).filter((p) => p.meta?.gpsEmpty)

  const runFlow = (flow: 'gps' | 'time', onlyIds?: string[]) => {
    if (flow === 'gps') void writeDirtyFlow(onlyIds)
    else void writeTimesFlow(onlyIds)
  }

  const startWrite = (flow: 'gps' | 'time') => {
    if (strippedIn(flow).length > 0) setConfirmStripped(flow)
    else runFlow(flow)
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

      <label
        className="checkbox-row"
        title="Also write the corrected capture time into the files: DateTimeOriginal shifted by the source's clock offset, plus the timezone (OffsetTimeOriginal). Only touches files whose source has a correction or that lack a timezone."
      >
        <input
          type="checkbox"
          checked={settings.writeCorrectedTime}
          onChange={(e) => useStore.getState().setSettings({ writeCorrectedTime: e.target.checked })}
          disabled={writing}
        />
        Write corrected time
      </label>

      <span className="spacer" />

      {writing ? (
        <span className="write-progress">
          Writing {writeProgress.done + 1}/{writeProgress.total}: {writeProgress.current}
          <progress value={writeProgress.done} max={writeProgress.total} />
        </span>
      ) : (
        <>
          {timeFix.length > 0 && (
            <button
              title="Write ONLY the corrected capture time (clock offset + timezone) into every file that needs it — also files without a GPS position. GPS assignments are not written by this button."
              onClick={() => startWrite('time')}
            >
              Fix times in {timeFix.length} file{timeFix.length === 1 ? '' : 's'}
            </button>
          )}
          <button
            className="primary"
            disabled={dirty.length === 0}
            title={
              settings.writeMode === 'safe' && dirtyRaw > 0
                ? `${dirtyRaw} RAW/HEIC file(s) will get .xmp sidecars`
                : undefined
            }
            onClick={() => startWrite('gps')}
          >
            Write GPS to {dirty.length} file{dirty.length === 1 ? '' : 's'}
          </button>
        </>
      )}

      {confirmStripped &&
        (() => {
          const flow = confirmStripped
          const targets = flowTargets(flow)
          const stripped = strippedIn(flow)
          return (
            <div className="modal-backdrop" onClick={() => setConfirmStripped(null)}>
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
                  <strong>Writing replaces the file with that stripped copy.</strong> Whatever
                  location the original held is then permanently gone. Only proceed for these
                  files if that is what you want.
                </p>
                <div className="modal-actions">
                  <button onClick={() => setConfirmStripped(null)}>Cancel</button>
                  {targets.length > stripped.length && (
                    <button
                      onClick={() => {
                        setConfirmStripped(null)
                        const strippedIds = new Set(stripped.map((p) => p.id))
                        runFlow(flow, targets.filter((p) => !strippedIds.has(p.id)).map((p) => p.id))
                      }}
                    >
                      Skip {stripped.length} stripped, write {targets.length - stripped.length}
                    </button>
                  )}
                  <button
                    className="primary"
                    onClick={() => {
                      setConfirmStripped(null)
                      runFlow(flow)
                    }}
                  >
                    Write all {targets.length}
                  </button>
                </div>
              </div>
            </div>
          )
        })()}

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
