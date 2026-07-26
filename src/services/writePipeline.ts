import exifr from 'exifr'
import type { GeoPoint, Photo, Source } from '../domain/types'
import { generateXmpSidecar, mergeGpsIntoXmp, sidecarNameFor } from '../domain/xmp'
import {
  formatExifDateTime,
  formatTzOffset,
  insertGpsIntoJpeg,
  insertTimeIntoJpeg,
  validateJpegOutput,
  type TimeCorrection,
} from './exif/writeJpeg'
import { makeBatchEtaEstimator } from './eta'
import { LIMIT_RANGES } from './ramEstimate'
import { isFatalWasmError } from './exif/exiftoolRunner'
import { backupOriginal, readFileBytes, writeFileBytes, writeFileParts } from './fs/safeWrite'
import { Mp4StructureError, rewriteMp4Metadata } from './exif/mp4Writer'
import { TiffStructureError, rewriteTiffMetadata } from './exif/tiffWriter'
import { extractMeta } from './exif/readMeta'
import { probeTiff } from './exif/tiffReader'
import { directoryOf } from './fs/sources'
import type { ExiftoolRequest, ExiftoolResponse } from '../workers/exiftool.worker'

export type WriteMode = 'safe' | 'exiftool'

export interface WriteJobResult {
  photoId: string
  ok: boolean
  target?: 'exif' | 'sidecar'
  error?: string
  /** The corrected capture time was written into the file. */
  timeCorrection?: TimeCorrection
}

export interface WriteOptions {
  mode: WriteMode
  backupOriginals: boolean
  /** Also write the clock-corrected capture time + timezone into the files. */
  writeCorrectedTime?: boolean
  /** Photos written concurrently (safe mode: hides fixed FSA latency; ExifTool: match worker pool). */
  concurrency?: number
  /** ExifTool mode: photos without an assignment fall back to sidecar GPS. */
  embedSidecarGps?: boolean
  /** Experimental: edit MP4/MOV boxes directly in JS; falls back to ExifTool. */
  fastMp4?: boolean
  /** Experimental: edit TIFF-based RAWs directly in JS; falls back to ExifTool. */
  fastRaw?: boolean
  /** Checked between files: when true, no further file is started. */
  shouldStop?: () => boolean
  onProgress?: (done: number, total: number, current: string, etaMs?: number) => void
}

/**
 * Per-batch cache of resolved directory handles, keyed by source + folder.
 * Every FSA handle lookup is an IPC round trip; without the cache each photo
 * re-walks its folder path from the source root.
 */
export type DirCache = Map<string, Promise<FileSystemDirectoryHandle>>

export function directoryOfCached(
  root: FileSystemDirectoryHandle,
  sourceId: string,
  relativePath: string,
  dirs?: DirCache
): Promise<FileSystemDirectoryHandle> {
  if (!dirs) return directoryOf(root, relativePath)
  const key = `${sourceId}\u0000${relativePath.split('/').slice(0, -1).join('/')}`
  let entry = dirs.get(key)
  if (!entry) {
    entry = directoryOf(root, relativePath)
    // Don't cache failures — a later photo in the same folder may retry.
    entry.catch(() => dirs.delete(key))
    dirs.set(key, entry)
  }
  return entry
}

/**
 * Compute the capture-time correction for a photo, or undefined when there is
 * nothing to correct: no EXIF time, already corrected, or the source clock is
 * right and the file already carries a timezone.
 */
export function timeCorrectionFor(photo: Photo, source: Source): TimeCorrection | undefined {
  const meta = photo.meta
  // A sidecar time means the correction already lives next to the file.
  if (photo.sidecarTime) return undefined
  if (!meta || meta.timeSource !== 'exif' || meta.timeCorrected) return undefined
  const needsShift = source.clockOffsetMs !== 0
  const needsTz = meta.tzOffsetMin === undefined
  if (!needsShift && !needsTz) return undefined
  return {
    wallClockMs: meta.captureLocalMs + source.clockOffsetMs,
    tzOffsetMin: meta.tzOffsetMin ?? source.assumedTzOffsetMin,
  }
}

/** Lazy pool of ExifTool workers; each loads the 25 MB WASM on first use. */
let exiftoolWorkers: Worker[] = []
let exiftoolPoolSize = 1
let nextWorkerIndex = 0
let nextRequestId = 1
type SuccessResponse = Extract<ExiftoolResponse, { ok: true }>
const pendingRequests = new Map<
  number,
  { worker: Worker; resolve: (r: SuccessResponse) => void; reject: (e: Error) => void }
>()

/**
 * More workers multiply RAW write throughput at the cost of memory. The upper
 * bound is the one the limits dialog offers — capping lower here would silently
 * ignore the user's choice.
 */
export function setExiftoolPoolSize(n: number): void {
  const { min, max } = LIMIT_RANGES.exiftoolWorkers
  exiftoolPoolSize = Math.min(max, Math.max(min, n))
}

/**
 * A write failure worth ONE automatic retry: the WASM interpreter faulted
 * (corrupted after a background-tab freeze — the worker rebuilds it) or the
 * whole worker crashed (the pool is recreated on the next request). The
 * file was never touched, so retrying is safe; verification failures and
 * real I/O errors are NOT retried.
 */
export function isRecoverableWriteError(message: string): boolean {
  return isFatalWasmError(message) || /worker crashed/i.test(message)
}

/**
 * Terminate idle ExifTool workers so the next write boots fresh instances.
 * Used when a backgrounded tab becomes visible again: a frozen tab can leave
 * WASM memory corrupted ("memory access out of bounds" on the next write).
 * No-op while a write is in flight. Returns true when workers were recycled.
 */
export function resetIdleExiftoolWorkers(): boolean {
  if (exiftoolWorkers.length === 0 || pendingRequests.size > 0) return false
  for (const w of exiftoolWorkers) w.terminate()
  exiftoolWorkers = []
  return true
}

/**
 * Boot all pool workers in the background (WASM fetch + instantiation + one
 * dummy run) so the first real write does not pay the ~3 s cold start.
 * Fire-and-forget: failures surface on the first real write instead.
 */
export function warmupExiftool(): void {
  while (exiftoolWorkers.length < exiftoolPoolSize) {
    exiftoolWorkers.push(makeExiftoolWorker())
  }
  for (const worker of exiftoolWorkers) {
    const requestId = nextRequestId++
    new Promise<SuccessResponse>((resolve, reject) => {
      pendingRequests.set(requestId, { worker, resolve, reject })
      worker.postMessage({ type: 'warmup', requestId } satisfies ExiftoolRequest)
    }).catch(() => undefined)
  }
}

function makeExiftoolWorker(): Worker {
  const worker = new Worker(new URL('../workers/exiftool.worker.ts', import.meta.url), {
    type: 'module',
  })
  worker.onmessage = (event: MessageEvent<ExiftoolResponse>) => {
    const msg = event.data
    const pending = pendingRequests.get(msg.requestId)
    if (!pending) return
    pendingRequests.delete(msg.requestId)
    if (msg.ok) pending.resolve(msg)
    else pending.reject(new Error(msg.error))
  }
  worker.onerror = (e) => {
    // Only THIS worker's requests failed — healthy workers keep their
    // in-flight batches. The pool refills lazily on the next request.
    const err = new Error(e.message || 'ExifTool worker crashed')
    for (const [id, p] of pendingRequests) {
      if (p.worker === worker) {
        pendingRequests.delete(id)
        p.reject(err)
      }
    }
    worker.terminate()
    exiftoolWorkers = exiftoolWorkers.filter((w) => w !== worker)
  }
  return worker
}

function getExiftoolWorker(): Worker {
  if (exiftoolWorkers.length < exiftoolPoolSize) {
    exiftoolWorkers.push(makeExiftoolWorker())
    return exiftoolWorkers[exiftoolWorkers.length - 1]
  }
  nextWorkerIndex = (nextWorkerIndex + 1) % exiftoolWorkers.length
  return exiftoolWorkers[nextWorkerIndex]
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

function exiftoolRequest(
  request: DistributiveOmit<ExiftoolRequest, 'requestId'>,
  transfer: Transferable[]
): Promise<SuccessResponse> {
  const requestId = nextRequestId++
  const worker = getExiftoolWorker()
  return new Promise<SuccessResponse>((resolve, reject) => {
    pendingRequests.set(requestId, { worker, resolve, reject })
    worker.postMessage({ ...request, requestId } as ExiftoolRequest, transfer)
  })
}

async function exiftoolWriteGps(
  fileName: string,
  bytes: ArrayBuffer,
  gps: GeoPoint | undefined,
  time?: TimeCorrection,
  video?: boolean,
  dropInterop?: boolean
): Promise<ArrayBuffer> {
  const timeCorrection = time
    ? {
        exifDateTime: formatExifDateTime(time.wallClockMs),
        tzOffset: formatTzOffset(time.tzOffsetMin),
        // QuickTime dates are UTC — same instant, minus the timezone.
        utcDateTime: formatExifDateTime(time.wallClockMs - time.tzOffsetMin * 60_000),
      }
    : undefined
  const result = await exiftoolRequest(
    { type: 'write-gps', fileName, bytes, gps, timeCorrection, video, heavy: video, dropInterop },
    [bytes]
  )
  if (!('bytes' in result)) throw new Error('Unexpected worker response')
  return result.bytes
}

/** Raw ExifTool tag dump for the diagnostics dialog. */
export async function exiftoolInspect(fileName: string, bytes: ArrayBuffer): Promise<string> {
  const result = await exiftoolRequest({ type: 'inspect', fileName, bytes }, [bytes])
  if (!('text' in result)) throw new Error('Unexpected worker response')
  return result.text
}

/** Copy the original to <name>.orig when enabled (needs the folder handle —
 * individually-picked files have none, so backups are silently impossible). */
async function backupIfNeeded(photo: Photo, source: Source, backup: boolean, dirs?: DirCache): Promise<void> {
  if (!backup || !source.dirHandle) return
  const dir = await directoryOfCached(source.dirHandle, source.id, photo.relativePath, dirs)
  await backupOriginal(dir, photo.fileName)
}

/** The shared tail of every in-place write: backup first, then commit. */
async function backupThenWrite(
  photo: Photo,
  source: Source,
  bytes: Uint8Array | string,
  backup: boolean,
  dirs?: DirCache
): Promise<void> {
  await backupIfNeeded(photo, source, backup, dirs)
  await writeFileBytes(photo.fileHandle!, bytes)
}

async function writeJpegInPlace(
  photo: Photo,
  source: Source,
  gps: GeoPoint,
  backup: boolean,
  time?: TimeCorrection,
  dirs?: DirCache
): Promise<void> {
  if (!photo.fileHandle) throw new Error('Missing file handle')
  const original = await readFileBytes(photo.fileHandle)

  let originalDto: unknown
  try {
    const parsed = await exifr.parse(original.slice(0), { pick: ['DateTimeOriginal'] })
    originalDto = parsed?.DateTimeOriginal
  } catch {
    originalDto = undefined
  }

  const rewritten = insertGpsIntoJpeg(original, gps, photo.assignment?.effectiveUtcMs, time)
  await validateJpegOutput(rewritten, {
    originalSize: original.byteLength,
    gps,
    originalDateTimeOriginal: originalDto,
    expectedDateTimeMs: time?.wallClockMs,
  })

  await backupThenWrite(photo, source, rewritten, backup, dirs)
}

async function writeSidecar(
  photo: Photo,
  source: Source,
  gps: GeoPoint | undefined,
  time?: TimeCorrection,
  dirs?: DirCache
): Promise<void> {
  if (!source.dirHandle) {
    throw new Error(
      'XMP sidecars need access to the containing folder — add the folder as a source, or switch to ExifTool write mode'
    )
  }
  const dir = await directoryOfCached(source.dirHandle, source.id, photo.relativePath, dirs)
  const name = sidecarNameFor(photo.fileName)

  let content: string
  try {
    const existingHandle = await dir.getFileHandle(name)
    const existing = await (await existingHandle.getFile()).text()
    // Merge to preserve edits from other tools; throws on malformed XMP.
    content = mergeGpsIntoXmp(existing, gps, undefined, time)
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotFoundError') {
      content = generateXmpSidecar(gps, new Date(), time)
    } else if (err instanceof Error && err.message.includes('not valid XML')) {
      throw new Error(`Existing sidecar ${name} is malformed — not overwriting it`)
    } else if (err instanceof Error && err.message.includes('rdf:Description')) {
      throw new Error(`Existing sidecar ${name} has unexpected structure — not overwriting it`)
    } else {
      throw err
    }
  }

  const handle = await dir.getFileHandle(name, { create: true })
  await writeFileBytes(handle, content)
}

/**
 * At most one in-place VIDEO rewrite through ExifTool at a time: each run holds
 * the whole file plus its rewritten copy in WASM memory, so two large clips at
 * once are what takes the tab down. The lock sits around that operation rather
 * than around every video job, so the pure-JS fast path — which streams the
 * untouched bytes and holds almost nothing — runs fully in parallel, while a
 * file that falls back here still gets the protection.
 */
let videoRewriteTurn: Promise<void> = Promise.resolve()

function serializeVideoRewrite<T>(photo: Photo, run: () => Promise<T>): Promise<T> {
  if (photo.kind !== 'video') return run()
  const previous = videoRewriteTurn
  let release!: () => void
  videoRewriteTurn = new Promise((resolve) => (release = resolve))
  return (async () => {
    await previous
    try {
      return await run()
    } finally {
      release()
    }
  })()
}

/**
 * Rewriting holds the file plus its rewritten copy in memory, and a single
 * ArrayBuffer tops out around 2 GB — long clips can never fit. Fail fast
 * with advice instead of a cryptic allocation error.
 */
const MAX_REWRITE_BYTES = 1_300_000_000

async function assertRewritableSize(photo: Photo): Promise<void> {
  if (photo.kind !== 'video' || !photo.fileHandle) return
  const size = (await photo.fileHandle.getFile()).size
  if (size > MAX_REWRITE_BYTES) {
    throw new Error(
      `Video too large to rewrite in the browser (${(size / 1e9).toFixed(1)} GB) — use Safe mode to store the position in an .xmp sidecar instead`
    )
  }
}

async function writeViaExiftool(
  photo: Photo,
  source: Source,
  gps: GeoPoint,
  backup: boolean,
  time?: TimeCorrection,
  dirs?: DirCache
): Promise<void> {
  if (!photo.fileHandle) throw new Error('Missing file handle')
  await serializeVideoRewrite(photo, async () => {
    await assertRewritableSize(photo)
    const original = await readFileBytes(photo.fileHandle!)
    // Worker verifies GPS round-trip and size sanity before returning.
    const rewritten = await exiftoolWriteGps(
      photo.fileName,
      original,
      gps,
      time,
      photo.kind === 'video',
      isTiffRaw(photo)
    )
    await backupThenWrite(photo, source, new Uint8Array(rewritten), backup, dirs)
  })
}

/**
 * Experimental fast MP4 path: edit the container boxes directly in JS —
 * seconds instead of a WASM round trip, no whole-file buffers, no size cap.
 * Returns false when the writer doesn't understand the file (caller falls
 * back to ExifTool); the rebuilt moov is verified before anything is written.
 */
async function tryWriteVideoFast(
  photo: Photo,
  source: Source,
  gps: GeoPoint | undefined,
  backup: boolean,
  time?: TimeCorrection,
  dirs?: DirCache
): Promise<boolean> {
  if (!photo.fileHandle) throw new Error('Missing file handle')
  const file = await photo.fileHandle.getFile()
  let rewrite
  try {
    rewrite = await rewriteMp4Metadata(file, {
      gps,
      time: time
        ? { utcMs: time.wallClockMs - time.tzOffsetMin * 60_000, tzOffsetMin: time.tzOffsetMin }
        : undefined,
    })
  } catch (err) {
    if (err instanceof Mp4StructureError) return false
    throw err
  }
  if (rewrite.size < file.size) {
    throw new Error('Rewritten video is smaller than the original — refusing to overwrite')
  }
  await backupIfNeeded(photo, source, backup, dirs)
  await writeFileParts(photo.fileHandle, rewrite.parts)
  return true
}

/**
 * TIFF-based RAWs — the containers whose Interop IFD makes Windows misread the
 * GPS latitude. HEIC/RAF/CR3 are not TIFF and never carry one.
 */
const TIFF_RAW_EXTENSIONS = new Set(['arw', 'nef', 'cr2', 'dng', 'tif', 'tiff'])

export function isTiffRaw(photo: Photo): boolean {
  if (photo.kind !== 'raw') return false
  const dot = photo.fileName.lastIndexOf('.')
  return dot > 0 && TIFF_RAW_EXTENSIONS.has(photo.fileName.slice(dot + 1).toLowerCase())
}

/**
 * Experimental fast RAW path: append-and-repoint edit of TIFF-based files
 * (ARW/NEF/CR2/DNG) in JS. Returns false when the container isn't understood
 * OR the rewritten bytes fail verification — the ExifTool path then takes
 * over, so a false negative only costs speed, never correctness.
 */
async function tryWriteRawFast(
  photo: Photo,
  source: Source,
  gps: GeoPoint | undefined,
  backup: boolean,
  time?: TimeCorrection,
  dirs?: DirCache
): Promise<boolean> {
  if (!photo.fileHandle) throw new Error('Missing file handle')
  const original = await readFileBytes(photo.fileHandle)
  let rewritten: Uint8Array
  try {
    // Windows misreads GPS while an Interop IFD is present — drop it whenever
    // we are writing a position anyway.
    rewritten = rewriteTiffMetadata(original, { gps, time, dropInterop: gps !== undefined && isTiffRaw(photo) })
  } catch (err) {
    if (err instanceof TiffStructureError) return false
    throw err
  }
  // Verify through the app's own import path — the same chunked EXIF parse plus
  // targeted GPS-pointer read that will run when this folder is reloaded. A
  // full-buffer parse would happily find metadata that the import never sees.
  const meta = await extractMeta(new File([rewritten as BlobPart], photo.fileName), 0, photo.kind)
  if (gps) {
    const back = meta.originalGps
    if (!back || Math.abs(back.lat - gps.lat) > 1e-4 || Math.abs(back.lon - gps.lon) > 1e-4) {
      return false
    }
  }
  if (time && Math.abs(meta.captureLocalMs - time.wallClockMs) > 1000) return false
  await backupThenWrite(photo, source, rewritten, backup, dirs)
  return true
}

/**
 * Write one photo's assigned GPS. Returns which target was written.
 * Mode 'safe': JPEG in place (pure JS), everything else gets an XMP sidecar.
 * Mode 'exiftool': every format written in place via ExifTool WASM.
 */
export async function writePhoto(
  photo: Photo,
  source: Source,
  options: WriteOptions,
  dirs?: DirCache
): Promise<{ target: 'exif' | 'sidecar'; timeCorrection?: TimeCorrection }> {
  const gps = photo.assignment?.point ?? (options.embedSidecarGps ? photo.sidecarGps : undefined)
  if (!gps) throw new Error('Photo has no assigned position')
  const time = options.writeCorrectedTime ? timeCorrectionFor(photo, source) : undefined

  // JPEGs always take the pure-JS path (~50ms, identically verified) — the
  // ExifTool WASM run (~2s/file) is reserved for formats that need it.
  if (photo.kind === 'jpeg') {
    await writeJpegInPlace(photo, source, gps, options.backupOriginals, time, dirs)
    return { target: 'exif', timeCorrection: time }
  }
  if (options.mode === 'exiftool') {
    if (photo.kind === 'video' && options.fastMp4) {
      if (await tryWriteVideoFast(photo, source, gps, options.backupOriginals, time, dirs)) {
        return { target: 'exif', timeCorrection: time }
      }
    }
    if (photo.kind === 'raw' && options.fastRaw) {
      if (await tryWriteRawFast(photo, source, gps, options.backupOriginals, time, dirs)) {
        return { target: 'exif', timeCorrection: time }
      }
    }
    await writeViaExiftool(photo, source, gps, options.backupOriginals, time, dirs)
    return { target: 'exif', timeCorrection: time }
  }
  await writeSidecar(photo, source, gps, time, dirs)
  return { target: 'sidecar', timeCorrection: time }
}

/**
 * Write ONLY the corrected capture time (no GPS) into one photo's file.
 * Used for photos that got a clock fix but no position.
 */
export async function writeTimeOnlyPhoto(
  photo: Photo,
  source: Source,
  options: WriteOptions,
  time: TimeCorrection,
  dirs?: DirCache
): Promise<'exif' | 'sidecar'> {
  if (options.mode === 'exiftool' && photo.kind !== 'jpeg') {
    if (!photo.fileHandle) throw new Error('Missing file handle')
    if (photo.kind === 'video' && options.fastMp4) {
      if (await tryWriteVideoFast(photo, source, undefined, options.backupOriginals, time, dirs)) {
        return 'exif'
      }
    }
    if (photo.kind === 'raw' && options.fastRaw) {
      if (await tryWriteRawFast(photo, source, undefined, options.backupOriginals, time, dirs)) {
        return 'exif'
      }
    }
    await serializeVideoRewrite(photo, async () => {
      await assertRewritableSize(photo)
      const original = await readFileBytes(photo.fileHandle!)
      const rewritten = await exiftoolWriteGps(photo.fileName, original, undefined, time, photo.kind === 'video')
      await backupThenWrite(photo, source, new Uint8Array(rewritten), options.backupOriginals, dirs)
    })
    return 'exif'
  }
  if (photo.kind === 'jpeg') {
    if (!photo.fileHandle) throw new Error('Missing file handle')
    const original = await readFileBytes(photo.fileHandle)
    const rewritten = insertTimeIntoJpeg(original, time)
    await validateJpegOutput(rewritten, {
      originalSize: original.byteLength,
      expectedDateTimeMs: time.wallClockMs,
    })
    await backupThenWrite(photo, source, rewritten, options.backupOriginals, dirs)
    return 'exif'
  }
  await writeSidecar(photo, source, undefined, time, dirs)
  return 'sidecar'
}

/**
 * Repair a file whose Interop IFD makes Windows misread its GPS, without
 * touching the position or the time. Prefers the pure-JS path (a 12-byte table
 * edit, no data moved); falls back to ExifTool, which rewrites the metadata
 * block properly.
 */
export async function writeInteropFix(
  photo: Photo,
  source: Source,
  options: WriteOptions,
  dirs?: DirCache
): Promise<void> {
  if (!photo.fileHandle) throw new Error('Missing file handle')
  if (!isTiffRaw(photo)) throw new Error('Not a TIFF-based RAW')
  const original = await readFileBytes(photo.fileHandle)

  if (options.fastRaw) {
    try {
      const rewritten = rewriteTiffMetadata(original, { dropInterop: true })
      const probe = await probeTiff(new Blob([rewritten as BlobPart]))
      if (!probe.hasInterop) {
        // The position must survive the repair — it is the whole point.
        const before = await probeTiff(new Blob([new Uint8Array(original) as BlobPart]))
        if (!before.gps || probe.gps) {
          await backupThenWrite(photo, source, rewritten, options.backupOriginals, dirs)
          return
        }
      }
    } catch (err) {
      if (!(err instanceof TiffStructureError)) throw err
    }
  }
  const rewritten = await exiftoolWriteGps(photo.fileName, original, undefined, undefined, false, true)
  await backupThenWrite(photo, source, new Uint8Array(rewritten), options.backupOriginals, dirs)
}

/** Batch the Interop repair over many files, reporting each result. */
export async function writeInteropBatch(
  photos: Photo[],
  sources: Map<string, Source>,
  options: WriteOptions,
  onResult: (result: WriteJobResult) => void
): Promise<WriteJobResult[]> {
  const dirs: DirCache = new Map()
  return runWriteJobs(
    photos,
    options,
    async (photo) => {
      const source = sources.get(photo.sourceId)
      if (!source) return { photoId: photo.id, ok: false, error: 'Unknown source' }
      try {
        await writeInteropFix(photo, source, options, dirs)
        return { photoId: photo.id, ok: true, target: 'exif' }
      } catch (err) {
        return { photoId: photo.id, ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    onResult
  )
}

/** Batch clock-fix writes for photos without (or independent of) a GPS assignment. */
export async function writeTimeBatch(
  photos: Photo[],
  sources: Map<string, Source>,
  options: WriteOptions,
  onResult: (result: WriteJobResult) => void
): Promise<WriteJobResult[]> {
  const dirs: DirCache = new Map()
  return runWriteJobs(
    photos,
    options,
    async (photo) => {
      const source = sources.get(photo.sourceId)
      const time = source ? timeCorrectionFor(photo, source) : undefined
      if (!source) return { photoId: photo.id, ok: false, error: 'Unknown source' }
      if (!time) return { photoId: photo.id, ok: false, error: 'Nothing to correct' }
      try {
        const target = await writeTimeOnlyPhoto(photo, source, options, time, dirs)
        return { photoId: photo.id, ok: true, target, timeCorrection: time }
      } catch (err) {
        return { photoId: photo.id, ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    onResult
  )
}

/** ETA classes: JPEGs take the fast pure-JS path, everything else does not. */
function etaKind(photo: Photo): string {
  return photo.kind === 'jpeg' ? 'jpeg' : photo.kind === 'video' ? 'video' : 'raw'
}

/**
 * Relative per-file cost per ETA class, used until a class has measured itself.
 * ExifTool mode: a JPEG is pure JS (~50 ms), a RAW is a whole WASM run (~2 s),
 * a video is that over hundreds of megabytes (~20 s). Safe mode only rewrites
 * JPEGs; everything else gets a small sidecar written next to it.
 */
function etaPriors(mode: WriteMode): Record<string, number> {
  return mode === 'exiftool' ? { jpeg: 1, raw: 25, video: 250 } : { jpeg: 2, raw: 1, video: 1 }
}

/** Run per-photo write jobs with bounded concurrency, preserving reporting. */
async function runWriteJobs(
  photos: Photo[],
  options: WriteOptions,
  job: (photo: Photo) => Promise<WriteJobResult>,
  onResult: (result: WriteJobResult) => void
): Promise<WriteJobResult[]> {
  const results: WriteJobResult[] = []
  // Videos go LAST: rewriting them in WASM memory is the one thing that can
  // crash the tab, so every photo is safely written before the first video.
  const queue = [...photos].sort((a, b) => Number(a.kind === 'video') - Number(b.kind === 'video'))
  let completed = 0
  const workerCount = Math.max(1, Math.min(options.concurrency ?? 1, photos.length))
  // Videos are written one at a time only where that is actually needed — an
  // in-place ExifTool rewrite (see serializeVideoRewrite). With the fast MP4
  // path they stream, so they neither need the lock nor count as serial work.
  const serialVideos = options.mode === 'exiftool' && !options.fastMp4
  // Per-file-class service times keep mixed JPEG/RAW batches from whipsawing
  // the ETA; dividing by the worker count keeps parallel bursts from doing so —
  // except for classes that run strictly one at a time.
  const eta = makeBatchEtaEstimator(workerCount, {
    serialKinds: serialVideos ? new Set(['video']) : undefined,
    priors: etaPriors(options.mode),
  })
  const remainingByKind: Record<string, number> = {}
  for (const p of photos) remainingByKind[etaKind(p)] = (remainingByKind[etaKind(p)] ?? 0) + 1

  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      // Stop takes effect between files: the current one always completes.
      if (options.shouldStop?.()) return
      const photo = queue.shift()
      if (!photo) return
      const runJob = async (): Promise<WriteJobResult> => {
        options.onProgress?.(completed, photos.length, photo.fileName, eta.estimate(remainingByKind))
        let startedAt = Date.now()
        let result = await job(photo)
        if (!result.ok && result.error && isRecoverableWriteError(result.error)) {
          // The worker rebuilt its interpreter (or the crashed pool will be
          // recreated) — the file is untouched, so one retry is safe. Time the
          // retry alone; the failed attempt is not a service time.
          startedAt = Date.now()
          result = await job(photo)
        }
        // Only successful writes are representative: a file rejected up front
        // (unknown source, nothing to correct) returns in ~0 ms and would drag
        // the projection for the files still queued down with it.
        if (result.ok) eta.record(etaKind(photo), Date.now() - startedAt)
        return result
      }
      const result = await runJob()
      remainingByKind[etaKind(photo)]--
      completed++
      results.push(result)
      onResult(result)
    }
  })
  await Promise.all(workers)
  options.onProgress?.(completed, photos.length, '', eta.estimate(remainingByKind))
  return results
}

/** Batch GPS writes. Continues past per-file errors; reports each result. */
export async function writeBatch(
  photos: Photo[],
  sources: Map<string, Source>,
  options: WriteOptions,
  onResult: (result: WriteJobResult) => void
): Promise<WriteJobResult[]> {
  const dirs: DirCache = new Map()
  return runWriteJobs(
    photos,
    options,
    async (photo) => {
      const source = sources.get(photo.sourceId)
      if (!source) return { photoId: photo.id, ok: false, error: 'Unknown source' }
      try {
        const { target, timeCorrection } = await writePhoto(photo, source, options, dirs)
        return { photoId: photo.id, ok: true, target, timeCorrection }
      } catch (err) {
        return { photoId: photo.id, ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    onResult
  )
}
