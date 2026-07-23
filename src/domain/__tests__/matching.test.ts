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

  it('sidecar time outranks EXIF time and ignores the clock offset', () => {
    const src = makeSource({ assumedTzOffsetMin: 60, clockOffsetMs: 5000 })
    const p = makePhoto(T0, { sidecarTime: { wallClockMs: T0 + 10 * MIN, tzOffsetMin: 120 } })
    expect(effectiveUtcMs(p, src)).toBe(T0 + 10 * MIN - 120 * MIN)
  })

  it('sidecar time without offset uses the source assumed tz', () => {
    const src = makeSource({ assumedTzOffsetMin: 60, clockOffsetMs: 5000 })
    const p = makePhoto(T0, { sidecarTime: { wallClockMs: T0 + 10 * MIN } })
    expect(effectiveUtcMs(p, src)).toBe(T0 + 10 * MIN - 60 * MIN)
  })

  it('sidecar time works even before the file itself was scanned', () => {
    const src = makeSource()
    const p = makePhoto(T0, { meta: undefined, sidecarTime: { wallClockMs: T0, tzOffsetMin: 0 } })
    expect(effectiveUtcMs(p, src)).toBe(T0)
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

  it('interpolates across arbitrarily large gaps within one segment', () => {
    const sparse = makeTrack({
      points: [
        { lat: 50, lon: 8, t: T0 },
        { lat: 51, lon: 9, t: T0 + 20 * MIN },
      ],
      segments: [{ startIdx: 0, endIdx: 1 }],
      endMs: T0 + 20 * MIN,
    })
    const r = matchToTracks(makePhoto(T0 + 4 * MIN), src, [sparse], 'interpolated')
    if (!r.ok) throw new Error('expected match')
    expect(r.assignment.method).toBe('interpolated')
    expect(r.assignment.point.lat).toBeCloseTo(50.2, 9)
    expect(r.assignment.point.lon).toBeCloseTo(8.2, 9)
  })

  it("before works between two tracks even when the later track is closer", () => {
    // Track A ends at T0+10min; Track B starts hours later but closer to the photo.
    const trackA = makeTrack()
    const trackB = makeTrack({
      id: 'trk2',
      points: [
        { lat: 60, lon: 20, t: T0 + 300 * MIN },
        { lat: 60.01, lon: 20.01, t: T0 + 310 * MIN },
      ],
      segments: [{ startIdx: 0, endIdx: 1 }],
      startMs: T0 + 300 * MIN,
      endMs: T0 + 310 * MIN,
    })
    // Photo 1 minute before Track B: 'after' is B's start (nearest), but
    // 'before' must still find Track A's end.
    const photo = makePhoto(T0 + 299 * MIN)
    const rb = matchToTracks(photo, src, [trackA, trackB], 'before')
    if (!rb.ok) throw new Error('expected before-match')
    expect(rb.assignment.point.lat).toBeCloseTo(50.01, 9)
    expect(rb.assignment.trackId).toBe('trk1')
    const ra = matchToTracks(photo, src, [trackA, trackB], 'after')
    if (!ra.ok) throw new Error('expected after-match')
    expect(ra.assignment.point.lat).toBe(60)
    // Interpolation between different tracks degrades to closest.
    const ri = matchToTracks(photo, src, [trackA, trackB], 'interpolated')
    if (!ri.ok) throw new Error('expected degraded match')
    expect(ri.assignment.method).toBe('closest')
    expect(ri.assignment.degraded).toBe(true)
    expect(ri.assignment.point.lat).toBe(60)
  })

  it('photos far outside track coverage still snap to the nearest point', () => {
    // 50 minutes after the track ends: closest/before return the last point.
    const r = matchToTracks(makePhoto(T0 + 60 * MIN), src, [track], 'closest')
    if (!r.ok) throw new Error('expected match')
    expect(r.assignment.point.lat).toBeCloseTo(50.01, 9)
    const rb = matchToTracks(makePhoto(T0 + 60 * MIN), src, [track], 'before')
    if (!rb.ok) throw new Error('expected match')
    expect(rb.assignment.point.lat).toBeCloseTo(50.01, 9)
    // ...while 'after' has no trackpoint to offer.
    const ra = matchToTracks(makePhoto(T0 + 60 * MIN), src, [track], 'after')
    expect(!ra.ok && ra.reason).toBe('no-neighbor')
    // Before the track starts, closest returns the first point.
    const re = matchToTracks(makePhoto(T0 - 60 * MIN), src, [track], 'closest')
    if (!re.ok) throw new Error('expected match')
    expect(re.assignment.point.lat).toBe(50)
    // Interpolation outside coverage degrades to closest and is flagged.
    const ri = matchToTracks(makePhoto(T0 + 60 * MIN), src, [track], 'interpolated')
    if (!ri.ok) throw new Error('expected degraded match')
    expect(ri.assignment.method).toBe('closest')
    expect(ri.assignment.degraded).toBe(true)
  })

  it('falls back to geotagged photos when no track exists at all', () => {
    const refs = [
      { photoId: 'r1', t: T0, point: { lat: 50, lon: 8 } },
      { photoId: 'r2', t: T0 + 10 * MIN, point: { lat: 50.01, lon: 8.01 } },
    ]
    const photo = makePhoto(T0 + 5 * MIN)
    const rc = matchToTracks(photo, src, [], 'closest', refs)
    if (!rc.ok) throw new Error('expected photo-ref match')
    expect(rc.assignment.point.lat).toBe(50)
    expect(rc.assignment.inheritedFrom).toBe('r1')
    expect(rc.assignment.trackId).toBeUndefined()
    const rb = matchToTracks(photo, src, [], 'before', refs)
    expect(rb.ok && rb.assignment.inheritedFrom).toBe('r1')
    const ra = matchToTracks(photo, src, [], 'after', refs)
    expect(ra.ok && ra.assignment.inheritedFrom).toBe('r2')
    const ri = matchToTracks(photo, src, [], 'interpolated', refs)
    if (!ri.ok) throw new Error('expected interpolation between photo refs')
    expect(ri.assignment.method).toBe('interpolated')
    expect(ri.assignment.point.lat).toBeCloseTo(50.005, 9)
    expect(ri.assignment.degraded).toBeUndefined()
    // Without refs the old behavior remains: no match.
    expect(matchToTracks(photo, src, [], 'closest').ok).toBe(false)
  })

  it('photo refs fill only the side no track covers; tracks win otherwise', () => {
    // Track covers T0..T0+10min; a reference photo sits after the track end.
    const refs = [
      { photoId: 'rEarly', t: T0 + 3 * MIN, point: { lat: 99, lon: 99 } },
      { photoId: 'rLate', t: T0 + 30 * MIN, point: { lat: 50.02, lon: 8.02 } },
    ]
    // Inside coverage: refs must NOT displace trackpoints, even when closer.
    const inside = matchToTracks(makePhoto(T0 + 3.4 * MIN), src, [track], 'closest', refs)
    if (!inside.ok) throw new Error('expected track match')
    expect(inside.assignment.point.lat).toBeCloseTo(50.003, 9)
    expect(inside.assignment.inheritedFrom).toBeUndefined()
    // After the track end: 'after' now uses the reference photo…
    const photo = makePhoto(T0 + 20 * MIN)
    const ra = matchToTracks(photo, src, [track], 'after', refs)
    if (!ra.ok) throw new Error('expected photo-ref after')
    expect(ra.assignment.inheritedFrom).toBe('rLate')
    expect(ra.assignment.point.lat).toBeCloseTo(50.02, 9)
    // …and interpolation mixes the track's last point with the photo ref.
    const ri = matchToTracks(photo, src, [track], 'interpolated', refs)
    if (!ri.ok) throw new Error('expected mixed interpolation')
    expect(ri.assignment.method).toBe('interpolated')
    expect(ri.assignment.point.lat).toBeCloseTo(50.015, 9)
  })

  it('outside track coverage the nearer reference wins per side', () => {
    // Track ends T0+10min; a geotagged photo at T0+18min sits much closer to
    // the target (T0+19min) than the track's end — it must win the before side.
    const refs = [{ photoId: 'near', t: T0 + 18 * MIN, point: { lat: 50.05, lon: 8.05 } }]
    const photo = makePhoto(T0 + 19 * MIN)
    const rb = matchToTracks(photo, src, [track], 'before', refs)
    if (!rb.ok) throw new Error('expected match')
    expect(rb.assignment.inheritedFrom).toBe('near')
    expect(rb.assignment.point.lat).toBeCloseTo(50.05, 9)
    const rc = matchToTracks(photo, src, [track], 'closest', refs)
    expect(rc.ok && rc.assignment.inheritedFrom).toBe('near')
  })

  it('mixes a nearer photo with the next track start between two tracks', () => {
    const trackA = makeTrack()
    const trackB = makeTrack({
      id: 'trk2',
      points: [
        { lat: 60, lon: 20, t: T0 + 300 * MIN },
        { lat: 60.01, lon: 20.01, t: T0 + 310 * MIN },
      ],
      segments: [{ startIdx: 0, endIdx: 1 }],
      startMs: T0 + 300 * MIN,
      endMs: T0 + 310 * MIN,
    })
    const refs = [{ photoId: 'mid', t: T0 + 295 * MIN, point: { lat: 59, lon: 19 } }]
    // Target between the tracks: before side is the photo (4min away, track A
    // end is hours away), after side is track B's start.
    const ri = matchToTracks(makePhoto(T0 + 299 * MIN), src, [trackA, trackB], 'interpolated', refs)
    if (!ri.ok) throw new Error('expected mixed interpolation')
    expect(ri.assignment.method).toBe('interpolated')
    // f = (299-295)/(300-295) = 0.8 between (59,19) and (60,20).
    expect(ri.assignment.point.lat).toBeCloseTo(59.8, 9)
    expect(ri.assignment.inheritedFrom).toBe('mid')
  })

  it('inside a track span reference photos never displace trackpoints', () => {
    // Photo ref 6 seconds from the target, trackpoint 24 seconds — the track
    // still wins because the target time lies within the track's span.
    const refs = [{ photoId: 'tempting', t: T0 + 3.5 * MIN + 6000, point: { lat: 1, lon: 1 } }]
    const r = matchToTracks(makePhoto(T0 + 3.5 * MIN + 12_000), src, [track], 'closest', refs)
    if (!r.ok) throw new Error('expected match')
    expect(r.assignment.inheritedFrom).toBeUndefined()
    expect(r.assignment.trackId).toBe('trk1')
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
