import { describe, it, expect } from 'vitest'
import type { Photo, Source, Track } from '../types'
import { effectiveUtcMs, gpsStatus } from '../types'
import { findNeighbors } from '../trackIndex'
import {
  matchToTracks,
  matchByInherit,
  buildInheritReferences,
  isStale,
  DEFAULT_MATCH_SETTINGS,
} from '../matching'
import { projectOntoTrack } from '../projectOntoTrack'

const T0 = Date.parse('2026-06-01T10:00:00Z')
const MIN = 60_000

function makeTrack(overrides: Partial<Track> = {}): Track {
  // 11 points, one per minute, walking north-east.
  const points = Array.from({ length: 11 }, (_, i) => ({
    lat: 50 + i * 0.001,
    lon: 8 + i * 0.001,
    ele: 100 + i,
    t: T0 + i * MIN,
  }))
  return {
    id: 'trk1',
    name: 'walk',
    fileName: 'walk.gpx',
    color: '#f00',
    points,
    segments: [{ startIdx: 0, endIdx: 10 }],
    startMs: points[0].t,
    endMs: points[10].t,
    ...overrides,
  }
}

function makeSource(overrides: Partial<Source> = {}): Source {
  return { id: 's1', name: 'Camera', color: '#00f', clockOffsetMs: 0, assumedTzOffsetMin: 0, ...overrides }
}

function makePhoto(captureUtc: number, overrides: Partial<Photo> = {}): Photo {
  return {
    id: `s1:p${captureUtc}`,
    sourceId: 's1',
    fileName: 'a.jpg',
    relativePath: 'a.jpg',
    kind: 'jpeg',
    sizeBytes: 1,
    lastModified: 0,
    meta: { captureLocalMs: captureUtc },
    scanState: 'done',
    writeState: 'clean',
    ...overrides,
  }
}

describe('effectiveUtcMs', () => {
  it('applies EXIF tz offset when present', () => {
    const src = makeSource({ assumedTzOffsetMin: 0 })
    const p = makePhoto(T0)
    p.meta!.tzOffsetMin = 120 // capture time is UTC+2 wall clock
    expect(effectiveUtcMs(p, src)).toBe(T0 - 120 * MIN)
  })

  it('falls back to source assumed tz and applies clock offset', () => {
    const src = makeSource({ assumedTzOffsetMin: 60, clockOffsetMs: 5000 })
    const p = makePhoto(T0)
    expect(effectiveUtcMs(p, src)).toBe(T0 - 60 * MIN + 5000)
  })
})

describe('findNeighbors', () => {
  const track = makeTrack()

  it('exact hit returns the point as before-neighbor with delta 0', () => {
    const pair = findNeighbors([track], T0 + 3 * MIN)
    expect(pair.before?.index).toBe(3)
    expect(pair.before?.deltaMs).toBe(0)
    expect(pair.after?.index).toBe(4)
  })

  it('between points returns surrounding pair', () => {
    const pair = findNeighbors([track], T0 + 3.5 * MIN)
    expect(pair.before?.index).toBe(3)
    expect(pair.after?.index).toBe(4)
    expect(pair.sameSegment).toBe(true)
  })

  it('before track start has only after', () => {
    const pair = findNeighbors([track], T0 - MIN)
    expect(pair.before).toBeUndefined()
    expect(pair.after?.index).toBe(0)
  })

  it('does not pair across segment gaps', () => {
    const gapped = makeTrack({ segments: [{ startIdx: 0, endIdx: 4 }, { startIdx: 5, endIdx: 10 }] })
    const pair = findNeighbors([gapped], T0 + 4.5 * MIN)
    // Nearest points are idx4 (end of seg A) and idx5 (start of seg B) — not same segment.
    expect(pair.sameSegment).toBe(false)
  })
})

describe('matchToTracks', () => {
  const track = makeTrack()
  const src = makeSource()

  it('closest picks nearer of the two', () => {
    const r = matchToTracks(makePhoto(T0 + 3.4 * MIN), src, [track], 'closest')
    expect(r.ok && r.assignment.point.lat).toBeCloseTo(50.003, 9)
  })

  it('interpolated lerps between neighbors', () => {
    const r = matchToTracks(makePhoto(T0 + 3.5 * MIN), src, [track], 'interpolated')
    if (!r.ok) throw new Error('expected match')
    expect(r.assignment.method).toBe('interpolated')
    expect(r.assignment.point.lat).toBeCloseTo(50.0035, 9)
    expect(r.assignment.point.lon).toBeCloseTo(8.0035, 9)
    expect(r.assignment.point.ele).toBeCloseTo(103.5, 5)
  })

  it('interpolation across a too-large gap degrades to closest and flags it', () => {
    const sparse = makeTrack({
      points: [
        { lat: 50, lon: 8, t: T0 },
        { lat: 51, lon: 9, t: T0 + 20 * MIN },
      ],
      segments: [{ startIdx: 0, endIdx: 1 }],
      endMs: T0 + 20 * MIN,
    })
    const r = matchToTracks(makePhoto(T0 + 4 * MIN), src, [sparse], 'interpolated')
    if (!r.ok) throw new Error('expected degraded match')
    expect(r.assignment.method).toBe('closest')
    expect(r.assignment.degraded).toBe(true)
    expect(r.assignment.point.lat).toBe(50)
  })

  it('rejects photos far outside track coverage', () => {
    const r = matchToTracks(makePhoto(T0 + 60 * MIN), src, [track], 'closest')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('no-match')
  })

  it('clock offset shifts the match', () => {
    const offSrc = makeSource({ clockOffsetMs: -2 * MIN })
    // Photo timestamp T0+5min, camera 2min fast → true time T0+3min.
    const r = matchToTracks(makePhoto(T0 + 5 * MIN), offSrc, [track], 'closest')
    if (!r.ok) throw new Error('expected match')
    expect(r.assignment.point.lat).toBeCloseTo(50.003, 9)
  })

  it('before/after return the respective neighbors', () => {
    const rb = matchToTracks(makePhoto(T0 + 3.5 * MIN), src, [track], 'before')
    const ra = matchToTracks(makePhoto(T0 + 3.5 * MIN), src, [track], 'after')
    if (!rb.ok || !ra.ok) throw new Error('expected matches')
    expect(rb.assignment.point.lat).toBeCloseTo(50.003, 9)
    expect(ra.assignment.point.lat).toBeCloseTo(50.004, 9)
  })

  it('photo without metadata reports no-time', () => {
    const p = makePhoto(T0)
    p.meta = undefined
    const r = matchToTracks(p, src, [track], 'closest')
    expect(!r.ok && r.reason).toBe('no-time')
  })
})

describe('inherit', () => {
  const src = makeSource()
  const sources = new Map([[src.id, src]])

  it('interpolates between geotagged neighbors', () => {
    const phone1 = makePhoto(T0, { id: 'ph1', meta: { captureLocalMs: T0, originalGps: { lat: 50, lon: 8 } } })
    const phone2 = makePhoto(T0 + 2 * MIN, {
      id: 'ph2',
      meta: { captureLocalMs: T0 + 2 * MIN, originalGps: { lat: 50.002, lon: 8.002 } },
    })
    const cam = makePhoto(T0 + MIN, { id: 'cam1' })
    const refs = buildInheritReferences([phone1, phone2, cam], sources, new Set(['cam1']))
    const r = matchByInherit(cam, src, refs)
    if (!r.ok) throw new Error('expected inherit match')
    expect(r.assignment.point.lat).toBeCloseTo(50.001, 9)
    expect(r.assignment.method).toBe('inherit')
  })

  it('copies nearest when only one side exists', () => {
    const phone = makePhoto(T0, { id: 'ph1', meta: { captureLocalMs: T0, originalGps: { lat: 50, lon: 8 } } })
    const cam = makePhoto(T0 + MIN, { id: 'cam1' })
    const refs = buildInheritReferences([phone, cam], sources, new Set(['cam1']))
    const r = matchByInherit(cam, src, refs)
    if (!r.ok) throw new Error('expected inherit match')
    expect(r.assignment.point).toMatchObject({ lat: 50, lon: 8 })
    expect(r.assignment.inheritedFrom).toBe('ph1')
  })

  it('fails when neighbors exceed the inherit gap', () => {
    const phone = makePhoto(T0, { id: 'ph1', meta: { captureLocalMs: T0, originalGps: { lat: 50, lon: 8 } } })
    const cam = makePhoto(T0 + 11 * MIN, { id: 'cam1' })
    const refs = buildInheritReferences([phone, cam], sources, new Set(['cam1']))
    expect(matchByInherit(cam, src, refs, DEFAULT_MATCH_SETTINGS).ok).toBe(false)
  })
})

describe('staleness and status', () => {
  it('track assignment goes stale when offset changes; manual does not', () => {
    const track = makeTrack()
    const src = makeSource()
    const p = makePhoto(T0 + 3 * MIN)
    const r = matchToTracks(p, src, [track], 'closest')
    if (!r.ok) throw new Error('expected match')
    p.assignment = r.assignment
    expect(isStale(p, src)).toBe(false)
    const shifted = { ...src, clockOffsetMs: 30_000 }
    expect(isStale(p, shifted)).toBe(true)
    p.assignment = { ...p.assignment, method: 'manual' }
    expect(isStale(p, shifted)).toBe(false)
  })

  it('gpsStatus reflects assignment kind', () => {
    const p = makePhoto(T0)
    expect(gpsStatus(p)).toBe('none')
    p.meta!.originalGps = { lat: 1, lon: 2 }
    expect(gpsStatus(p)).toBe('original')
    p.assignment = { method: 'closest', point: { lat: 1, lon: 2 }, effectiveUtcMs: T0 }
    expect(gpsStatus(p)).toBe('assigned')
    p.assignment = { method: 'manual', point: { lat: 1, lon: 2 }, effectiveUtcMs: T0 }
    expect(gpsStatus(p)).toBe('manual')
  })
})

describe('projectOntoTrack', () => {
  it('projects onto the nearest segment and interpolates time', () => {
    const track = makeTrack()
    // A point slightly off the midpoint of segment 3→4.
    const proj = projectOntoTrack(track, { lat: 50.00355, lon: 8.00345 })
    expect(proj).toBeDefined()
    expect(proj!.point.lat).toBeCloseTo(50.0035, 4)
    expect(proj!.t).toBeGreaterThan(T0 + 3 * MIN)
    expect(proj!.t).toBeLessThan(T0 + 4 * MIN)
  })
})
