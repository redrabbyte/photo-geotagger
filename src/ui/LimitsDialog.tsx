import { useMemo } from 'react'
import type { PhotoKind } from '../domain/types'
import { LIMIT_RANGES, defaultLimits, useStore } from '../state/store'
import {
  deviceMemoryGb,
  estimatePeakRam,
  fitLimits,
  formatBytes,
  limitCeilings,
  logicalCores,
  offeredLimit,
  ramPolicy,
  type RamEstimate,
  type WriteLimits,
} from '../services/ramEstimate'
import { limitsLoadState, prepareExiftool } from '../services/appActions'
import { Modal } from './Modal'

/** One limit as a row of choices, each labelled with what it would cost. */
function LimitChoices({
  value,
  min,
  max,
  auto,
  estimateFor,
  onPick,
  disabled,
}: {
  value: number
  min: number
  max: number
  auto: number
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
            title={v === auto ? 'What the app picks by itself for this device and the loaded files' : undefined}
          >
            <span className="limit-value">
              {v}
              {v === auto && (
                <span className="limit-star" title="Automatic choice">
                  ★
                </span>
              )}
            </span>
            {cost && <span className="limit-cost">{cost}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** Why the ExifTool worker setting cannot matter for this import. */
function workersMoot(reason: RamEstimate['wasmUnusedReason']): string | undefined {
  switch (reason) {
    case 'fast-paths':
      return ' The experimental fast paths write every RAW and clip here in JS, which makes this setting irrelevant — it only applies to files that fall back to ExifTool.'
    case 'safe-mode':
      return ' Safe mode never runs ExifTool, so this setting does nothing until you switch modes.'
    case 'no-such-files':
      return ' Only JPEGs are loaded, and those always take the pure-JS path.'
    default:
      return undefined
  }
}

/**
 * Write limits with the memory they cost for the files currently loaded, so the
 * trade-off is visible instead of guessed. Estimates are per setting value and
 * hold the other setting at its current choice.
 *
 * The app fits the limits itself while the user has not chosen: modest defaults
 * during the import (sizes are still arriving, so the estimate keeps rising),
 * then the widest setting that stays inside the device's memory budget.
 */
export function LimitsDialog({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings)
  const photos = useStore((s) => s.photos)
  const scanning = useStore((s) => s.scanning)
  const writing = useStore((s) => s.writeProgress) !== undefined
  const cores = useMemo(() => logicalCores(), [])
  const memGb = useMemo(() => deviceMemoryGb(), [])
  const ceilings = useMemo(() => limitCeilings(), [])
  const policy = useMemo(() => ramPolicy(), [])

  // Only files that would actually be written matter for the peak. Sizes arrive
  // with each photo's metadata scan, so an import in progress has fewer of them
  // than it will have — which is what makes the numbers below move.
  const all = useMemo(() => Object.values(photos), [photos])
  const files = useMemo(
    () =>
      all
        .filter((p) => p.sizeBytes > 0)
        .map((p) => ({ sizeBytes: p.sizeBytes, kind: p.kind as PhotoKind })),
    [all]
  )
  // The same rule the automatic fit waits for — one source of truth.
  const { measured, settled } = limitsLoadState(all, scanning)
  const largest = useMemo(() => files.reduce((n, f) => Math.max(n, f.sizeBytes), 0), [files])

  const forFiles = { files, mode: settings.writeMode, fastRaw: settings.fastRaw, fastMp4: settings.fastMp4 }
  const estimate = (limits: WriteLimits) => estimatePeakRam({ ...forFiles, limits })

  const auto = useMemo(
    () =>
      fitLimits({
        ...forFiles,
        budgetBytes: policy.targetBytes,
        ceilings,
        workersWhenIdle: defaultLimits().exiftoolWorkers,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [files, settings.writeMode, settings.fastRaw, settings.fastMp4, policy, ceilings]
  )

  // Values are offered up to the core count, and only while their estimate stays
  // inside the memory ceiling — a setting that would plan for more than the
  // device has is not a choice worth presenting.
  const offered = (knob: keyof WriteLimits) =>
    offeredLimit(knob, {
      ...forFiles,
      limits: settings.limits,
      maxBytes: policy.maxBytes,
      // A worker can only be busy while a file is in flight, so offering more
      // of them than files-at-once would only ever be idle memory.
      ceilings: {
        ...ceilings,
        exiftoolWorkers: Math.min(ceilings.exiftoolWorkers, settings.limits.writeConcurrency),
      },
    })

  const setLimits = (patch: Partial<WriteLimits>) => {
    // Picking a value by hand switches the automatic fitting off — it must not
    // silently overwrite the choice a moment later.
    useStore.getState().setSettings({ limits: { ...settings.limits, ...patch }, limitsAuto: false })
    // Resize/warm the pool right away so the next write uses the new width.
    if (patch.exiftoolWorkers !== undefined) prepareExiftool()
  }

  const current = estimate(settings.limits)
  const haveFiles = files.length > 0
  const costLabel = (limits: WriteLimits) =>
    haveFiles ? `≈ ${formatBytes(estimate(limits).totalBytes)}` : undefined
  const updating = !settled && settings.limitsAuto
  const atAuto =
    settings.limitsAuto &&
    (!haveFiles ||
      (auto.writeConcurrency === settings.limits.writeConcurrency &&
        auto.exiftoolWorkers === settings.limits.exiftoolWorkers))

  return (
    <Modal className="limits-dialog" onClose={onClose}>
      <h3>Write limits</h3>
      <p className="muted small">
        More parallelism is faster but holds more files in memory at once. The figures below are
        rough estimates for the {measured === all.length ? files.length : `${files.length} of ${all.length}`}{' '}
        file{files.length === 1 ? '' : 's'} loaded
        {haveFiles && ` (largest ${formatBytes(largest)})`} — enough to compare settings, not exact.
        ★ marks what the app picks by itself: the widest setting whose estimate stays under{' '}
        {formatBytes(policy.targetBytes)}. Values are offered up to this device's {cores} logical
        core{cores === 1 ? '' : 's'} and up to a peak of {formatBytes(policy.maxBytes)}
        {memGb !== undefined && ` (the ${memGb} GB this device reports)`}.
      </p>

      <div className="limit-row">
        <label>
          Files written at once
          <span className="muted small">
            Each one in flight holds its bytes in memory while being rewritten.
            {settings.writeMode !== 'exiftool' &&
              ' Safe mode writes sidecars at a fixed width — this applies in ExifTool mode.'}
          </span>
        </label>
        <LimitChoices
          value={settings.limits.writeConcurrency}
          min={LIMIT_RANGES.writeConcurrency.min}
          max={offered('writeConcurrency')}
          auto={auto.writeConcurrency}
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
            {workersMoot(current.wasmUnusedReason)}
          </span>
        </label>
        <LimitChoices
          value={settings.limits.exiftoolWorkers}
          min={LIMIT_RANGES.exiftoolWorkers.min}
          max={offered('exiftoolWorkers')}
          auto={auto.exiftoolWorkers}
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
      {updating && (
        <p className="small limits-updating">
          <span className="spinner-dot" /> Limits updating — {measured} of {all.length} file
          {all.length === 1 ? '' : 's'} measured. The estimate still grows; the automatic choice is
          applied once loading finishes.
        </p>
      )}
      {!settings.limitsAuto && (
        <p className="muted small">
          Set by hand — the automatic fit is off for this session.
        </p>
      )}
      {writing && <p className="muted small">Limits are locked while a write is running.</p>}

      <div className="modal-actions">
        <button
          disabled={writing || atAuto}
          title={`Let the app choose: the widest limits whose estimated peak stays under ${formatBytes(policy.targetBytes)}, capped at this device's ${cores} logical core${cores === 1 ? '' : 's'}`}
          onClick={() =>
            useStore.getState().setSettings({ limitsAuto: true, limits: haveFiles ? auto : defaultLimits() })
          }
        >
          Use automatic
        </button>
        <button className="primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  )
}
