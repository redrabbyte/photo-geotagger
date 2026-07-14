// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import {
  insertAutoPoint,
  stretchDraftTimes,
  setDraftPointTime,
  moveDraftPoint,
  deleteDraftPoint,
  validateDraftTimes,
  generateGpx,
  draftFromTrack,
  trackFromDraft,
  type DraftPoint,
} from '../trackDraft'
import { parseGpx } from '../parseGpx'

const T0 = Date.parse('2026-06-01T10:00:00Z')
const HOUR = 3600_000

const start: DraftPoint = { lat: 50, lon: 8, t: T0, manual: true }
const end: DraftPoint = { lat: 50, lon: 8.02, t: T0 + HOUR, manual: true } // due east

describe('insertAutoPoint + distance interpolation', () => {
  it('interpolates time by distance along the line', () => {
    // Insert at 25% of the way (longitude 8.005 on a straight east-west line).
    const pts = insertAutoPoint([start, end], 0, { lat: 50, lon: 8.005 })
    expect(pts).toHaveLength(3)
    expect(pts[1].manual).toBe(false)
    const f = (pts[1].t - T0) / HOUR
    expect(f).toBeCloseTo(0.25, 2)
  })

  it('several autos share the span proportionally', () => {
    let pts = insertAutoPoint([start, end], 0, { lat: 50, lon: 8.01 }) // midpoint
    pts = insertAutoPoint(pts, 0, { lat: 50, lon: 8.005 }) // quarter
    expect((pts[1].t - T0) / HOUR).toBeCloseTo(0.25, 2)
    expect((pts[2].t - T0) / HOUR).toBeCloseTo(0.5, 2)
  })
})

describe('manual time anchoring', () => {
  it('editing a time re-interpolates autos on both sides', () => {
    let pts = insertAutoPoint([start, end], 0, { lat: 50, lon: 8.005 })
    pts = insertAutoPoint(pts, 1, { lat: 50, lon: 8.01 })
    pts = insertAutoPoint(pts, 2, { lat: 50, lon: 8.015 })
    // Make the geometric midpoint a manual anchor at 45 minutes.
    pts = setDraftPointTime(pts, 2, T0 + 45 * 60_000)
    expect(pts[2].manual).toBe(true)
    // Auto at 8.005 is halfway (by distance) to the anchor → 22.5 min.
    expect((pts[1].t - T0) / 60_000).toBeCloseTo(22.5, 1)
    // Auto at 8.015 is halfway between anchor (45min) and end (60min) → 52.5 min.
    expect((pts[3].t - T0) / 60_000).toBeCloseTo(52.5, 1)
  })

  it('moving a point shifts auto times by the new distances', () => {
    let pts = insertAutoPoint([start, end], 0, { lat: 50, lon: 8.01 }) // mid → 30min
    expect((pts[1].t - T0) / 60_000).toBeCloseTo(30, 1)
    pts = moveDraftPoint(pts, 1, { lat: 50, lon: 8.005 }) // now at 25%
    expect((pts[1].t - T0) / 60_000).toBeCloseTo(15, 1)
  })

  it('deleting keeps endpoints and re-interpolates', () => {
    let pts = insertAutoPoint([start, end], 0, { lat: 50, lon: 8.01 })
    pts = deleteDraftPoint(pts, 1)
    expect(pts).toHaveLength(2)
    expect(deleteDraftPoint(pts, 0)).toHaveLength(2) // endpoint delete is a no-op
  })
})

describe('stretchDraftTimes', () => {
  const M = 60_000
  // Five points: 0, 10, 20 (pause until 40), 40, 60 minutes.
  const pts: DraftPoint[] = [
    { lat: 50, lon: 8.0, t: T0, manual: true },
    { lat: 50, lon: 8.005, t: T0 + 10 * M, manual: true },
    { lat: 50, lon: 8.01, t: T0 + 20 * M, manual: true },
    { lat: 50, lon: 8.01, t: T0 + 40 * M, manual: true },
    { lat: 50, lon: 8.02, t: T0 + 60 * M, manual: true },
  ]
  it('scales intermediate times proportionally, preserving pauses', () => {
    // Stretch point 3 (40min) to 80min, anchored at start: factor 2.
    const out = stretchDraftTimes(pts, 0, 3, T0 + 80 * M)
    expect((out[1].t - T0) / M).toBeCloseTo(20, 5)
    expect((out[2].t - T0) / M).toBeCloseTo(40, 5)
    expect((out[3].t - T0) / M).toBeCloseTo(80, 5)
    // The 20-minute pause between idx2 and idx3 became 40 minutes: profile kept.
    expect((out[3].t - out[2].t) / M).toBeCloseTo(40, 5)
    // Point beyond the stretched end shifts by the delta (+40min).
    expect((out[4].t - T0) / M).toBeCloseTo(100, 5)
    // Anchor fixed.
    expect(out[0].t).toBe(T0)
  })

  it('compresses when the new time is earlier', () => {
    const out = stretchDraftTimes(pts, 0, 4, T0 + 30 * M)
    expect((out[2].t - T0) / M).toBeCloseTo(10, 5)
    expect((out[4].t - T0) / M).toBeCloseTo(30, 5)
  })

  it('anchoring at the end stretches leftwards; earlier points shift', () => {
    // Move point 1 (10min) to -10min, anchor = last point (60min).
    const out = stretchDraftTimes(pts, 4, 1, T0 - 10 * M)
    expect((out[1].t - T0) / M).toBeCloseTo(-10, 5)
    // Point 0 lies beyond the moved end (away from anchor): shifted by -20min.
    expect((out[0].t - T0) / M).toBeCloseTo(-20, 5)
    // Anchor fixed; intermediate scaled: idx2 was 40min before anchor → now 56min span * (70/50)...
    expect(out[4].t).toBe(T0 + 60 * M)
  })

  it('refuses direction flips and degenerate spans', () => {
    expect(stretchDraftTimes(pts, 0, 3, T0 - 5 * M)).toBe(pts)
    expect(stretchDraftTimes(pts, 2, 2, T0)).toBe(pts)
  })
})

describe('validation and round-trips', () => {
  it('rejects non-monotonic manual times', () => {
    const pts = setDraftPointTime(
      insertAutoPoint([start, end], 0, { lat: 50, lon: 8.01 }),
      1,
      T0 - HOUR
    )
    expect(validateDraftTimes(pts)).toMatch(/earlier/)
    expect(validateDraftTimes([start, end])).toBeUndefined()
  })

  it('generateGpx output parses back via parseGpx', () => {
    const pts = insertAutoPoint([start, end], 0, { lat: 50, lon: 8.005 })
    const xml = generateGpx('My <manual> track', pts)
    const tracks = parseGpx(xml, 'manual.gpx', (n) => `t${n}`)
    expect(tracks).toHaveLength(1)
    expect(tracks[0].name).toBe('My <manual> track')
    expect(tracks[0].points).toHaveLength(3)
    expect(tracks[0].points[0].t).toBe(T0)
    expect(tracks[0].points[2].t).toBe(T0 + HOUR)
  })

  it('draftFromTrack/trackFromDraft round-trip', () => {
    const track = trackFromDraft({ name: 'x', points: [start, end] }, 'trk9', '#123')
    const draft = draftFromTrack(track)
    expect(draft.trackId).toBe('trk9')
    expect(draft.points.every((p) => p.manual)).toBe(true)
    expect(draft.points[1].t).toBe(end.t)
  })
})
