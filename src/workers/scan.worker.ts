/// <reference lib="webworker" />
import exifr from 'exifr'
import type { PhotoKind, PhotoMeta } from '../domain/types'

export interface ScanJob {
  id: string
  handle: FileSystemFileHandle
  kind: PhotoKind
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

const EXIFR_OPTIONS: NonNullable<Parameters<typeof exifr.parse>[1]> = {
  tiff: true,
  exif: true,
  gps: true,
  translateValues: true,
  reviveValues: true,
  pick: [
    'DateTimeOriginal',
    'CreateDate',
    'OffsetTimeOriginal',
    'OffsetTime',
    'Model',
    'ExifImageWidth',
    'ExifImageHeight',
    'GPSLatitude',
    'GPSLongitude',
    'GPSAltitude',
    'GPSAltitudeRef',
    'latitude',
    'longitude',
  ],
}

/**
 * exifr revives EXIF datetimes as Date objects in the MACHINE's local zone.
 * Convert back to wall-clock-as-UTC milliseconds so timezone handling stays
 * explicit in the domain layer.
 */
function wallClockMs(d: Date): number {
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds())
}

function parseTzOffsetMin(offset: unknown): number | undefined {
  if (typeof offset !== 'string') return undefined
  const m = offset.match(/^([+-])(\d{2}):(\d{2})$/)
  if (!m) return undefined
  const sign = m[1] === '-' ? -1 : 1
  return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10))
}

async function extractMeta(file: File): Promise<PhotoMeta> {
  let exif: Record<string, unknown> | undefined
  try {
    exif = await exifr.parse(file, EXIFR_OPTIONS)
  } catch {
    exif = undefined
  }

  const dto = exif?.DateTimeOriginal ?? exif?.CreateDate
  const meta: PhotoMeta = dto instanceof Date
    ? { captureLocalMs: wallClockMs(dto), timeSource: 'exif' }
    : { captureLocalMs: file.lastModified, timeSource: 'file', tzOffsetMin: 0 }

  if (meta.timeSource === 'exif') {
    meta.tzOffsetMin = parseTzOffsetMin(exif?.OffsetTimeOriginal ?? exif?.OffsetTime)
  }

  const lat = exif?.latitude
  const lon = exif?.longitude
  if (typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon)) {
    let ele: number | undefined
    const alt = exif?.GPSAltitude
    if (typeof alt === 'number' && Number.isFinite(alt)) {
      const ref = exif?.GPSAltitudeRef
      ele = ref === 1 || ref === '1' ? -alt : alt
    }
    meta.originalGps = { lat, lon, ele }
  }
  if (typeof exif?.Model === 'string') meta.cameraModel = exif.Model
  if (typeof exif?.ExifImageWidth === 'number') meta.width = exif.ExifImageWidth
  if (typeof exif?.ExifImageHeight === 'number') meta.height = exif.ExifImageHeight
  return meta
}

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
      const file = await job.handle.getFile()
      const meta = await extractMeta(file)
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
