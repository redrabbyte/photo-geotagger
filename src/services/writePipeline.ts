import exifr from 'exifr'
import type { GeoPoint, Photo, Source } from '../domain/types'
import { generateXmpSidecar, mergeGpsIntoXmp, sidecarNameFor } from '../domain/xmp'
import { insertGpsIntoJpeg, validateJpegOutput } from './exif/writeJpeg'
import { backupOriginal, writeFileBytes } from './fs/safeWrite'
import { directoryOf } from './fs/sources'
import type { ExiftoolRequest, ExiftoolResponse } from '../workers/exiftool.worker'

export type WriteMode = 'safe' | 'exiftool'

export interface WriteJobResult {
  photoId: string
  ok: boolean
  target?: 'exif' | 'sidecar'
  error?: string
}

export interface WriteOptions {
  mode: WriteMode
  backupOriginals: boolean
  onProgress?: (done: number, total: number, current: string) => void
}

/** Lazy singleton for the ExifTool worker; the 25 MB WASM loads on first use. */
let exiftoolWorker: Worker | undefined
let nextRequestId = 1
type SuccessResponse = Extract<ExiftoolResponse, { ok: true }>
const pendingRequests = new Map<number, { resolve: (r: SuccessResponse) => void; reject: (e: Error) => void }>()

function getExiftoolWorker(): Worker {
  if (!exiftoolWorker) {
    exiftoolWorker = new Worker(new URL('../workers/exiftool.worker.ts', import.meta.url), {
      type: 'module',
    })
    exiftoolWorker.onmessage = (event: MessageEvent<ExiftoolResponse>) => {
      const msg = event.data
      const pending = pendingRequests.get(msg.requestId)
      if (!pending) return
      pendingRequests.delete(msg.requestId)
      if (msg.ok) pending.resolve(msg)
      else pending.reject(new Error(msg.error))
    }
    exiftoolWorker.onerror = (e) => {
      const err = new Error(e.message || 'ExifTool worker crashed')
      for (const p of pendingRequests.values()) p.reject(err)
      pendingRequests.clear()
      exiftoolWorker?.terminate()
      exiftoolWorker = undefined
    }
  }
  return exiftoolWorker
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

async function exiftoolWriteGps(fileName: string, bytes: ArrayBuffer, gps: GeoPoint): Promise<ArrayBuffer> {
  const result = await exiftoolRequest({ type: 'write-gps', fileName, bytes, gps }, [bytes])
  if (!('bytes' in result)) throw new Error('Unexpected worker response')
  return result.bytes
}

/** Raw ExifTool tag dump for the diagnostics dialog. */
export async function exiftoolInspect(fileName: string, bytes: ArrayBuffer): Promise<string> {
  const result = await exiftoolRequest({ type: 'inspect', fileName, bytes }, [bytes])
  if (!('text' in result)) throw new Error('Unexpected worker response')
  return result.text
}

const READ_ONLY_ERROR =
  'This source was loaded read-only (classic folder input) — re-add it via "+ Folder" to write'

async function writeJpegInPlace(photo: Photo, source: Source, gps: GeoPoint, backup: boolean): Promise<void> {
  if (!photo.fileHandle) throw new Error(READ_ONLY_ERROR)
  const file = await photo.fileHandle.getFile()
  const original = await file.arrayBuffer()

  let originalDto: unknown
  try {
    const parsed = await exifr.parse(original.slice(0), { pick: ['DateTimeOriginal'] })
    originalDto = parsed?.DateTimeOriginal
  } catch {
    originalDto = undefined
  }

  const rewritten = insertGpsIntoJpeg(original, gps, photo.assignment?.effectiveUtcMs)
  await validateJpegOutput(rewritten, {
    originalSize: original.byteLength,
    gps,
    originalDateTimeOriginal: originalDto,
  })

  // Individually-picked files have no folder handle: backups are impossible.
  if (backup && source.dirHandle) {
    const dir = await directoryOf(source.dirHandle, photo.relativePath)
    await backupOriginal(dir, photo.fileName)
  }
  await writeFileBytes(photo.fileHandle, rewritten)
}

async function writeSidecar(photo: Photo, source: Source, gps: GeoPoint): Promise<void> {
  if (!source.dirHandle) {
    throw new Error(
      'XMP sidecars need access to the containing folder — add the folder as a source, or switch to ExifTool write mode'
    )
  }
  const dir = await directoryOf(source.dirHandle, photo.relativePath)
  const name = sidecarNameFor(photo.fileName)

  let content: string
  try {
    const existingHandle = await dir.getFileHandle(name)
    const existing = await (await existingHandle.getFile()).text()
    // Merge to preserve edits from other tools; throws on malformed XMP.
    content = mergeGpsIntoXmp(existing, gps)
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotFoundError') {
      content = generateXmpSidecar(gps)
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

async function writeViaExiftool(photo: Photo, source: Source, gps: GeoPoint, backup: boolean): Promise<void> {
  if (!photo.fileHandle) throw new Error(READ_ONLY_ERROR)
  const file = await photo.fileHandle.getFile()
  const original = await file.arrayBuffer()
  // Worker verifies GPS round-trip and size sanity before returning.
  const rewritten = await exiftoolWriteGps(photo.fileName, original, gps)

  if (backup && source.dirHandle) {
    const dir = await directoryOf(source.dirHandle, photo.relativePath)
    await backupOriginal(dir, photo.fileName)
  }
  await writeFileBytes(photo.fileHandle, new Uint8Array(rewritten))
}

/**
 * Write one photo's assigned GPS. Returns which target was written.
 * Mode 'safe': JPEG in place (pure JS), everything else gets an XMP sidecar.
 * Mode 'exiftool': every format written in place via ExifTool WASM.
 */
export async function writePhoto(photo: Photo, source: Source, options: WriteOptions): Promise<'exif' | 'sidecar'> {
  const gps = photo.assignment?.point
  if (!gps) throw new Error('Photo has no assigned position')

  if (options.mode === 'exiftool') {
    await writeViaExiftool(photo, source, gps, options.backupOriginals)
    return 'exif'
  }
  if (photo.kind === 'jpeg') {
    await writeJpegInPlace(photo, source, gps, options.backupOriginals)
    return 'exif'
  }
  await writeSidecar(photo, source, gps)
  return 'sidecar'
}

/** Sequential batch write. Continues past per-file errors; reports each result. */
export async function writeBatch(
  photos: Photo[],
  sources: Map<string, Source>,
  options: WriteOptions,
  onResult: (result: WriteJobResult) => void
): Promise<WriteJobResult[]> {
  const results: WriteJobResult[] = []
  let done = 0
  for (const photo of photos) {
    options.onProgress?.(done, photos.length, photo.fileName)
    const source = sources.get(photo.sourceId)
    let result: WriteJobResult
    if (!source) {
      result = { photoId: photo.id, ok: false, error: 'Unknown source' }
    } else {
      try {
        const target = await writePhoto(photo, source, options)
        result = { photoId: photo.id, ok: true, target }
      } catch (err) {
        result = { photoId: photo.id, ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
    results.push(result)
    onResult(result)
    done++
  }
  options.onProgress?.(done, photos.length, '')
  return results
}
