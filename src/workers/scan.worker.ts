/// <reference lib="webworker" />
import exifr from 'exifr'
import type { PhotoKind, PhotoMeta } from '../domain/types'
import { extractMeta } from '../services/exif/readMeta'
import { needsManualOrientation, normalizeOrientation, orientedBlob } from '../services/exif/orient'

export interface ScanJob {
  id: string
  handle: FileSystemFileHandle
  kind: PhotoKind
  /** EXIF orientation when already known (thumb jobs); read on demand otherwise. */
  orientation?: number
}

/** 'scan' extracts metadata only; 'thumb' generates thumbnails on demand. */
export interface ScanRequest {
  type: 'scan' | 'thumb'
  jobs: ScanJob[]
}

export type ScanResponse =
  | { type: 'meta'; id: string; meta: PhotoMeta; sizeBytes: number; lastModified: number }
  | { type: 'thumb'; id: string; blob: Blob }
  | { type: 'thumb-failed'; id: string }
  | { type: 'error'; id: string; message: string }
  | { type: 'batch-done' }

const THUMB_SIZE = 320
/** Embedded previews up to this size are shown as-is — no decode/re-encode. */
const DIRECT_THUMB_MAX_BYTES = 128 * 1024

async function downscale(source: Blob | File): Promise<Blob | undefined> {
  try {
    // Let the decoder downsample: substantially cheaper than decoding the
    // full image and shrinking it on a canvas afterwards.
    const bitmap = await createImageBitmap(source, {
      imageOrientation: 'from-image',
      resizeWidth: THUMB_SIZE,
      resizeQuality: 'medium',
    })
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close()
    return await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 })
  } catch {
    return undefined
  }
}

async function readOrientation(file: File): Promise<number | undefined> {
  try {
    const parsed = await exifr.parse(file, { pick: ['Orientation'], translateValues: false })
    return normalizeOrientation(parsed?.Orientation)
  } catch {
    return undefined
  }
}

async function extractThumb(file: File, kind: PhotoKind, orientation?: number): Promise<Blob | undefined> {
  // Videos have no EXIF preview and createImageBitmap cannot decode them.
  if (kind === 'video') return undefined
  // Embedded EXIF preview first: cheap, and the only option for RAW/HEIC.
  try {
    const embedded = await exifr.thumbnail(file)
    if (embedded) {
      const blob = new Blob([embedded as BlobPart], { type: 'image/jpeg' })
      // The RAW's orientation tag rarely makes it into the embedded preview —
      // apply it by hand or portrait shots render sideways.
      const o = orientation ?? (await readOrientation(file)) ?? 1
      if (o !== 1) {
        const bitmap = await createImageBitmap(blob)
        try {
          const manual = needsManualOrientation(o, bitmap.width, bitmap.height)
          const oriented = await orientedBlob(bitmap, manual ? o : 1, THUMB_SIZE)
          if (oriented) return oriented
        } finally {
          bitmap.close()
        }
      }
      // Small previews go out untouched — re-encoding costs ~20x more than
      // handing the browser the original JPEG bytes.
      if (blob.size <= DIRECT_THUMB_MAX_BYTES) return blob
      return (await downscale(blob)) ?? blob
    }
  } catch {
    // fall through
  }
  // JPEGs decode natively; downsample from the full image ('from-image'
  // handles the orientation — the file carries its own EXIF).
  if (kind === 'jpeg') return downscale(file)
  return undefined
}

self.onmessage = async (event: MessageEvent<ScanRequest>) => {
  const { type, jobs } = event.data
  for (const job of jobs) {
    try {
      const file = await job.handle.getFile()
      if (type === 'scan') {
        const meta = await extractMeta(file, file.lastModified, job.kind)
        postMessage({
          type: 'meta',
          id: job.id,
          meta,
          sizeBytes: file.size,
          lastModified: file.lastModified,
        } satisfies ScanResponse)
      } else {
        const thumb = await extractThumb(file, job.kind, job.orientation)
        if (thumb) {
          postMessage({ type: 'thumb', id: job.id, blob: thumb } satisfies ScanResponse)
        } else {
          postMessage({ type: 'thumb-failed', id: job.id } satisfies ScanResponse)
        }
      }
    } catch (err) {
      if (type === 'scan') {
        postMessage({
          type: 'error',
          id: job.id,
          message: err instanceof Error ? err.message : String(err),
        } satisfies ScanResponse)
      } else {
        postMessage({ type: 'thumb-failed', id: job.id } satisfies ScanResponse)
      }
    }
  }
  postMessage({ type: 'batch-done' } satisfies ScanResponse)
}
