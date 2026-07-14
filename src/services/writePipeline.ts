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
import { backupOriginal, writeFileBytes } from './fs/safeWrite'
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
  /** Checked between files: when true, no further file is started. */
  shouldStop?: () => boolean
  onProgress?: (done: number, total: number, current: string) => void
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
const pendingRequests = new Map<number, { resolve: (r: SuccessResponse) => void; reject: (e: Error) => void }>()

/** 2 workers double RAW write throughput at the cost of memory. */
export function setExiftoolPoolSize(n: number): void {
  exiftoolPoolSize = Math.max(1, Math.min(4, n))
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
    const err = new Error(e.message || 'ExifTool worker crashed')
    for (const p of pendingRequests.values()) p.reject(err)
    pendingRequests.clear()
    for (const w of exiftoolWorkers) w.terminate()
    exiftoolWorkers = []
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
    pendingRequests.set(requestId, { resolve, reject })
    worker.postMessage({ ...request, requestId } as ExiftoolRequest, transfer)
  })
}

async function exiftoolWriteGps(
  fileName: string,
  bytes: ArrayBuffer,
  gps: GeoPoint | undefined,
  time?: TimeCorrection
): Promise<ArrayBuffer> {
  const timeCorrection = time
    ? { exifDateTime: formatExifDateTime(time.wallClockMs), tzOffset: formatTzOffset(time.tzOffsetMin) }
    : undefined
  const result = await exiftoolRequest({ type: 'write-gps', fileName, bytes, gps, timeCorrection }, [bytes])
  if (!('bytes' in result)) throw new Error('Unexpected worker response')
  return result.bytes
}

/** Raw ExifTool tag dump for the diagnostics dialog. */
export async function exiftoolInspect(fileName: string, bytes: ArrayBuffer): Promise<string> {
  const result = await exiftoolRequest({ type: 'inspect', fileName, bytes }, [bytes])
  if (!('text' in result)) throw new Error('Unexpected worker response')
  return result.text
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
  const file = await photo.fileHandle.getFile()
  const original = await file.arrayBuffer()

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

  // Individually-picked files have no folder handle: backups are impossible.
  if (backup && source.dirHandle) {
    const dir = await directoryOfCached(source.dirHandle, source.id, photo.relativePath, dirs)
    await backupOriginal(dir, photo.fileName)
  }
  await writeFileBytes(photo.fileHandle, rewritten)
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

async function writeViaExiftool(
  photo: Photo,
  source: Source,
  gps: GeoPoint,
  backup: boolean,
  time?: TimeCorrection,
  dirs?: DirCache
): Promise<void> {
  if (!photo.fileHandle) throw new Error('Missing file handle')
  const file = await photo.fileHandle.getFile()
  const original = await file.arrayBuffer()
  // Worker verifies GPS round-trip and size sanity before returning.
  const rewritten = await exiftoolWriteGps(photo.fileName, original, gps, time)

  if (backup && source.dirHandle) {
    const dir = await directoryOfCached(source.dirHandle, source.id, photo.relativePath, dirs)
    await backupOriginal(dir, photo.fileName)
  }
  await writeFileBytes(photo.fileHandle, new Uint8Array(rewritten))
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
    const file = await photo.fileHandle.getFile()
    const original = await file.arrayBuffer()
    const rewritten = await exiftoolWriteGps(photo.fileName, original, undefined, time)
    if (options.backupOriginals && source.dirHandle) {
      const dir = await directoryOfCached(source.dirHandle, source.id, photo.relativePath, dirs)
      await backupOriginal(dir, photo.fileName)
    }
    await writeFileBytes(photo.fileHandle, new Uint8Array(rewritten))
    return 'exif'
  }
  if (photo.kind === 'jpeg') {
    if (!photo.fileHandle) throw new Error('Missing file handle')
    const file = await photo.fileHandle.getFile()
    const original = await file.arrayBuffer()
    const rewritten = insertTimeIntoJpeg(original, time)
    await validateJpegOutput(rewritten, {
      originalSize: original.byteLength,
      expectedDateTimeMs: time.wallClockMs,
    })
    if (options.backupOriginals && source.dirHandle) {
      const dir = await directoryOfCached(source.dirHandle, source.id, photo.relativePath, dirs)
      await backupOriginal(dir, photo.fileName)
    }
    await writeFileBytes(photo.fileHandle, rewritten)
    return 'exif'
  }
  await writeSidecar(photo, source, undefined, time, dirs)
  return 'sidecar'
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

/** Run per-photo write jobs with bounded concurrency, preserving reporting. */
async function runWriteJobs(
  photos: Photo[],
  options: WriteOptions,
  job: (photo: Photo) => Promise<WriteJobResult>,
  onResult: (result: WriteJobResult) => void
): Promise<WriteJobResult[]> {
  const results: WriteJobResult[] = []
  const queue = [...photos]
  let completed = 0
  const workers = Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 1, photos.length)) }, async () => {
    for (;;) {
      // Stop takes effect between files: the current one always completes.
      if (options.shouldStop?.()) return
      const photo = queue.shift()
      if (!photo) return
      options.onProgress?.(completed, photos.length, photo.fileName)
      const result = await job(photo)
      completed++
      results.push(result)
      onResult(result)
    }
  })
  await Promise.all(workers)
  options.onProgress?.(completed, photos.length, '')
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
