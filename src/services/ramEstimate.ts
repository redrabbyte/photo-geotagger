/**
 * Peak-memory estimate for a write run, so the limits dialog can say what a
 * setting will cost on THIS import instead of asking the user to guess.
 *
 * The model is deliberately coarse — it exists to compare settings, not to
 * predict bytes — and it is built from what each path provably holds at once:
 *
 * - ExifTool (WASM): the file is read into an ArrayBuffer, transferred to a
 *   worker, copied into the WASM filesystem, and the rewritten output lives
 *   there next to it until it comes back — call it 3x the file. On top of that
 *   each booted worker keeps the ~25 MB interpreter resident.
 * - Fast RAW: one buffer holding the original plus the appended block, while
 *   the caller still holds the bytes it read — 2x the file.
 * - Fast MP4: the untouched spans are Blob slices the browser streams, so only
 *   the rebuilt moov is in memory. A flat few MB regardless of clip length.
 * - Safe mode: JPEGs are rewritten in memory (2x); everything else only gets a
 *   small sidecar written next to it.
 *
 * Peak comes from the largest files that can be in flight together, so the
 * estimate sums the N most expensive of them, N being the write concurrency —
 * except that ExifTool video rewrites are serialized (one clip at a time,
 * whatever the concurrency), so only the biggest of those ever counts.
 */
import type { PhotoKind } from '../domain/types'
import type { WriteMode } from './writePipeline'

export interface WriteLimits {
  /** ExifTool WASM workers kept resident (each holds the interpreter). */
  exiftoolWorkers: number
  /** Files written at the same time. */
  writeConcurrency: number
}

export interface RamEstimateInput {
  files: Array<{ sizeBytes: number; kind: PhotoKind }>
  mode: WriteMode
  fastRaw: boolean
  fastMp4: boolean
  limits: WriteLimits
}

/** Resident size of one booted ExifTool WASM interpreter. */
const WASM_WORKER_BYTES = 25 * 1024 * 1024
/** Rebuilt moov plus bookkeeping for a fast MP4 write. */
const FAST_MP4_BYTES = 4 * 1024 * 1024

/** Does this file go through the WASM interpreter with these settings? */
function usesExiftool(kind: PhotoKind, input: RamEstimateInput): boolean {
  if (input.mode !== 'exiftool') return false
  if (kind === 'jpeg') return false // always the pure-JS JPEG path
  if (kind === 'video') return !input.fastMp4
  return !input.fastRaw
}

/** Bytes held while this one file is being written. */
function costOf(file: { sizeBytes: number; kind: PhotoKind }, input: RamEstimateInput): number {
  const { kind, sizeBytes } = file
  if (usesExiftool(kind, input)) return sizeBytes * 3
  if (kind === 'jpeg') return sizeBytes * 2
  if (kind === 'video') return input.mode === 'exiftool' ? FAST_MP4_BYTES : 0 // safe mode: sidecar only
  if (input.mode !== 'exiftool') return 0 // safe mode RAW: sidecar only
  return sizeBytes * 2 // fast RAW
}

export interface RamEstimate {
  /** Total peak, including the resident interpreters. */
  totalBytes: number
  /** How much of it is the WASM interpreters (fixed, not per file). */
  workerBytes: number
  /** True when no file would go through the WASM interpreter at all. */
  wasmUnused: boolean
  /** Why it stays unused — the UI explains a pointless setting differently. */
  wasmUnusedReason?: 'no-files' | 'safe-mode' | 'fast-paths' | 'no-such-files'
}

/** Why nothing in this import would reach the WASM interpreter. */
function wasmUnusedReason(input: RamEstimateInput): RamEstimate['wasmUnusedReason'] {
  if (input.files.length === 0) return 'no-files'
  if (input.mode !== 'exiftool') return 'safe-mode'
  // In ExifTool mode a JPEG never gets there; everything else only stays away
  // because a fast path took it over.
  return input.files.some((f) => f.kind !== 'jpeg') ? 'fast-paths' : 'no-such-files'
}

export function estimatePeakRam(input: RamEstimateInput): RamEstimate {
  const anyExiftool = input.files.some((f) => usesExiftool(f.kind, input))
  const workerBytes = anyExiftool ? input.limits.exiftoolWorkers * WASM_WORKER_BYTES : 0

  // Clips rewritten through WASM take turns; everything else shares the slots.
  const serialVideo = (f: { kind: PhotoKind }) => f.kind === 'video' && usesExiftool(f.kind, input)
  const videoCosts = input.files.filter(serialVideo).map((f) => costOf(f, input))
  const biggestVideo = videoCosts.length > 0 ? Math.max(...videoCosts) : 0
  const slots = Math.max(1, input.limits.writeConcurrency) - (biggestVideo > 0 ? 1 : 0)

  const inFlight = input.files
    .filter((f) => !serialVideo(f))
    .map((f) => costOf(f, input))
    .sort((a, b) => b - a)
    .slice(0, Math.max(0, slots))
    .reduce((n, c) => n + c, 0)
  return {
    totalBytes: workerBytes + biggestVideo + inFlight,
    workerBytes,
    wasmUnused: !anyExiftool,
    wasmUnusedReason: anyExiftool ? undefined : wasmUnusedReason(input),
  }
}

/** Coarse phone check: far less RAM, and a killed tab loses the whole session. */
export function isMobileDevice(): boolean {
  return typeof navigator !== 'undefined' && /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent)
}

/** Logical cores, with a conservative guess when the browser hides them. */
export function logicalCores(): number {
  const n = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined
  return Math.max(1, Math.floor(typeof n === 'number' && n > 0 ? n : 4))
}

export const LIMIT_RANGES = {
  exiftoolWorkers: { min: 1, max: 6 },
  writeConcurrency: { min: 1, max: 12 },
} as const

const clampTo = (v: number, range: { min: number; max: number }): number =>
  Math.min(range.max, Math.max(range.min, v))

/**
 * Highest values worth offering on this device. Both knobs buy CPU-bound work —
 * a WASM interpreter, a JS rewrite of a whole file — so beyond the number of
 * logical cores they add memory without adding throughput. Workers leave one
 * core to the main thread, which keeps decoding previews during a write.
 */
export function limitCeilings(cores = logicalCores()): WriteLimits {
  return {
    writeConcurrency: clampTo(cores, LIMIT_RANGES.writeConcurrency),
    exiftoolWorkers: clampTo(cores - 1, LIMIT_RANGES.exiftoolWorkers),
  }
}

/** Memory the automatic choice may plan for: phones get far less headroom. */
export function ramBudgetBytes(mobile = isMobileDevice()): number {
  return (mobile ? 2 : 8) * 1024 * 1024 * 1024
}

/**
 * Starting limits, before anything is known about the files. Deliberately
 * modest: the automatic fit widens them once sizes are in (see fitLimits).
 */
export function defaultLimits(): WriteLimits {
  const ceilings = limitCeilings()
  const cap = (l: WriteLimits): WriteLimits => ({
    exiftoolWorkers: Math.min(l.exiftoolWorkers, ceilings.exiftoolWorkers),
    writeConcurrency: Math.min(l.writeConcurrency, ceilings.writeConcurrency),
  })
  if (isMobileDevice()) return cap({ exiftoolWorkers: 2, writeConcurrency: 4 })
  const memGb = (navigator as Navigator & { deviceMemory?: number })?.deviceMemory ?? 4
  return cap({
    exiftoolWorkers: Math.max(2, Math.min(4, Math.floor(logicalCores() / 2), Math.floor(memGb / 2))),
    writeConcurrency: 6,
  })
}

export interface FitLimitsInput extends Omit<RamEstimateInput, 'limits'> {
  /** Estimated peak the result must stay under. */
  budgetBytes: number
  /** Per-knob ceiling for this device. */
  ceilings: WriteLimits
  /** Worker count to keep when nothing in the import uses the WASM path. */
  workersWhenIdle: number
}

/**
 * The widest limits whose estimated peak still fits the budget — what the app
 * picks by itself once an import has finished loading and the sizes are known.
 *
 * Both knobs move together: an ExifTool worker can only be busy while a file is
 * in flight, so more workers than files-at-once is memory that never works. If
 * even the narrowest setting overshoots, that is returned anyway — a single
 * 2 GB clip cannot be made cheaper, and refusing to write it would be worse.
 */
export function fitLimits(input: FitLimitsInput): WriteLimits {
  const { budgetBytes, ceilings, workersWhenIdle } = input
  const wasm = !estimatePeakRam({ ...input, limits: ceilings }).wasmUnused
  const workersFor = (writeConcurrency: number): number =>
    wasm
      ? clampTo(Math.min(ceilings.exiftoolWorkers, writeConcurrency), LIMIT_RANGES.exiftoolWorkers)
      : Math.min(ceilings.exiftoolWorkers, workersWhenIdle)

  const floor = LIMIT_RANGES.writeConcurrency.min
  const top = Math.max(floor, ceilings.writeConcurrency)
  for (let wc = top; wc > floor; wc--) {
    const limits = { writeConcurrency: wc, exiftoolWorkers: workersFor(wc) }
    if (estimatePeakRam({ ...input, limits }).totalBytes <= budgetBytes) return limits
  }
  return { writeConcurrency: floor, exiftoolWorkers: workersFor(floor) }
}

/**
 * "240 MB" / "1.2 GB" — coarse on purpose, this is an estimate. Binary units,
 * so a 20 MiB file reads as the 20 MB the file manager shows and a budget of
 * 8 GiB reads as "8 GB" rather than "8.6 GB".
 */
export function formatBytes(bytes: number): string {
  const KB = 1024
  if (bytes >= KB ** 3) {
    const gb = bytes / KB ** 3
    return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`
  }
  if (bytes >= KB ** 2) return `${Math.round(bytes / KB ** 2)} MB`
  return `${Math.max(1, Math.round(bytes / KB))} kB`
}
