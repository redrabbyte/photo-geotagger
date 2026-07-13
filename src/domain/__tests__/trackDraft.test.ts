// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import {
  insertAutoPoint,
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
