import { useMemo, useRef, useState } from 'react'
import { isDirty } from '../domain/types'
import { useStore } from '../state/store'
import { prepareExiftool, requestWriteStop, writeDirtyFlow, writeTimesFlow } from '../services/appActions'
import { timeCorrectionFor, type WriteMode } from '../services/writePipeline'
import { formatEtaMs } from './format'
import { Modal } from './Modal'

export function WriteBar() {
  const photos = useStore((s) => s.photos)
  const settings = useStore((s) => s.settings)
  const writeProgress = useStore((s) => s.writeProgress)
  const sources = useStore((s) => s.sources)
  const selectedIds = useStore((s) => s.selectedIds)
  const [confirmExiftool, setConfirmExiftool] = useState(false)
  // Pending flow awaiting the stripped-files confirmation.
  const [confirmStripped, setConfirmStripped] = useState<'gps' | 'time' | null>(null)

  const embedActive = settings.writeMode === 'exiftool' && settings.embedSidecarGps
  const dirty = useMemo(
    () =>
      Object.values(photos).filter(
        (p) =>
          isDirty(p) ||
          (embedActive && p.sidecarGps !== undefined && !p.assignment && p.writeState !== 'written' && p.writeState !== 'writing')
      ),
    [photos, embedActive]
  )
  const dirtyRaw = dirty.filter((p) => p.kind !== 'jpeg').length
  const sidecarEmbedCount = useMemo(
    () => Object.values(photos).filter((p) => p.sidecarGps !== undefined && !p.assignment && p.writeState !== 'written').length,
    [photos]
  )
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

  // With an active selection, the time fix applies to the selected files only.
  const timeFixSelected = selectedIds.size > 0
  const timeFixShown = timeFixSelected ? timeFix.filter((p) => selectedIds.has(p.id)) : timeFix
  const timeOnlyIds = timeFixSelected ? timeFixShown.map((p) => p.id) : undefined

  const flowTargets = (flow: 'gps' | 'time') => (flow === 'gps' ? dirty : timeFixShown)
  // Files whose GPS Android stripped on read: writing bakes the stripped copy in.
  const strippedIn = (flow: 'gps' | 'time') => flowTargets(flow).filter((p) => p.meta?.gpsEmpty)

  const runFlow = (flow: 'gps' | 'time', onlyIds?: string[]) => {
    if (flow === 'gps') void writeDirtyFlow(onlyIds)
    else void writeTimesFlow(onlyIds ?? timeOnlyIds)
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

  // Mobile: the wrapped header eats a lot of vertical space — it can be
  // collapsed to just a finger-high grab handle (tap or swipe on the handle).
  const [collapsed, setCollapsed] = useState(false)
  const touchStartY = useRef<number | null>(null)

  return (
    <div className={`write-bar${collapsed ? ' collapsed' : ''}`}>
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

      {settings.writeMode === 'exiftool' && (
        <label
          className="checkbox-row"
          title="Run multiple ExifTool workers (2–4, scaled to this device's CPU and memory) so RAW/HEIC files are written in parallel — several times faster on large batches, at the cost of extra memory (each worker can peak at several hundred MB with big RAW files)."
        >
          <input
            type="checkbox"
            checked={settings.parallelExiftool}
            onChange={(e) => {
              useStore.getState().setSettings({ parallelExiftool: e.target.checked })
              prepareExiftool()
            }}
            disabled={writing}
          />
          Parallel (RAW)
        </label>
      )}

      {settings.writeMode === 'exiftool' && sidecarEmbedCount > 0 && (
        <label
          className="checkbox-row"
          title="Write the GPS loaded from .xmp sidecar files directly into the corresponding raw files (via ExifTool), so the coordinates live in the files themselves."
        >
          <input
            type="checkbox"
            checked={settings.embedSidecarGps}
            onChange={(e) => useStore.getState().setSettings({ embedSidecarGps: e.target.checked })}
            disabled={writing}
          />
          Embed XMP GPS into {sidecarEmbedCount} raw file{sidecarEmbedCount === 1 ? '' : 's'}
        </label>
      )}

      <span className="spacer" />

      {writing ? (
        <span className="write-progress">
          Writing {Math.min(writeProgress.done + 1, writeProgress.total)}/{writeProgress.total}: {writeProgress.current}
          {writeProgress.etaMs !== undefined && (
            <span className="muted"> · ~{formatEtaMs(writeProgress.etaMs)} left</span>
          )}
          <progress value={writeProgress.done} max={writeProgress.total} />
          <button title="Finish the file currently being written, then stop" onClick={() => requestWriteStop()}>
            ⏹ Stop
          </button>
        </span>
      ) : (
        <>
          {timeFixShown.length > 0 && (
            <button
              title={
                timeFixSelected
                  ? 'Write ONLY the corrected capture time (clock offset + timezone) into the SELECTED files that need it. Clear the selection to target every file.'
                  : 'Write ONLY the corrected capture time (clock offset + timezone) into every file that needs it — also files without a GPS position. GPS assignments are not written by this button.'
              }
              onClick={() => startWrite('time')}
            >
              Fix times in {timeFixShown.length}
              {timeFixSelected ? ' selected' : ''} file{timeFixShown.length === 1 ? '' : 's'}
            </button>
          )}
          <button
            className="primary"
            disabled={dirty.length === 0}
            title={
              settings.writeMode === 'safe' && dirtyRaw > 0
                ? `${dirtyRaw} RAW/HEIC/video file(s) will get .xmp sidecars`
                : undefined
            }
            onClick={() => startWrite('gps')}
          >
            Write GPS to {dirty.length} file{dirty.length === 1 ? '' : 's'}
          </button>
        </>
      )}

      <div
        className="bar-handle"
        title={collapsed ? 'Expand header' : 'Collapse header'}
        onClick={() => setCollapsed((v) => !v)}
        onTouchStart={(e) => {
          touchStartY.current = e.touches[0].clientY
        }}
        onTouchMove={(e) => {
          if (touchStartY.current === null) return
          const dy = e.touches[0].clientY - touchStartY.current
          if (dy < -18) {
            setCollapsed(true)
            touchStartY.current = null
          } else if (dy > 18) {
            setCollapsed(false)
            touchStartY.current = null
          }
        }}
        onTouchEnd={() => {
          touchStartY.current = null
        }}
      >
        {collapsed && writing && (
          <span className="muted small">
            {Math.min(writeProgress.done + 1, writeProgress.total)}/{writeProgress.total}
            {writeProgress.etaMs !== undefined && ` · ~${formatEtaMs(writeProgress.etaMs)}`}
          </span>
        )}
      </div>

      {confirmStripped &&
        (() => {
          const flow = confirmStripped
          const targets = flowTargets(flow)
          const stripped = strippedIn(flow)
          return (
            <Modal onClose={() => setConfirmStripped(null)}>
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
            </Modal>
          )
        })()}

      {confirmExiftool && (
        <Modal onClose={() => setConfirmExiftool(false)}>
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
                // Boot the WASM workers now, while the user is still
                // assigning positions — the first write then starts warm.
                prepareExiftool()
              }}
            >
              Use ExifTool mode
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
