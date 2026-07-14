// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import type { Photo, Source } from '../../domain/types'
import { effectiveUtcMs } from '../../domain/types'
import { timeCorrectionFor } from '../writePipeline'
import { generateXmpSidecar, mergeGpsIntoXmp, xmpDateTime } from '../../domain/xmp'

const T0 = Date.parse('2026-06-01T10:00:00Z')
const HOUR = 3600_000

function makeSource(overrides: Partial<Source> = {}): Source {
  return { id: 's1', name: 'Cam', color: '#00f', clockOffsetMs: 0, assumedTzOffsetMin: 120, ...overrides }
}

function makePhoto(overrides: Partial<Photo['meta']> = {}): Photo {
  return {
    id: 'p1',
    sourceId: 's1',
    fileName: 'a.jpg',
    relativePath: 'a.jpg',
    kind: 'jpeg',
    sizeBytes: 1,
    lastModified: 0,
    meta: { captureLocalMs: T0, timeSource: 'exif', ...overrides },
    scanState: 'done',
    writeState: 'dirty',
  }
}

describe('timeCorrectionFor', () => {
  it('shifts the wall clock by the source offset and uses the assumed tz', () => {
    const c = timeCorrectionFor(makePhoto(), makeSource({ clockOffsetMs: HOUR }))
    expect(c).toEqual({ wallClockMs: T0 + HOUR, tzOffsetMin: 120 })
  })

  it('keeps an existing EXIF timezone', () => {
    const c = timeCorrectionFor(makePhoto({ tzOffsetMin: -300 }), makeSource({ clockOffsetMs: HOUR }))
    expect(c).toEqual({ wallClockMs: T0 + HOUR, tzOffsetMin: -300 })
  })

  it('corrects a missing timezone even without a clock offset', () => {
    const c = timeCorrectionFor(makePhoto(), makeSource())
    expect(c).toEqual({ wallClockMs: T0, tzOffsetMin: 120 })
  })

  it('returns undefined when nothing needs correcting or already corrected', () => {
    expect(timeCorrectionFor(makePhoto({ tzOffsetMin: 120 }), makeSource())).toBeUndefined()
    expect(
      timeCorrectionFor(makePhoto({ timeCorrected: true }), makeSource({ clockOffsetMs: HOUR }))
    ).toBeUndefined()
    expect(
      timeCorrectionFor(makePhoto({ timeSource: 'file' }), makeSource({ clockOffsetMs: HOUR }))
    ).toBeUndefined()
  })
})

describe('effectiveUtcMs with timeCorrected', () => {
  it('stops applying the source offset once the file is corrected', () => {
    const src = makeSource({ clockOffsetMs: HOUR })
    const before = effectiveUtcMs(makePhoto(), src)
    // After writing: wall clock moved forward, flag set.
    const after = effectiveUtcMs(
      makePhoto({ captureLocalMs: T0 + HOUR, tzOffsetMin: 120, timeCorrected: true }),
      src
    )
    expect(after).toBe(before)
  })
})

describe('XMP sidecar time', () => {
  it('formats ISO datetime with offset', () => {
    expect(xmpDateTime(Date.parse('2026-06-01T12:34:56Z'), 120)).toBe('2026-06-01T12:34:56+02:00')
    expect(xmpDateTime(Date.parse('2026-06-01T12:34:56Z'), -330)).toBe('2026-06-01T12:34:56-05:30')
  })

  it('generate and merge include exif:DateTimeOriginal', () => {
    const time = { wallClockMs: Date.parse('2026-06-01T13:34:56Z'), tzOffsetMin: 120 }
    const gps = { lat: 48.858, lon: 2.294 }
    expect(generateXmpSidecar(gps, new Date(0), time)).toContain('2026-06-01T13:34:56+02:00')
    const existing = generateXmpSidecar(gps, new Date(0))
    const merged = mergeGpsIntoXmp(existing, gps, undefined, time)
    expect(merged).toContain('2026-06-01T13:34:56+02:00')
  })
})
