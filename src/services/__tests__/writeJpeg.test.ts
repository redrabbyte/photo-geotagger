import { describe, it, expect } from 'vitest'
import exifr from 'exifr'
import { insertGpsIntoJpeg, validateJpegOutput } from '../exif/writeJpeg'
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

  it('validateJpegOutput rejects mismatched GPS', async () => {
    const jpeg = makeJpegWithExif(DTO)
    const out = insertGpsIntoJpeg(jpeg, GPS)
    await expect(
      validateJpegOutput(out, { originalSize: jpeg.byteLength, gps: { lat: 10, lon: 10 } })
    ).rejects.toThrow(/does not match/)
  })
})
