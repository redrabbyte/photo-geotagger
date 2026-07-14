import piexif from 'piexifjs'
import exifr from 'exifr'
import type { GeoPoint } from '../../domain/types'
import { degToDmsRationals } from '../../domain/gpsMath'

function bufferToBinaryString(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  const chunks: string[] = []
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]))
  }
  return chunks.join('')
}

function binaryStringToBytes(str: string): Uint8Array {
  const bytes = new Uint8Array(str.length)
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff
  return bytes
}

function toPiexifRational(r: { num: number; den: number }): [number, number] {
  return [r.num, r.den]
}

// piexifjs predates the EXIF 2.31 OffsetTime* tags — register them so
// dump() knows their type. IDs: 0x9010..0x9012.
const OFFSET_TIME = 36880
const OFFSET_TIME_ORIGINAL = 36881
const OFFSET_TIME_DIGITIZED = 36882
{
  const tags = (piexif as unknown as { TAGS: Record<string, Record<number, { name: string; type: string }>> }).TAGS
  tags['Exif'][OFFSET_TIME] = { name: 'OffsetTime', type: 'Ascii' }
  tags['Exif'][OFFSET_TIME_ORIGINAL] = { name: 'OffsetTimeOriginal', type: 'Ascii' }
  tags['Exif'][OFFSET_TIME_DIGITIZED] = { name: 'OffsetTimeDigitized', type: 'Ascii' }
}

export interface TimeCorrection {
  /** Corrected wall-clock capture time as epoch ms (interpreted as UTC fields). */
  wallClockMs: number
  /** Timezone the wall clock is in, minutes east of UTC. */
  tzOffsetMin: number
}

/** "YYYY:MM:DD HH:MM:SS" from a wall-clock-as-UTC millisecond value. */
export function formatExifDateTime(wallClockMs: number): string {
  const d = new Date(wallClockMs)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}:${p(d.getUTCMonth() + 1)}:${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}

/** "±HH:MM" for EXIF OffsetTime* tags. */
export function formatTzOffset(min: number): string {
  const sign = min < 0 ? '-' : '+'
  const abs = Math.abs(min)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
}

/**
 * Insert GPS coordinates into a JPEG's EXIF, preserving all other metadata
 * and the image data (no recompression). Optionally rewrites the capture
 * time (clock correction). Returns the new file bytes.
 */
export function insertGpsIntoJpeg(
  jpegBytes: ArrayBuffer,
  gps: GeoPoint,
  capturedUtc?: number,
  timeCorrection?: TimeCorrection
): Uint8Array {
  const dataStr = bufferToBinaryString(jpegBytes)
  const exifObj = piexif.load(dataStr)

  if (timeCorrection) {
    const exifIfd: Record<number, unknown> = exifObj['Exif'] ?? {}
    const dateTime = formatExifDateTime(timeCorrection.wallClockMs)
    const tz = formatTzOffset(timeCorrection.tzOffsetMin)
    exifIfd[piexif.ExifIFD.DateTimeOriginal] = dateTime
    exifIfd[piexif.ExifIFD.DateTimeDigitized] = dateTime
    exifIfd[OFFSET_TIME_ORIGINAL] = tz
    exifIfd[OFFSET_TIME_DIGITIZED] = tz
    exifObj['Exif'] = exifIfd
  }

  const gpsIfd: Record<number, unknown> = exifObj['GPS'] ?? {}
  gpsIfd[piexif.GPSIFD.GPSVersionID] = [2, 3, 0, 0]
  gpsIfd[piexif.GPSIFD.GPSLatitudeRef] = gps.lat >= 0 ? 'N' : 'S'
  gpsIfd[piexif.GPSIFD.GPSLatitude] = degToDmsRationals(gps.lat).map(toPiexifRational)
  gpsIfd[piexif.GPSIFD.GPSLongitudeRef] = gps.lon >= 0 ? 'E' : 'W'
  gpsIfd[piexif.GPSIFD.GPSLongitude] = degToDmsRationals(gps.lon).map(toPiexifRational)
  if (gps.ele !== undefined) {
    gpsIfd[piexif.GPSIFD.GPSAltitudeRef] = gps.ele < 0 ? 1 : 0
    gpsIfd[piexif.GPSIFD.GPSAltitude] = [Math.round(Math.abs(gps.ele) * 100), 100]
  }
  if (capturedUtc !== undefined && Number.isFinite(capturedUtc)) {
    const d = new Date(capturedUtc)
    gpsIfd[piexif.GPSIFD.GPSTimeStamp] = [
      [d.getUTCHours(), 1],
      [d.getUTCMinutes(), 1],
      [d.getUTCSeconds(), 1],
    ]
    gpsIfd[piexif.GPSIFD.GPSDateStamp] =
      `${d.getUTCFullYear()}:${String(d.getUTCMonth() + 1).padStart(2, '0')}:${String(d.getUTCDate()).padStart(2, '0')}`
  }
  exifObj['GPS'] = gpsIfd

  const exifBytes = piexif.dump(exifObj)
  const output = piexif.insert(exifBytes, dataStr)
  return binaryStringToBytes(output)
}

export interface JpegValidationInput {
  originalSize: number
  gps: GeoPoint
  originalDateTimeOriginal?: unknown
  /** When a time correction was written, the wall-clock ms it must now show. */
  expectedDateTimeMs?: number
}

/**
 * Validate rewritten JPEG bytes before they are allowed to replace the
 * original: structure intact, GPS round-trips, capture time untouched.
 */
export async function validateJpegOutput(bytes: Uint8Array, input: JpegValidationInput): Promise<void> {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error('Output is not a valid JPEG (missing SOI marker)')
  }
  if (bytes.length < input.originalSize * 0.5) {
    throw new Error('Output is implausibly small — refusing to overwrite original')
  }
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const parsed = await exifr.parse(buf, { gps: true, exif: true })
  const lat = parsed?.latitude
  const lon = parsed?.longitude
  if (typeof lat !== 'number' || typeof lon !== 'number') {
    throw new Error('GPS did not round-trip in rewritten JPEG')
  }
  if (Math.abs(lat - input.gps.lat) > 1e-4 || Math.abs(lon - input.gps.lon) > 1e-4) {
    throw new Error('GPS in rewritten JPEG does not match the assigned position')
  }
  const newDto = parsed?.DateTimeOriginal
  if (input.expectedDateTimeMs !== undefined) {
    // exifr revives the wall clock in the machine's local zone; compare fields.
    if (!(newDto instanceof Date)) {
      throw new Error('Corrected capture time missing from rewritten JPEG')
    }
    const wallClock = Date.UTC(
      newDto.getFullYear(), newDto.getMonth(), newDto.getDate(),
      newDto.getHours(), newDto.getMinutes(), newDto.getSeconds()
    )
    if (Math.abs(wallClock - input.expectedDateTimeMs) > 1000) {
      throw new Error('Corrected capture time in rewritten JPEG does not match')
    }
  } else {
    const origDto = input.originalDateTimeOriginal
    if (origDto instanceof Date && newDto instanceof Date) {
      if (origDto.getTime() !== newDto.getTime()) {
        throw new Error('DateTimeOriginal changed during rewrite — refusing to overwrite')
      }
    }
  }
}
