/// <reference lib="webworker" />
import exifr from 'exifr'
import type { PhotoKind, PhotoMeta } from '../domain/types'
import { extractMeta } from '../services/exif/readMeta'

export interface ScanJob {
  id: string
  kind: PhotoKind
  handle?: FileSystemFileHandle
  /** Plain File for read-only sources (classic <input> folder picker). */
  file?: File
}

export interface ScanRequest {
  type: 'scan'
  jobs: ScanJob[]
}

export type ScanResponse =
  | { type: 'meta'; id: string; meta: PhotoMeta; sizeBytes: number; lastModified: number }
  | { type: 'thumb'; id: string; blob: Blob }
  | { type: 'thumb-failed'; id: string }
  | { type: 'error'; id: string; message: string }
  | { type: 'batch-done' }

const THUMB_SIZE = 320

async function downscale(source: ImageBitmapSource): Promise<Blob | undefined> {
  try {
    const bitmap = await createImageBitmap(source as Blob, { imageOrientation: 'from-image' })
    const scale = Math.min(1, THUMB_SIZE / Math.max(bitmap.width, bitmap.height))
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close()
    return await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 })
  } catch {
    return undefined
  }
}

async function extractThumb(file: File, kind: PhotoKind): Promise<Blob | undefined> {
  // Embedded EXIF preview first: cheap, and the only option for RAW/HEIC.
  try {
    const embedded = await exifr.thumbnail(file)
    if (embedded) {
      const blob = new Blob([embedded as BlobPart], { type: 'image/jpeg' })
      return (await downscale(blob)) ?? blob
    }
  } catch {
    // fall through
  }
  // JPEGs decode natively; downscale from the full image.
  if (kind === 'jpeg') return downscale(file)
  return undefined
}

self.onmessage = async (event: MessageEvent<ScanRequest>) => {
  const { jobs } = event.data
  for (const job of jobs) {
    try {
      const file = job.file ?? (await job.handle!.getFile())
      const meta = await extractMeta(file, file.lastModified)
      postMessage({
        type: 'meta',
        id: job.id,
        meta,
        sizeBytes: file.size,
        lastModified: file.lastModified,
      } satisfies ScanResponse)
      const thumb = await extractThumb(file, job.kind)
      if (thumb) {
        postMessage({ type: 'thumb', id: job.id, blob: thumb } satisfies ScanResponse)
      } else {
        postMessage({ type: 'thumb-failed', id: job.id } satisfies ScanResponse)
      }
    } catch (err) {
      postMessage({
        type: 'error',
        id: job.id,
        message: err instanceof Error ? err.message : String(err),
      } satisfies ScanResponse)
    }
  }
  postMessage({ type: 'batch-done' } satisfies ScanResponse)
}
