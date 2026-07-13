import exifr from 'exifr'
import type { PhotoMeta } from '../../domain/types'

// No `pick` filtering: it silently drops tags needed for derived values
// (e.g. GPS*Ref, without which exifr loses the coordinate's hemisphere).
const EXIFR_OPTIONS: NonNullable<Parameters<typeof exifr.parse>[1]> = {
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

function parseTzOffsetMin(offset: unknown): number | undefined {
  if (typeof offset !== 'string') return undefined
  const m = offset.match(/^([+-])(\d{2}):(\d{2})$/)
  if (!m) return undefined
  const sign = m[1] === '-' ? -1 : 1
  return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10))
}

/**
 * Extract photo metadata. Accepts a File (browsers/workers — exifr reads it
 * in chunks, important for large RAW files) or an ArrayBuffer (tests/Node,
 * where exifr cannot chunk-read File objects).
 */
export async function extractMeta(input: File | ArrayBuffer, lastModified: number): Promise<PhotoMeta> {
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
  }
  if (typeof exif?.Model === 'string') meta.cameraModel = exif.Model
  if (typeof exif?.ExifImageWidth === 'number') meta.width = exif.ExifImageWidth
  if (typeof exif?.ExifImageHeight === 'number') meta.height = exif.ExifImageHeight
  return meta
}
