import exifr from 'exifr'
import type { PhotoMeta } from '../../domain/types'
import { normalizeOrientation } from './orient'
import { parseTzOffsetMin, readVideoMetadata } from './videoMeta'

// No `pick` filtering: it silently drops tags needed for derived values
// (e.g. GPS*Ref, without which exifr loses the coordinate's hemisphere).
export const EXIFR_OPTIONS: NonNullable<Parameters<typeof exifr.parse>[1]> = {
  tiff: true,
  exif: true,
  gps: true,
  translateValues: true,
  reviveValues: true,
}

/**
 * exifr revives EXIF datetimes as Date objects in the MACHINE's local zone.
 * Convert back to wall-clock-as-UTC milliseconds so timezone handling stays
 * explicit in the domain layer.
 */
function wallClockMs(d: Date): number {
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds())
}

/**
 * Extract photo metadata. Accepts a File (browsers/workers — exifr reads it
 * in chunks, important for large RAW files) or an ArrayBuffer (tests/Node,
 * where exifr cannot chunk-read File objects).
 * Videos skip exifr entirely (it cannot parse QuickTime containers, and the
 * full-buffer retry would pull a multi-GB file into memory just to fail) —
 * they fall through to the mtime fallback below.
 */
export async function extractMeta(
  input: File | ArrayBuffer,
  lastModified: number,
  kind?: string
): Promise<PhotoMeta> {
  if (kind === 'video') {
    // Sony XML metadata (CreationDateValue, with timezone) or QuickTime
    // mvhd creation_time — both read from tiny byte ranges, both beat mtime.
    // GPS comes from ©xyz / Keys ISO 6709 (what our own writer produces).
    const blob = input instanceof ArrayBuffer ? new Blob([input]) : input
    const video = await readVideoMetadata(blob)
    const meta: PhotoMeta = video.date
      ? { captureLocalMs: video.date.wallClockMs, timeSource: 'exif', tzOffsetMin: video.date.tzOffsetMin }
      : { captureLocalMs: lastModified, timeSource: 'file', tzOffsetMin: 0 }
    if (video.gps) meta.originalGps = video.gps
    return meta
  }
  let exif: Record<string, unknown> | undefined
  try {
    exif = await exifr.parse(input as Parameters<typeof exifr.parse>[0], EXIFR_OPTIONS)
  } catch {
    exif = undefined
  }
  // Chunked File reading can fail on some platforms (e.g. Android SAF-backed
  // files); when nothing usable came back, retry once with the whole buffer.
  if ((!exif || (!exif.DateTimeOriginal && exif.latitude === undefined)) && input instanceof File) {
    try {
      const full = await input.arrayBuffer()
      exif = (await exifr.parse(full, EXIFR_OPTIONS)) ?? exif
    } catch {
      // keep whatever the first attempt produced
    }
  }

  const dto = exif?.DateTimeOriginal ?? exif?.CreateDate
  const meta: PhotoMeta = dto instanceof Date
    ? { captureLocalMs: wallClockMs(dto), timeSource: 'exif' }
    : { captureLocalMs: lastModified, timeSource: 'file', tzOffsetMin: 0 }

  if (meta.timeSource === 'exif') {
    meta.tzOffsetMin = parseTzOffsetMin(exif?.OffsetTimeOriginal ?? exif?.OffsetTime)
  }

  const lat = exif?.latitude
  const lon = exif?.longitude
  if (typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon)) {
    let ele: number | undefined
    const alt = exif?.GPSAltitude
    if (typeof alt === 'number' && Number.isFinite(alt)) {
      // The ref arrives as 1, '1', or a byte array like Uint8Array [1].
      const refRaw = exif?.GPSAltitudeRef
      const ref = typeof refRaw === 'object' && refRaw !== null ? (refRaw as Record<number, unknown>)[0] : refRaw
      ele = ref === 1 || ref === '1' ? -alt : alt
    }
    meta.originalGps = { lat, lon, ele }
  } else if (exif && Object.keys(exif).some((k) => k.startsWith('GPS'))) {
    meta.gpsEmpty = true
  }
  meta.orientation = normalizeOrientation(exif?.Orientation)
  if (typeof exif?.Model === 'string') meta.cameraModel = exif.Model
  if (typeof exif?.ExifImageWidth === 'number') meta.width = exif.ExifImageWidth
  if (typeof exif?.ExifImageHeight === 'number') meta.height = exif.ExifImageHeight
  return meta
}
