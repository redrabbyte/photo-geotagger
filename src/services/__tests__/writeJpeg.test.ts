import { describe, it, expect } from 'vitest'
import exifr from 'exifr'
import {
  formatExifDateTime,
  formatTzOffset,
  insertGpsIntoJpeg,
  insertTimeIntoJpeg,
  validateJpegOutput,
} from '../exif/writeJpeg'
import { makeJpegWithExif } from './fixtures'

const GPS = { lat: 48.858093, lon: 2.294694, ele: 35.5 }
const DTO = '2026:06:01 12:34:56'

describe('insertGpsIntoJpeg', () => {
  it('writes GPS that exifr reads back, preserving DateTimeOriginal', async () => {
    const jpeg = makeJpegWithExif(DTO)
    const out = insertGpsIntoJpeg(jpeg, GPS, Date.parse('2026-06-01T10:34:56Z'))

    const buf = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer
    const parsed = await exifr.parse(buf, { gps: true, exif: true })
    expect(parsed.latitude).toBeCloseTo(GPS.lat, 5)
    expect(parsed.longitude).toBeCloseTo(GPS.lon, 5)
    expect(parsed.GPSAltitude).toBeCloseTo(GPS.ele, 1)
    const dto = parsed.DateTimeOriginal as Date
    expect(dto.getFullYear()).toBe(2026)
    expect(dto.getMonth()).toBe(5)
    expect(dto.getSeconds()).toBe(56)
  })

  it('southern/western hemispheres get correct refs', async () => {
    const jpeg = makeJpegWithExif(DTO)
    const out = insertGpsIntoJpeg(jpeg, { lat: -33.856784, lon: -70.648 })
    const buf = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer
    const parsed = await exifr.parse(buf, { gps: true })
    expect(parsed.latitude).toBeCloseTo(-33.856784, 5)
    expect(parsed.longitude).toBeCloseTo(-70.648, 5)
  })

  it('validateJpegOutput accepts a good rewrite', async () => {
    const jpeg = makeJpegWithExif(DTO)
    const out = insertGpsIntoJpeg(jpeg, GPS)
    await expect(
      validateJpegOutput(out, { originalSize: jpeg.byteLength, gps: GPS })
    ).resolves.toBeUndefined()
  })

  it('validateJpegOutput rejects corrupted output', async () => {
    const jpeg = makeJpegWithExif(DTO)
    const out = insertGpsIntoJpeg(jpeg, GPS)
    const corrupted = out.slice()
    corrupted[0] = 0x00 // destroy SOI marker
    await expect(
      validateJpegOutput(corrupted, { originalSize: jpeg.byteLength, gps: GPS })
    ).rejects.toThrow(/not a valid JPEG/)
  })

  it('writes the corrected capture time + timezone when requested', async () => {
    const jpeg = makeJpegWithExif(DTO) // 12:34:56 wall clock
    const correction = {
      wallClockMs: Date.parse('2026-06-01T13:34:56Z') /* +1h camera clock fix */,
      tzOffsetMin: 120,
    }
    const out = insertGpsIntoJpeg(jpeg, GPS, undefined, correction)
    const buf = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer
    const parsed = await exifr.parse(buf, { exif: true, gps: true })
    const dto = parsed.DateTimeOriginal as Date
    expect(dto.getHours()).toBe(13)
    expect(dto.getMinutes()).toBe(34)
    expect(parsed.OffsetTimeOriginal).toBe('+02:00')
    // GPS still intact alongside the time change.
    expect(parsed.latitude).toBeCloseTo(GPS.lat, 5)

    // Validator accepts the intended change...
    await expect(
      validateJpegOutput(out, {
        originalSize: jpeg.byteLength,
        gps: GPS,
        expectedDateTimeMs: correction.wallClockMs,
      })
    ).resolves.toBeUndefined()
    // ...and rejects when the written time does not match the expectation.
    await expect(
      validateJpegOutput(out, {
        originalSize: jpeg.byteLength,
        gps: GPS,
        expectedDateTimeMs: correction.wallClockMs + 3600_000,
      })
    ).rejects.toThrow(/does not match/)
  })

  it('time-only rewrite fixes the clock without touching GPS', async () => {
    const jpeg = makeJpegWithExif(DTO)
    const correction = { wallClockMs: Date.parse('2026-06-01T13:34:56Z'), tzOffsetMin: 120 }
    const out = insertTimeIntoJpeg(jpeg, correction)
    const buf = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer
    const parsed = await exifr.parse(buf, { exif: true, gps: true })
    expect((parsed.DateTimeOriginal as Date).getHours()).toBe(13)
    expect(parsed.OffsetTimeOriginal).toBe('+02:00')
    expect(parsed.latitude).toBeUndefined()
    // Validator without gps skips GPS checks but verifies the time.
    await expect(
      validateJpegOutput(out, { originalSize: jpeg.byteLength, expectedDateTimeMs: correction.wallClockMs })
    ).resolves.toBeUndefined()
  })

  it('formats EXIF datetime and tz offsets', () => {
    expect(formatExifDateTime(Date.parse('2026-06-01T09:05:07Z'))).toBe('2026:06:01 09:05:07')
    expect(formatTzOffset(120)).toBe('+02:00')
    expect(formatTzOffset(-330)).toBe('-05:30')
    expect(formatTzOffset(0)).toBe('+00:00')
  })

  it('validateJpegOutput rejects mismatched GPS', async () => {
    const jpeg = makeJpegWithExif(DTO)
    const out = insertGpsIntoJpeg(jpeg, GPS)
    await expect(
      validateJpegOutput(out, { originalSize: jpeg.byteLength, gps: { lat: 10, lon: 10 } })
    ).rejects.toThrow(/does not match/)
  })
})
