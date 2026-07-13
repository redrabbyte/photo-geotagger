import { describe, it, expect } from 'vitest'
import type { Photo, Source, Track } from '../types'
import { positionAtTime } from '../positionAtTime'

const T0 = Date.parse('2026-06-01T10:00:00Z')
const MIN = 60_000

const track: Track = {
  id: 'trk1',
  name: 'walk',
  fileName: 'walk.gpx',
  color: '#f00',
  points: [
    { lat: 50, lon: 8, t: T0 },
    { lat: 50.001, lon: 8.001, t: T0 + MIN },
  ],
  segments: [{ startIdx: 0, endIdx: 1 }],
  startMs: T0,
  endMs: T0 + MIN,
}

const source: Source = {
  id: 's1',
  name: 'Cam',
  color: '#00f',
  clockOffsetMs: 0,
  assumedTzOffsetMin: 0,
}

function photoAt(t: number, lat: number): Photo {
  return {
    id: `p${t}`,
    sourceId: 's1',
    fileName: 'a.jpg',
    relativePath: 'a.jpg',
    kind: 'jpeg',
    sizeBytes: 0,
    lastModified: 0,
    meta: { captureLocalMs: t, originalGps: { lat, lon: 9 } },
    scanState: 'done',
    writeState: 'clean',
  }
}

describe('positionAtTime', () => {
  it('returns nearest coordinate in time across tracks and photos', () => {
    // Photo 10s after T0 is closer than either trackpoint at T0+30s.
    const photo = photoAt(T0 + 20_000, 60)
    const pos = positionAtTime([track], [photo], { s1: source }, T0 + 30_000)
    expect(pos?.lat).toBe(60)
  })

  it('prefers trackpoint when photo is farther', () => {
    const photo = photoAt(T0 + 50 * MIN, 60)
    const pos = positionAtTime([track], [photo], { s1: source }, T0 + 10_000)
    expect(pos?.lat).toBe(50)
  })

  it('on an exact time tie the track wins over the photo', () => {
    const photo = photoAt(T0, 60) // same |Δt| = 0 as trackpoint at T0
    const pos = positionAtTime([track], [photo], { s1: source }, T0)
    expect(pos?.lat).toBe(50)
  })

  it('returns undefined with no positioned data', () => {
    expect(positionAtTime([], [], {}, T0)).toBeUndefined()
  })
})
