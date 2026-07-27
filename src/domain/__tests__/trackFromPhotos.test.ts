import { describe, it, expect } from 'vitest'
import type { Photo, Source } from '../types'
import { trackFromPhotos } from '../trackFromPhotos'

const T0 = Date.parse('2026-06-01T10:00:00Z')
const MIN = 60_000

const SOURCES: Record<string, Source> = {
  s1: { id: 's1', name: 'Cam', color: '#00f', clockOffsetMs: 0 },
}

function makePhoto(
  captureUtc: number,
  gps: { lat: number; lon: number; ele?: number } | undefined,
  overrides: Partial<Photo> = {}
): Photo {
  return {
    id: `p${captureUtc}${Math.abs(gps?.lat ?? 0)}`,
    sourceId: 's1',
    fileName: 'a.jpg',
    relativePath: 'a.jpg',
    kind: 'jpeg',
    sizeBytes: 1,
    lastModified: 0,
    meta: { captureLocalMs: captureUtc, originalGps: gps },
    scanState: 'done',
    writeState: 'clean',
    ...overrides,
  }
}

describe('trackFromPhotos', () => {
  it('builds a time-sorted track and skips photos without GPS', () => {
    const photos = [
      makePhoto(T0 + 5 * MIN, { lat: 50.002, lon: 8.002 }),
      makePhoto(T0, { lat: 50, lon: 8, ele: 120 }),
      makePhoto(T0 + 2 * MIN, undefined), // no GPS — skipped
      makePhoto(T0 + 3 * MIN, { lat: 50.001, lon: 8.001 }),
    ]
    const result = trackFromPhotos(photos, SOURCES, 't1')
    expect(typeof result).not.toBe('string')
    if (typeof result === 'string') return
    expect(result.used).toBe(3)
    expect(result.skipped).toBe(1)
    expect(result.track.points.map((p) => p.t)).toEqual([T0, T0 + 3 * MIN, T0 + 5 * MIN])
    expect(result.track.points[0].ele).toBe(120)
    expect(result.track.segments).toEqual([{ startIdx: 0, endIdx: 2 }])
    expect(result.track.startMs).toBe(T0)
    expect(result.track.endMs).toBe(T0 + 5 * MIN)
    expect(result.track.name).toBe('Photos 2026-06-01')
    expect(result.track.fileName.endsWith('.gpx')).toBe(true)
  })

  it('uses assigned/manual positions over embedded GPS', () => {
    const photos = [
      makePhoto(T0, { lat: 1, lon: 1 }, {
        assignment: { method: 'manual', point: { lat: 50, lon: 8 }, effectiveUtcMs: T0 },
      }),
      makePhoto(T0 + MIN, { lat: 50.001, lon: 8.001 }),
    ]
    const result = trackFromPhotos(photos, SOURCES, 't1')
    if (typeof result === 'string') throw new Error(result)
    expect(result.track.points[0].lat).toBe(50)
  })

  it('collapses burst photos with identical timestamps', () => {
    const photos = [
      makePhoto(T0, { lat: 50, lon: 8 }),
      makePhoto(T0, { lat: 50.5, lon: 8.5 }),
      makePhoto(T0 + MIN, { lat: 50.001, lon: 8.001 }),
    ]
    const result = trackFromPhotos(photos, SOURCES, 't1')
    if (typeof result === 'string') throw new Error(result)
    expect(result.track.points).toHaveLength(2)
    expect(result.skipped).toBe(1)
  })

  it('errors with fewer than two usable photos', () => {
    expect(typeof trackFromPhotos([makePhoto(T0, { lat: 50, lon: 8 })], SOURCES, 't1')).toBe('string')
    expect(typeof trackFromPhotos([], SOURCES, 't1')).toBe('string')
    const noGps = [makePhoto(T0, undefined), makePhoto(T0 + MIN, undefined)]
    expect(typeof trackFromPhotos(noGps, SOURCES, 't1')).toBe('string')
  })
})
