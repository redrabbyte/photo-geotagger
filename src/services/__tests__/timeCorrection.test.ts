// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import type { Photo, Source } from '../../domain/types'
import { effectiveUtcMs } from '../../domain/types'
import { timeCorrectionFor } from '../writePipeline'
import { generateXmpSidecar, mergeGpsIntoXmp, xmpDateTime } from '../../domain/xmp'

const T0 = Date.parse('2026-06-01T10:00:00Z')
const HOUR = 3600_000

function makeSource(overrides: Partial<Source> = {}): Source {
  return { id: 's1', name: 'Cam', color: '#00f', clockOffsetMs: 0, ...overrides }
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
  it('shifts the wall clock by the source clock offset', () => {
    const c = timeCorrectionFor(makePhoto({ tzOffsetMin: 0 }), makeSource({ clockOffsetMs: HOUR }))
    expect(c).toEqual({ wallClockMs: T0 + HOUR, tzOffsetMin: 0 })
  })

  it('writes no timezone when neither the file nor the source states one', () => {
    // Inventing a zone would silently move the instant for the next reader.
    const c = timeCorrectionFor(makePhoto(), makeSource({ clockOffsetMs: HOUR }))
    expect(c).toEqual({ wallClockMs: T0 + HOUR, tzOffsetMin: undefined })
  })

  it('keeps an existing EXIF timezone', () => {
    const c = timeCorrectionFor(makePhoto({ tzOffsetMin: -300 }), makeSource({ clockOffsetMs: HOUR }))
    expect(c).toEqual({ wallClockMs: T0 + HOUR, tzOffsetMin: -300 })
  })

  it('a source timezone is offered as a rewrite, and keeps the instant', () => {
    // The whole point of the setting: same moment, re-labelled — so the wall
    // clock in the file moves by exactly the offset.
    const photo = makePhoto({ tzOffsetMin: 0 })
    const source = makeSource({ tzOffsetMin: 120 })
    const c = timeCorrectionFor(photo, source)!
    expect(c).toEqual({ wallClockMs: T0 + 2 * HOUR, tzOffsetMin: 120 })
    expect(c.wallClockMs - c.tzOffsetMin! * 60_000).toBe(effectiveUtcMs(photo, source))
  })

  it('re-labels a file that states no zone of its own', () => {
    const c = timeCorrectionFor(makePhoto(), makeSource({ tzOffsetMin: -480 }))
    expect(c).toEqual({ wallClockMs: T0 - 8 * HOUR, tzOffsetMin: -480 })
  })

  it('returns undefined when the file already reads exactly right', () => {
    // No clock offset, no source label: nothing to do, whatever the file states.
    expect(timeCorrectionFor(makePhoto({ tzOffsetMin: 120 }), makeSource())).toBeUndefined()
    expect(timeCorrectionFor(makePhoto(), makeSource())).toBeUndefined()
    // ...and when the source label matches what is already stored.
    expect(timeCorrectionFor(makePhoto({ tzOffsetMin: 120 }), makeSource({ tzOffsetMin: 120 }))).toBeUndefined()
    // A file-mtime date is not a capture time to correct.
    expect(
      timeCorrectionFor(makePhoto({ timeSource: 'file' }), makeSource({ clockOffsetMs: HOUR }))
    ).toBeUndefined()
  })

  it('is idempotent: a written file is not offered again', () => {
    const source = makeSource({ clockOffsetMs: HOUR, tzOffsetMin: 120 })
    const before = makePhoto({ tzOffsetMin: 0 })
    const written = timeCorrectionFor(before, source)!
    // Exactly what the store records after a successful write.
    const after = makePhoto({
      captureLocalMs: written.wallClockMs,
      tzOffsetMin: written.tzOffsetMin,
      timeCorrected: true,
    })
    expect(timeCorrectionFor(after, source)).toBeUndefined()
    // And the instant survived the round trip.
    expect(effectiveUtcMs(after, source)).toBe(effectiveUtcMs(before, source))
  })

  it('returns undefined when the correction already lives in a sidecar', () => {
    const p = { ...makePhoto(), sidecarTime: { wallClockMs: T0 + HOUR, tzOffsetMin: 120 } }
    expect(timeCorrectionFor(p, makeSource({ clockOffsetMs: HOUR }))).toBeUndefined()
  })
})

describe('effectiveUtcMs with timeCorrected', () => {
  it('stops applying the source offset once the file is corrected', () => {
    const src = makeSource({ clockOffsetMs: HOUR })
    const before = effectiveUtcMs(makePhoto({ tzOffsetMin: 120 }), src)
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

  it('omits the offset when no timezone is known', () => {
    expect(xmpDateTime(Date.parse('2026-06-01T12:34:56Z'))).toBe('2026-06-01T12:34:56')
    const time = { wallClockMs: Date.parse('2026-06-01T13:34:56Z') }
    expect(generateXmpSidecar(undefined, new Date(0), time)).toContain('"2026-06-01T13:34:56"')
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
