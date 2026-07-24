// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useStore } from '../store'
import type { Photo, Source, Track } from '../../domain/types'

const T0 = Date.parse('2026-06-01T10:00:00Z')
const MIN = 60_000

function makeSource(overrides: Partial<Source> = {}): Source {
  return { id: 's1', name: 'Cam', color: '#00f', clockOffsetMs: 0, assumedTzOffsetMin: 0, ...overrides }
}

function makePhoto(id: string, t: number | undefined, overrides: Partial<Photo> = {}): Photo {
  return {
    id,
    sourceId: 's1',
    fileName: `${id}.jpg`,
    relativePath: `${id}.jpg`,
    kind: 'jpeg',
    sizeBytes: 1,
    lastModified: 0,
    meta: t !== undefined ? { captureLocalMs: t } : undefined,
    scanState: 'done',
    writeState: 'clean',
    ...overrides,
  }
}

function makeTrack(overrides: Partial<Track> = {}): Track {
  const points = [
    { lat: 50, lon: 8, t: T0 },
    { lat: 50.01, lon: 8.01, t: T0 + 10 * MIN },
  ]
  return {
    id: 'trk1',
    name: 'walk',
    fileName: 'walk.gpx',
    color: '#f00',
    points,
    segments: [{ startIdx: 0, endIdx: 1 }],
    startMs: T0,
    endMs: T0 + 10 * MIN,
    ...overrides,
  }
}

function seed(photos: Photo[], tracks: Track[] = []) {
  useStore.setState({
    sources: { s1: makeSource() },
    photos: Object.fromEntries(photos.map((p) => [p.id, p])),
    tracks: Object.fromEntries(tracks.map((t) => [t.id, t])),
    selectedIds: new Set<string>(),
    activePhotoId: undefined,
    calibrate: undefined,
    placement: undefined,
  })
}

beforeEach(() => {
  seed([])
  vi.restoreAllMocks()
})

describe('assignSelected', () => {
  it('counts assigned / no-time / no-match in the summary', () => {
    seed(
      [
        makePhoto('inTrack', T0 + 5 * MIN),
        makePhoto('noTime', undefined),
      ],
      [makeTrack()]
    )
    const s = useStore.getState()
    s.setSelection(['inTrack', 'noTime'])
    const summary = useStore.getState().assignSelected('closest')
    expect(summary).toMatchObject({ assigned: 1, noTime: 1, noMatch: 0 })
    expect(useStore.getState().photos.inTrack.assignment?.method).toBe('closest')
    expect(useStore.getState().photos.inTrack.writeState).toBe('dirty')
  })

  it('excludes selected photos from the reference set', () => {
    const geotagged = makePhoto('ref', T0, { meta: { captureLocalMs: T0, originalGps: { lat: 50, lon: 8 } } })
    seed([geotagged, makePhoto('target', T0 + MIN)])
    // Both selected: the geotagged one may not serve as its own reference.
    useStore.getState().setSelection(['ref', 'target'])
    expect(useStore.getState().assignSelected('closest').noMatch).toBe(2)
    // Only the target selected: the geotagged photo becomes a valid reference.
    useStore.getState().setSelection(['target'])
    const summary = useStore.getState().assignSelected('closest')
    expect(summary.assigned).toBe(1)
    expect(useStore.getState().photos.target.assignment?.inheritedFrom).toBe('ref')
  })

  it('counts degraded interpolations', () => {
    const gapped = makeTrack({ segments: [{ startIdx: 0, endIdx: 0 }, { startIdx: 1, endIdx: 1 }] })
    seed([makePhoto('p', T0 + 5 * MIN)], [gapped])
    useStore.getState().setSelection(['p'])
    const summary = useStore.getState().assignSelected('interpolated')
    expect(summary).toMatchObject({ assigned: 1, degraded: 1 })
    expect(useStore.getState().photos.p.assignment?.method).toBe('closest')
  })

  it('clears a stale writeError on re-assign (also via manual placement)', () => {
    seed([makePhoto('p', T0 + 5 * MIN, { writeState: 'write-error', writeError: 'boom' })], [makeTrack()])
    useStore.getState().setSelection(['p'])
    useStore.getState().assignSelected('closest')
    expect(useStore.getState().photos.p.writeError).toBeUndefined()

    seed([makePhoto('q', T0, { writeState: 'write-error', writeError: 'boom' })])
    useStore.getState().setManualPosition('q', { lat: 1, lon: 2 })
    const q = useStore.getState().photos.q
    expect(q.writeError).toBeUndefined()
    expect(q.writeState).toBe('dirty')
  })
})

describe('removeSource cleanup', () => {
  it('drops selection, active photo, calibration, and placement referencing the source', () => {
    seed([makePhoto('p1', T0, { thumbUrl: 'blob:thumb1' })])
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const s = useStore.getState()
    s.setSelection(['p1'])
    s.setActivePhoto('p1')
    s.startCalibrate('s1', T0, 'p1.jpg')
    s.startPlacement(['p1'])
    useStore.getState().removeSource('s1')
    const after = useStore.getState()
    expect(after.photos.p1).toBeUndefined()
    expect(after.selectedIds.size).toBe(0)
    expect(after.activePhotoId).toBeUndefined()
    expect(after.calibrate).toBeUndefined()
    expect(after.placement).toBeUndefined()
    expect(revoke).toHaveBeenCalledWith('blob:thumb1')
  })
})

describe('write state transitions', () => {
  it('markWriteResult: success updates meta and clears errors; failure records them', () => {
    const assignment = { method: 'manual' as const, point: { lat: 1, lon: 2 }, effectiveUtcMs: T0 }
    seed([makePhoto('p', T0, { assignment, writeState: 'dirty' })])
    useStore.getState().markWriting(['p'])
    expect(useStore.getState().photos.p.writeState).toBe('writing')

    useStore.getState().markWriteResult('p', true, 'exif', undefined, { wallClockMs: T0 + MIN, tzOffsetMin: 60 })
    const ok = useStore.getState().photos.p
    expect(ok.writeState).toBe('written')
    expect(ok.meta?.originalGps).toEqual({ lat: 1, lon: 2 })
    expect(ok.meta?.captureLocalMs).toBe(T0 + MIN)
    expect(ok.meta?.timeCorrected).toBe(true)

    useStore.getState().markWriteResult('p', false, undefined, 'disk full')
    expect(useStore.getState().photos.p).toMatchObject({ writeState: 'write-error', writeError: 'disk full' })
  })

  it('markWriteResult with sidecar target syncs sidecar fields, not the file meta', () => {
    const assignment = { method: 'manual' as const, point: { lat: 1, lon: 2 }, effectiveUtcMs: T0 }
    seed([makePhoto('p', T0, { assignment, writeState: 'writing' })])
    useStore.getState().markWriteResult('p', true, 'sidecar', undefined, { wallClockMs: T0 + MIN, tzOffsetMin: 60 })
    const p = useStore.getState().photos.p
    expect(p.sidecarGps).toEqual({ lat: 1, lon: 2 })
    expect(p.sidecarTime).toEqual({ wallClockMs: T0 + MIN, tzOffsetMin: 60 })
    expect(p.meta?.captureLocalMs).toBe(T0) // file itself untouched
  })

  it('markTimeWriteResult keeps a pending GPS assignment dirty', () => {
    const assignment = { method: 'manual' as const, point: { lat: 1, lon: 2 }, effectiveUtcMs: T0 }
    seed([makePhoto('p', T0, { assignment, writeState: 'writing' })])
    useStore.getState().markTimeWriteResult('p', true, undefined, { wallClockMs: T0 + MIN, tzOffsetMin: 0 }, 'exif')
    const p = useStore.getState().photos.p
    expect(p.writeState).toBe('dirty')
    expect(p.meta?.timeCorrected).toBe(true)
  })
})

describe('toggleSelected', () => {
  it('sets the active photo when adding, clears it when deselecting the active one', () => {
    seed([makePhoto('a', T0), makePhoto('b', T0 + MIN)])
    const s = useStore.getState()
    s.toggleSelected('a', false)
    expect(useStore.getState().activePhotoId).toBe('a')
    s.toggleSelected('b', true)
    expect(useStore.getState().activePhotoId).toBe('b')
    // Deselect the active photo → active cleared.
    useStore.getState().toggleSelected('b', true)
    expect(useStore.getState().selectedIds.has('b')).toBe(false)
    expect(useStore.getState().activePhotoId).toBeUndefined()
    // Deselect a non-active photo → active untouched.
    useStore.getState().setActivePhoto('x')
    useStore.getState().toggleSelected('a', true)
    expect(useStore.getState().activePhotoId).toBe('x')
  })
})

describe('thumb updates', () => {
  it('revokes the previous blob URL when a duplicate thumb lands', () => {
    seed([makePhoto('p', T0, { thumbUrl: 'blob:old' })])
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    useStore.getState().applyScanUpdates([{ id: 'p', kind: 'thumb', url: 'blob:new' }])
    expect(useStore.getState().photos.p.thumbUrl).toBe('blob:new')
    expect(revoke).toHaveBeenCalledWith('blob:old')
  })
})
