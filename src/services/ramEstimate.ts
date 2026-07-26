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
  return { totalBytes: workerBytes + biggestVideo + inFlight, workerBytes, wasmUnused: !anyExiftool }
}

/** "≈ 240 MB" / "≈ 1.2 GB" — coarse on purpose, this is an estimate. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  return `${Math.max(1, Math.round(bytes / 1e3))} kB`
}
