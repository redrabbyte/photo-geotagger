import { describe, it, expect } from 'vitest'
import { extractMeta } from '../exif/readMeta'
import { insertGpsIntoJpeg } from '../exif/writeJpeg'
import { makeJpegWithExif } from './fixtures'

function asBuffer(bytes: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
const MTIME = 1700000000000

describe('extractMeta', () => {
  it('reads capture time as wall-clock ms', async () => {
    const meta = await extractMeta(asBuffer(makeJpegWithExif('2026:06:01 12:34:56')), MTIME)
    expect(meta.timeSource).toBe('exif')
    expect(meta.captureLocalMs).toBe(Date.parse('2026-06-01T12:34:56Z'))
    expect(meta.originalGps).toBeUndefined()
  })

  it('reads existing GPS with correct sign in all hemispheres', async () => {
    // Regression: a tag pick-list once dropped GPS*Ref, losing the hemisphere.
    for (const gps of [
      { lat: 48.858093, lon: 2.294694 }, // N/E
      { lat: -33.856784, lon: 151.215297 }, // S/E
      { lat: 37.7749, lon: -122.4194 }, // N/W
      { lat: -22.9519, lon: -43.2105 }, // S/W
    ]) {
      const jpeg = insertGpsIntoJpeg(makeJpegWithExif('2026:06:01 12:34:56'), gps)
      const meta = await extractMeta(asBuffer(jpeg), MTIME)
      expect(meta.originalGps, JSON.stringify(gps)).toBeDefined()
      expect(meta.originalGps!.lat).toBeCloseTo(gps.lat, 4)
      expect(meta.originalGps!.lon).toBeCloseTo(gps.lon, 4)
    }
  })

  it('reads altitude with below-sea-level ref', async () => {
    const jpeg = insertGpsIntoJpeg(makeJpegWithExif('2026:06:01 12:34:56'), { lat: 31.5, lon: 35.47, ele: -430 })
    const meta = await extractMeta(asBuffer(jpeg), MTIME)
    expect(meta.originalGps!.ele).toBeCloseTo(-430, 0)
  })

  it('falls back to file mtime without EXIF time', async () => {
    const meta = await extractMeta(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer as ArrayBuffer, MTIME)
    expect(meta.timeSource).toBe('file')
    expect(meta.captureLocalMs).toBe(MTIME)
    expect(meta.tzOffsetMin).toBe(0)
  })
})
