import { useMemo } from 'react'
import type { PhotoKind } from '../domain/types'
import { LIMIT_RANGES, defaultLimits, useStore } from '../state/store'
import { estimatePeakRam, formatBytes, type WriteLimits } from '../services/ramEstimate'
import { prepareExiftool } from '../services/appActions'
import { Modal } from './Modal'

/** One limit as a row of choices, each labelled with what it would cost. */
function LimitChoices({
  value,
  min,
  max,
  recommended,
  estimateFor,
  onPick,
  disabled,
}: {
  value: number
  min: number
  max: number
  recommended: number
  estimateFor: (candidate: number) => string | undefined
  onPick: (value: number) => void
  disabled?: boolean
}) {
  const values = Array.from({ length: max - min + 1 }, (_, i) => min + i)
  return (
    <div className="limit-choices">
      {values.map((v) => {
        const cost = estimateFor(v)
        return (
          <button
            key={v}
            className={`limit-choice${v === value ? ' selected' : ''}`}
            onClick={() => onPick(v)}
            disabled={disabled}
            title={v === recommended ? 'Recommended for this device' : undefined}
          >
            <span className="limit-value">
              {v}
              {v === recommended && <span className="limit-star" title="Recommended for this device">★</span>}
            </span>
            {cost && <span className="limit-cost">{cost}</span>}
          </button>
        )
      })}
    </div>
  )
}

/**
 * Write limits with the memory they cost for the files currently loaded, so the
 * trade-off is visible instead of guessed. Estimates are per setting value and
 * hold the other setting at its current choice.
 */
export function LimitsDialog({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings)
  const photos = useStore((s) => s.photos)
  const writing = useStore((s) => s.writeProgress) !== undefined
  const recommended = useMemo(() => defaultLimits(), [])

  // Only files that would actually be written matter for the peak.
  const files = useMemo(
    () =>
      Object.values(photos)
        .filter((p) => p.sizeBytes > 0)
        .map((p) => ({ sizeBytes: p.sizeBytes, kind: p.kind as PhotoKind })),
    [photos]
  )
  const largest = useMemo(() => files.reduce((n, f) => Math.max(n, f.sizeBytes), 0), [files])

  const estimate = (limits: WriteLimits) =>
    estimatePeakRam({
      files,
      mode: settings.writeMode,
      fastRaw: settings.fastRaw,
      fastMp4: settings.fastMp4,
      limits,
    })

  const setLimits = (patch: Partial<WriteLimits>) => {
    useStore.getState().setSettings({ limits: { ...settings.limits, ...patch } })
    // Resize/warm the pool right away so the next write uses the new width.
    if (patch.exiftoolWorkers !== undefined) prepareExiftool()
  }

  const current = estimate(settings.limits)
  const haveFiles = files.length > 0
  const costLabel = (limits: WriteLimits) =>
    haveFiles ? `≈ ${formatBytes(estimate(limits).totalBytes)}` : undefined

  return (
    <Modal className="limits-dialog" onClose={onClose}>
      <h3>Write limits</h3>
      <p className="muted small">
        More parallelism is faster but holds more files in memory at once. The figures below are
        rough estimates for the {files.length} file{files.length === 1 ? '' : 's'} loaded
        {haveFiles && ` (largest ${formatBytes(largest)})`} — enough to compare settings, not exact.
        ★ marks what this device gets by default.
      </p>

      <div className="limit-row">
        <label>
          Files written at once
          <span className="muted small">
            Each one in flight holds its bytes in memory while being rewritten.
          </span>
        </label>
        <LimitChoices
          value={settings.limits.writeConcurrency}
          min={LIMIT_RANGES.writeConcurrency.min}
          max={LIMIT_RANGES.writeConcurrency.max}
          recommended={recommended.writeConcurrency}
          estimateFor={(v) => costLabel({ ...settings.limits, writeConcurrency: v })}
          onPick={(v) => setLimits({ writeConcurrency: v })}
          disabled={writing}
        />
      </div>

      <div className="limit-row">
        <label>
          ExifTool workers
          <span className="muted small">
            Only used for files the WASM path writes — each keeps a ~25 MB interpreter resident.
            {current.wasmUnused && ' Nothing in this import needs it right now.'}
          </span>
        </label>
        <LimitChoices
          value={settings.limits.exiftoolWorkers}
          min={LIMIT_RANGES.exiftoolWorkers.min}
          max={LIMIT_RANGES.exiftoolWorkers.max}
          recommended={recommended.exiftoolWorkers}
          estimateFor={(v) => costLabel({ ...settings.limits, exiftoolWorkers: v })}
          onPick={(v) => setLimits({ exiftoolWorkers: v })}
          disabled={writing}
        />
      </div>

      <p className="small">
        {haveFiles ? (
          <>
            Estimated peak with the current choices: <strong>≈ {formatBytes(current.totalBytes)}</strong>
            {current.workerBytes > 0 && (
              <span className="muted"> · of that {formatBytes(current.workerBytes)} for the workers</span>
            )}
          </>
        ) : (
          <span className="muted">Load a folder to see what each setting would cost.</span>
        )}
      </p>
      {writing && <p className="muted small">Limits are locked while a write is running.</p>}

      <div className="modal-actions">
        <button onClick={() => setLimits(recommended)} disabled={writing}>
          Reset to recommended
        </button>
        <button className="primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  )
}
