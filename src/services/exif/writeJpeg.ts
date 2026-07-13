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

/**
 * Insert GPS coordinates into a JPEG's EXIF, preserving all other metadata
 * and the image data (no recompression). Returns the new file bytes.
 */
export function insertGpsIntoJpeg(jpegBytes: ArrayBuffer, gps: GeoPoint, capturedUtc?: number): Uint8Array {
  const dataStr = bufferToBinaryString(jpegBytes)
  const exifObj = piexif.load(dataStr)

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
  const parsed = await exifr.parse(buf, { gps: true, exif: true, pick: ['DateTimeOriginal', 'latitude', 'longitude'] })
  const lat = parsed?.latitude
  const lon = parsed?.longitude
  if (typeof lat !== 'number' || typeof lon !== 'number') {
    throw new Error('GPS did not round-trip in rewritten JPEG')
  }
  if (Math.abs(lat - input.gps.lat) > 1e-4 || Math.abs(lon - input.gps.lon) > 1e-4) {
    throw new Error('GPS in rewritten JPEG does not match the assigned position')
  }
  const origDto = input.originalDateTimeOriginal
  if (origDto instanceof Date && parsed?.DateTimeOriginal instanceof Date) {
    if (origDto.getTime() !== parsed.DateTimeOriginal.getTime()) {
      throw new Error('DateTimeOriginal changed during rewrite — refusing to overwrite')
    }
  }
}
