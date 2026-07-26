import { create } from 'zustand'
import type {
  AssignmentMethod,
  GeoPoint,
  Photo,
  PhotoId,
  PhotoMeta,
  Source,
  SourceId,
  Track,
} from '../domain/types'
import { effectiveUtcMs, photoKindFromName } from '../domain/types'
import {
  DEFAULT_MATCH_SETTINGS,
  buildInheritReferences,
  matchByInherit,
  matchToTracks,
  manualAssignment,
  type MatchSettings,
} from '../domain/matching'
import {
  appendTrackPoints,
  deleteDraftPoint,
  insertAutoPoint,
  reverseDraftPoints,
  trimDraftPoints,
  moveDraftPoint,
  reinterpolateTimes,
  setDraftPointTime,
  stretchDraftTimes,
  trackFromDraft,
  draftFromTrack,
  validateDraftTimes,
  type DraftPoint,
  type TrackDraft,
} from '../domain/trackDraft'
import type { WriteMode } from '../services/writePipeline'
import type { ImportFilters } from '../services/fs/sources'

export const SOURCE_COLORS = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#b07aa1', '#76b7b2', '#edc948']
export const TRACK_COLORS = ['#d62728', '#9467bd', '#8c564b', '#e377c2', '#17becf', '#bcbd22']

/** Color for the next track, cycling by how many tracks exist. */
function nextTrackColor(tracks: Record<string, unknown>, extra = 0): string {
  return TRACK_COLORS[(Object.keys(tracks).length + extra) % TRACK_COLORS.length]
}

/** State patch that closes the track-draft editor. */
const DRAFT_CLEARED = {
  draft: undefined,
  draftPlacement: undefined,
  draftSelectedIndex: undefined,
  draftAnchorIndex: undefined,
} as const

export interface Notice {
  id: number
  kind: 'info' | 'success' | 'error'
  text: string
}

export interface AssignSummary {
  assigned: number
  degraded: number
  noMatch: number
  noTime: number
}

export interface AppSettings {
  writeMode: WriteMode
  backupOriginals: boolean
  /** Also write the clock-corrected capture time + timezone into files. */
  writeCorrectedTime: boolean
  /** Use two ExifTool workers for RAW/HEIC writes (faster, more memory). */
  parallelExiftool: boolean
  /** ExifTool mode: also write GPS from loaded .xmp sidecars into the raw files. */
  embedSidecarGps: boolean
  /** Experimental: write MP4/MOV metadata directly in JS (fallback: ExifTool). */
  fastMp4: boolean
  /** Experimental: write TIFF-based RAW metadata directly in JS (fallback: ExifTool). */
  fastRaw: boolean
  /** Which file types folder import picks up. */
  importFilters: ImportFilters
  match: MatchSettings
  /** Which reference data the assign methods use (tracks, geotagged photos, or both). */
  matchSources: { tracks: boolean; photos: boolean }
}

export interface AppState {
  sources: Record<SourceId, Source>
  photos: Record<string, Photo>
  tracks: Record<string, Track>
  selectedIds: ReadonlySet<string>
  activePhotoId?: string
  settings: AppSettings
  scanning: boolean
  /** Thumbnail jobs handed to the workers that have not settled yet. */
  thumbsPending: ReadonlySet<string>
  writeProgress?: { done: number; total: number; current: string; etaMs?: number }
  notices: Notice[]
  /** Manual drags snap to the nearest track when enabled. */
  snapToTrack: boolean
  /** One-shot command for the map to fly somewhere; seq forces re-trigger. */
  mapTarget?: { point: GeoPoint; zoom?: number; seq: number }
  /** Last clicked position on the timeline. */
  timelineCursorMs?: number
  /** One-shot command for the timeline to bring a time into view. */
  timelineTarget?: { t: number; seq: number }
  /** GPX files picked/being read but not parsed yet (shown as loading). */
  pendingGpx: string[]
  /** Track being built/edited on the map. */
  draft?: TrackDraft
  draftSelectedIndex?: number
  /** Fixed point for time-stretching sections of the draft. */
  draftAnchorIndex?: number
  /** While set, the next map click places this draft endpoint. */
  draftPlacement?: { which: 'start' | 'end'; startT: number; endT: number }
  /** Active clock calibration: next map click sets the source's offset. */
  calibrate?: { sourceId: SourceId; photoBaseUtcMs: number; photoName: string }
  /** While set, the next map tap places these photos there (manual position). */
  placement?: { ids: PhotoId[] }

  addSource(source: Source, photos: Photo[]): void
  removeSource(id: SourceId): void
  updateSource(id: SourceId, patch: Partial<Pick<Source, 'name' | 'clockOffsetMs' | 'assumedTzOffsetMin' | 'color'>>): void
  applyScanUpdates(updates: ScanUpdate[]): void
  /** Note thumbnail jobs as in flight (cleared when they deliver or fail). */
  markThumbsRequested(ids: string[]): void
  setScanning(scanning: boolean): void
  addTracks(tracks: Track[]): void
  removeTrack(id: string): void
  addPendingGpx(names: string[]): void
  removePendingGpx(name: string): void
  setSelection(ids: Iterable<string>): void
  toggleSelected(id: string, additive: boolean): void
  setActivePhoto(id?: string): void
  assignSelected(method: AssignmentMethod): AssignSummary
  clearAssignment(ids: string[]): void
  setManualPosition(id: string, point: GeoPoint, onTrackId?: string): void
  markWriting(ids: string[]): void
  /** Photos still 'writing' after a stopped batch go back to their prior state. */
  resetWriting(ids: string[]): void
  markWriteResult(
    photoId: string,
    ok: boolean,
    target?: 'exif' | 'sidecar',
    error?: string,
    timeCorrection?: { wallClockMs: number; tzOffsetMin: number }
  ): void
  /** Result of a time-only write: updates meta, leaves GPS write state alone. */
  markTimeWriteResult(
    photoId: string,
    ok: boolean,
    error?: string,
    timeCorrection?: { wallClockMs: number; tzOffsetMin: number },
    target?: 'exif' | 'sidecar'
  ): void
  setWriteProgress(progress?: { done: number; total: number; current: string; etaMs?: number }): void
  setSettings(patch: Partial<AppSettings>): void
  setSnapToTrack(snap: boolean): void
  flyTo(point: GeoPoint, zoom?: number): void
  setTimelineCursor(tMs: number): void
  /** Move the timeline cursor to t and pan the view there if it is off-screen. */
  revealInTimeline(t: number): void

  /** Start a new manual track; placement of endpoints happens via map clicks. */
  startNewDraft(name: string, startT: number, endT: number, startPoint?: GeoPoint): void
  startEditTrack(trackId: string): void
  placeDraftPoint(pos: GeoPoint): void
  moveDraftPointAt(index: number, pos: GeoPoint): void
  insertDraftAutoAt(afterIndex: number, pos: GeoPoint): number
  setDraftTimeAt(index: number, t: number): void
  deleteDraftPointAt(index: number): void
  setDraftName(name: string): void
  selectDraftPoint(index?: number): void
  /** Shift every draft point's time by the same delta (drag in the timeline). */
  shiftDraftTimes(deltaMs: number): void
  /** Toggle the stretch anchor. */
  setDraftAnchor(index?: number): void
  /**
   * Move point `index` to `newT`, scaling the section between it and
   * `anchorIndex` time-proportionally; points beyond shift by the delta.
   * `base` allows drag gestures to stretch from a snapshot.
   */
  stretchDraft(anchorIndex: number, index: number, newT: number, base?: DraftPoint[]): void
  /** Delete every draft point before/after the given index. Returns removed count. */
  trimDraftAt(index: number, direction: 'before' | 'after'): number
  /** Reverse the draft's direction (times mirrored within the same window). */
  reverseDraft(): void
  /** Append another track's points to the draft. Returns info or an error string. */
  appendTrackToDraft(trackId: string): { added: number; shiftedByMs: number } | string
  copyTrack(trackId: string): void
  cancelDraft(): void
  /** Returns an error message, or undefined on success. */
  commitDraft(): string | undefined
  startCalibrate(sourceId: SourceId, photoBaseUtcMs: number, photoName: string): void
  cancelCalibrate(): void
  startPlacement(ids: PhotoId[]): void
  cancelPlacement(): void
  notify(kind: Notice['kind'], text: string): void
  dismissNotice(id: number): void
}

export type ScanUpdate =
  | { id: string; kind: 'meta'; meta: PhotoMeta; sizeBytes?: number; lastModified?: number }
  | { id: string; kind: 'stat'; sizeBytes: number; lastModified: number }
  | { id: string; kind: 'sidecar'; gps?: GeoPoint; time?: { wallClockMs: number; tzOffsetMin?: number } }
  | { id: string; kind: 'thumb'; url: string }
  | { id: string; kind: 'thumb-failed' }
  | { id: string; kind: 'error'; message: string }

let noticeCounter = 1

const SETTINGS_KEY = 'photo-geotagger.settings.v1'

const DEFAULT_SETTINGS: AppSettings = {
  writeMode: 'safe',
  backupOriginals: false,
  writeCorrectedTime: false,
  parallelExiftool: false,
  embedSidecarGps: false,
  fastMp4: false,
  fastRaw: false,
  importFilters: { jpeg: true, raw: true, xmp: true, video: true },
  match: DEFAULT_MATCH_SETTINGS,
  matchSources: { tracks: true, photos: true },
}

/** Settings survive sessions; unknown/missing fields fall back to defaults. */
function initialSettings(): AppSettings {
  let stored: Partial<AppSettings> = {}
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SETTINGS_KEY) : null
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === 'object') stored = parsed as Partial<AppSettings>
  } catch {
    // corrupt/unavailable storage — use defaults
  }
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    importFilters: { ...DEFAULT_SETTINGS.importFilters, ...stored.importFilters },
    match: { ...DEFAULT_SETTINGS.match, ...stored.match },
    matchSources: { ...DEFAULT_SETTINGS.matchSources, ...stored.matchSources },
  }
}

export const useStore = create<AppState>((set, get) => ({
  sources: {},
  photos: {},
  tracks: {},
  selectedIds: new Set<string>(),
  thumbsPending: new Set<string>(),
  settings: initialSettings(),
  scanning: false,
  notices: [],
  snapToTrack: false,
  pendingGpx: [],

  addSource(source, photos) {
    set((s) => {
      const photoMap = { ...s.photos }
      for (const p of photos) photoMap[p.id] = p
      return { sources: { ...s.sources, [source.id]: source }, photos: photoMap }
    })
  },

  removeSource(id) {
    set((s) => {
      const sources = { ...s.sources }
      delete sources[id]
      const photos: Record<string, Photo> = {}
      for (const [pid, p] of Object.entries(s.photos)) {
        if (p.sourceId !== id) photos[pid] = p
        else if (p.thumbUrl) URL.revokeObjectURL(p.thumbUrl)
      }
      const selectedIds = new Set([...s.selectedIds].filter((pid) => photos[pid]))
      // Drop every reference into the removed source, not just the selection.
      const activePhotoId = s.activePhotoId && photos[s.activePhotoId] ? s.activePhotoId : undefined
      const calibrate = s.calibrate?.sourceId === id ? undefined : s.calibrate
      const placementIds = s.placement?.ids.filter((pid) => photos[pid]) ?? []
      const placement = placementIds.length > 0 ? { ids: placementIds } : undefined
      return { sources, photos, selectedIds, activePhotoId, calibrate, placement }
    })
  },

  updateSource(id, patch) {
    set((s) => {
      const src = s.sources[id]
      if (!src) return s
      return { sources: { ...s.sources, [id]: { ...src, ...patch } } }
    })
  },

  markThumbsRequested(ids) {
    if (ids.length === 0) return
    set((s) => {
      const pending = new Set(s.thumbsPending)
      for (const id of ids) pending.add(id)
      return { thumbsPending: pending }
    })
  },

  applyScanUpdates(updates) {
    set((s) => {
      const photos = { ...s.photos }
      // Thumbnail jobs settle here (delivered or failed) — drop them from the
      // in-flight set that drives the per-folder progress display.
      let thumbsPending: Set<string> | undefined
      for (const u of updates) {
        if (u.kind !== 'thumb' && u.kind !== 'thumb-failed') continue
        if (!s.thumbsPending.has(u.id)) continue
        thumbsPending ??= new Set(s.thumbsPending)
        thumbsPending.delete(u.id)
      }
      for (const u of updates) {
        const p = photos[u.id]
        if (!p) continue
        switch (u.kind) {
          case 'meta':
            photos[u.id] = {
              ...p,
              meta: u.meta,
              scanState: 'done',
              sizeBytes: u.sizeBytes ?? p.sizeBytes,
              lastModified: u.lastModified ?? p.lastModified,
            }
            break
          case 'stat':
            photos[u.id] = { ...p, sizeBytes: u.sizeBytes, lastModified: u.lastModified }
            break
          case 'sidecar':
            photos[u.id] = {
              ...p,
              sidecarGps: u.gps ?? p.sidecarGps,
              sidecarTime: u.time ?? p.sidecarTime,
            }
            break
          case 'thumb':
            // A racing duplicate generation must not orphan the old blob URL.
            if (p.thumbUrl && p.thumbUrl !== u.url) URL.revokeObjectURL(p.thumbUrl)
            photos[u.id] = { ...p, thumbUrl: u.url }
            break
          case 'thumb-failed':
            photos[u.id] = { ...p, thumbFailed: true }
            break
          case 'error':
            photos[u.id] = { ...p, scanState: 'error', scanError: u.message }
            break
        }
      }
      return thumbsPending ? { photos, thumbsPending } : { photos }
    })
  },

  setScanning(scanning) {
    set({ scanning })
  },

  addTracks(tracks) {
    set((s) => {
      const map = { ...s.tracks }
      let added = 0
      for (const t of tracks) {
        map[t.id] = t.color ? t : { ...t, color: nextTrackColor(s.tracks, added++) }
      }
      return { tracks: map }
    })
  },

  removeTrack(id) {
    set((s) => {
      const tracks = { ...s.tracks }
      delete tracks[id]
      return { tracks }
    })
  },

  addPendingGpx(names) {
    set((s) => ({ pendingGpx: [...s.pendingGpx, ...names.filter((n) => !s.pendingGpx.includes(n))] }))
  },

  removePendingGpx(name) {
    set((s) => ({ pendingGpx: s.pendingGpx.filter((n) => n !== name) }))
  },

  setSelection(ids) {
    set({ selectedIds: new Set(ids) })
  },

  toggleSelected(id, additive) {
    set((s) => {
      const next = additive ? new Set(s.selectedIds) : new Set<string>()
      if (additive && next.has(id)) {
        // Deselecting must not leave the deselected photo as the active one.
        next.delete(id)
        return { selectedIds: next, activePhotoId: s.activePhotoId === id ? undefined : s.activePhotoId }
      }
      next.add(id)
      return { selectedIds: next, activePhotoId: id }
    })
  },

  setActivePhoto(id) {
    set({ activePhotoId: id })
  },

  assignSelected(method) {
    const s = get()
    const summary: AssignSummary = { assigned: 0, degraded: 0, noMatch: 0, noTime: 0 }
    // The user picks which reference data the methods work against:
    // GPX tracks, geotagged photos, or both (photos fill uncovered sides).
    const { tracks: useTracks, photos: usePhotos } = s.settings.matchSources
    const tracks = useTracks ? Object.values(s.tracks) : []
    const sourcesMap = new Map(Object.entries(s.sources))
    const selected = [...s.selectedIds]
    const photos = { ...s.photos }

    const refs =
      usePhotos || method === 'inherit'
        ? buildInheritReferences(Object.values(s.photos), sourcesMap, new Set(selected))
        : []

    for (const id of selected) {
      const photo = photos[id]
      const source = photo && sourcesMap.get(photo.sourceId)
      if (!photo || !source) continue
      if (method === 'manual' || method === 'manual-on-track') continue

      const result =
        method === 'inherit'
          ? matchByInherit(photo, source, refs, s.settings.match)
          : matchToTracks(photo, source, tracks, method, refs)

      if (result.ok) {
        photos[id] = { ...photo, assignment: result.assignment, writeState: 'dirty', writeError: undefined }
        summary.assigned++
        if (result.assignment.degraded) summary.degraded++
      } else if (result.reason === 'no-time') {
        summary.noTime++
      } else {
        summary.noMatch++
      }
    }
    set({ photos })
    return summary
  },

  clearAssignment(ids) {
    set((s) => {
      const photos = { ...s.photos }
      for (const id of ids) {
        const p = photos[id]
        if (p?.assignment) {
          photos[id] = { ...p, assignment: undefined, writeState: 'clean', writeError: undefined }
        }
      }
      return { photos }
    })
  },

  setManualPosition(id, point, onTrackId) {
    set((s) => {
      const p = s.photos[id]
      if (!p) return s
      const source = s.sources[p.sourceId]
      const t = source ? effectiveUtcMs(p, source) : undefined
      const assignment = manualAssignment(point, t, onTrackId ? { trackId: onTrackId } : undefined)
      return { photos: { ...s.photos, [id]: { ...p, assignment, writeState: 'dirty', writeError: undefined } } }
    })
  },

  markWriting(ids) {
    set((s) => {
      const photos = { ...s.photos }
      for (const id of ids) {
        const p = photos[id]
        if (p) photos[id] = { ...p, writeState: 'writing', writeError: undefined }
      }
      return { photos }
    })
  },

  resetWriting(ids) {
    set((s) => {
      const photos = { ...s.photos }
      for (const id of ids) {
        const p = photos[id]
        if (p && p.writeState === 'writing') {
          photos[id] = { ...p, writeState: p.assignment ? 'dirty' : 'clean' }
        }
      }
      return { photos }
    })
  },

  markWriteResult(photoId, ok, target, error, timeCorrection) {
    set((s) => {
      const p = s.photos[photoId]
      if (!p) return s
      let meta = p.meta
      let sidecarTime = p.sidecarTime
      if (ok && meta && p.assignment) {
        meta = { ...meta, originalGps: p.assignment.point }
        if (timeCorrection && target === 'exif') {
          // The file now carries the corrected wall clock + timezone; the
          // source's offset must no longer be applied to this photo.
          meta = {
            ...meta,
            captureLocalMs: timeCorrection.wallClockMs,
            tzOffsetMin: timeCorrection.tzOffsetMin,
            timeCorrected: true,
          }
        }
      }
      if (ok && timeCorrection && target === 'sidecar') {
        // The correction lives in the sidecar, not the file — mirror what a
        // re-import of the sidecar would read.
        sidecarTime = { wallClockMs: timeCorrection.wallClockMs, tzOffsetMin: timeCorrection.tzOffsetMin }
      }
      const updated: Photo = ok
        ? {
            ...p,
            writeState: 'written',
            writeTarget: target,
            writeError: undefined,
            meta,
            sidecarTime,
            sidecarGps: target === 'sidecar' && p.assignment ? p.assignment.point : p.sidecarGps,
          }
        : { ...p, writeState: 'write-error', writeError: error }
      return { photos: { ...s.photos, [photoId]: updated } }
    })
  },

  markTimeWriteResult(photoId, ok, error, timeCorrection, target) {
    set((s) => {
      const p = s.photos[photoId]
      if (!p) return s
      if (!ok) {
        return { photos: { ...s.photos, [photoId]: { ...p, writeState: 'write-error', writeError: error } } }
      }
      if (timeCorrection && target === 'sidecar') {
        // The correction lives in the sidecar; the file's EXIF is unchanged.
        const sidecarTime = { wallClockMs: timeCorrection.wallClockMs, tzOffsetMin: timeCorrection.tzOffsetMin }
        const writeState = p.assignment && p.writeState !== 'written' ? 'dirty' : p.writeState === 'writing' ? 'clean' : p.writeState
        return { photos: { ...s.photos, [photoId]: { ...p, sidecarTime, writeState, writeError: undefined } } }
      }
      const meta =
        p.meta && timeCorrection
          ? {
              ...p.meta,
              captureLocalMs: timeCorrection.wallClockMs,
              tzOffsetMin: timeCorrection.tzOffsetMin,
              timeCorrected: true,
            }
          : p.meta
      // GPS write state is untouched: a pending assignment stays dirty.
      const writeState = p.assignment && p.writeState !== 'written' ? 'dirty' : p.writeState === 'writing' ? 'clean' : p.writeState
      return { photos: { ...s.photos, [photoId]: { ...p, meta, writeState, writeError: undefined } } }
    })
  },

  setWriteProgress(writeProgress) {
    set({ writeProgress })
  },

  setSettings(patch) {
    set((s) => {
      const settings = { ...s.settings, ...patch }
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
      } catch {
        // storage unavailable — settings stay session-only
      }
      return { settings }
    })
  },

  setSnapToTrack(snapToTrack) {
    set({ snapToTrack })
  },

  flyTo(point, zoom) {
    set((s) => ({ mapTarget: { point, zoom, seq: (s.mapTarget?.seq ?? 0) + 1 } }))
  },

  setTimelineCursor(timelineCursorMs) {
    set({ timelineCursorMs })
  },

  revealInTimeline(t) {
    set((s) => ({
      timelineCursorMs: t,
      timelineTarget: { t, seq: (s.timelineTarget?.seq ?? 0) + 1 },
    }))
  },

  startNewDraft(name, startT, endT, startPoint) {
    if (startPoint) {
      set({
        draft: { name, points: [{ lat: startPoint.lat, lon: startPoint.lon, t: startT, manual: true }] },
        draftPlacement: { which: 'end', startT, endT },
        draftSelectedIndex: undefined,
      })
    } else {
      set({
        draft: { name, points: [] },
        draftPlacement: { which: 'start', startT, endT },
        draftSelectedIndex: undefined,
      })
    }
  },

  startEditTrack(trackId) {
    const track = get().tracks[trackId]
    if (!track) return
    set({ draft: draftFromTrack(track), draftPlacement: undefined, draftSelectedIndex: undefined })
  },

  placeDraftPoint(pos) {
    set((s) => {
      if (!s.draft || !s.draftPlacement) return s
      const { which, startT, endT } = s.draftPlacement
      const point = { lat: pos.lat, lon: pos.lon, t: which === 'start' ? startT : endT, manual: true }
      const points = [...s.draft.points, point]
      return {
        draft: { ...s.draft, points },
        draftPlacement: which === 'start' ? { which: 'end', startT, endT } : undefined,
      }
    })
  },

  moveDraftPointAt(index, pos) {
    set((s) =>
      s.draft ? { draft: { ...s.draft, points: moveDraftPoint(s.draft.points, index, pos) } } : s
    )
  },

  insertDraftAutoAt(afterIndex, pos) {
    const s = get()
    if (!s.draft) return -1
    const points = insertAutoPoint(s.draft.points, afterIndex, pos)
    set({
      draft: { ...s.draft, points },
      draftSelectedIndex: afterIndex + 1,
      draftAnchorIndex:
        s.draftAnchorIndex !== undefined && s.draftAnchorIndex > afterIndex
          ? s.draftAnchorIndex + 1
          : s.draftAnchorIndex,
    })
    return afterIndex + 1
  },

  setDraftTimeAt(index, t) {
    set((s) =>
      s.draft ? { draft: { ...s.draft, points: setDraftPointTime(s.draft.points, index, t) } } : s
    )
  },

  deleteDraftPointAt(index) {
    set((s) => {
      if (!s.draft) return s
      const points = deleteDraftPoint(s.draft.points, index)
      if (points === s.draft.points) return s
      const adjust = (i?: number) =>
        i === undefined || i === index ? undefined : i > index ? i - 1 : i
      return {
        draft: { ...s.draft, points },
        draftSelectedIndex: adjust(s.draftSelectedIndex),
        draftAnchorIndex: adjust(s.draftAnchorIndex),
      }
    })
  },

  setDraftName(name) {
    set((s) => (s.draft ? { draft: { ...s.draft, name } } : s))
  },

  selectDraftPoint(draftSelectedIndex) {
    set({ draftSelectedIndex })
  },

  shiftDraftTimes(deltaMs) {
    set((s) => {
      if (!s.draft || deltaMs === 0) return s
      const points = s.draft.points.map((p) => ({ ...p, t: p.t + deltaMs }))
      return { draft: { ...s.draft, points } }
    })
  },

  setDraftAnchor(index) {
    set((s) => ({ draftAnchorIndex: s.draftAnchorIndex === index ? undefined : index }))
  },

  stretchDraft(anchorIndex, index, newT, base) {
    set((s) => {
      if (!s.draft) return s
      const source = base ?? s.draft.points
      const points = stretchDraftTimes(source, anchorIndex, index, newT)
      if (points === source && !base) return s
      // The moved point's time was set deliberately: it becomes an anchor.
      const marked = points.map((p, i) => (i === index ? { ...p, manual: true } : p))
      return { draft: { ...s.draft, points: marked } }
    })
  },

  trimDraftAt(index, direction) {
    const s = get()
    if (!s.draft) return 0
    const points = trimDraftPoints(s.draft.points, index, direction)
    if (points === s.draft.points) return 0
    const removed = s.draft.points.length - points.length
    const offset = direction === 'before' ? index : 0
    const adjust = (i?: number) => {
      if (i === undefined) return undefined
      const ni = i - offset
      return ni >= 0 && ni < points.length ? ni : undefined
    }
    set({
      draft: { ...s.draft, points },
      draftSelectedIndex: adjust(s.draftSelectedIndex),
      draftAnchorIndex: adjust(s.draftAnchorIndex),
    })
    return removed
  },

  reverseDraft() {
    set((s) => {
      if (!s.draft || s.draft.points.length < 2) return s
      const n = s.draft.points.length
      const flip = (i?: number) => (i === undefined ? undefined : n - 1 - i)
      return {
        draft: { ...s.draft, points: reverseDraftPoints(s.draft.points) },
        draftSelectedIndex: flip(s.draftSelectedIndex),
        draftAnchorIndex: flip(s.draftAnchorIndex),
      }
    })
  },

  appendTrackToDraft(trackId) {
    const s = get()
    if (!s.draft) return 'No track is being edited'
    const track = s.tracks[trackId]
    if (!track) return 'Track not found'
    if (s.draft.trackId === trackId) return 'Cannot append a track to itself'
    const { points, shiftedByMs } = appendTrackPoints(s.draft.points, track.points)
    set({ draft: { ...s.draft, points } })
    return { added: track.points.length, shiftedByMs }
  },

  copyTrack(trackId) {
    const s = get()
    const track = s.tracks[trackId]
    if (!track) return
    const id = nextTrackId()
    const color = nextTrackColor(s.tracks)
    const copy = {
      ...track,
      id,
      color,
      name: `${track.name} (copy)`,
      fileName: `${track.name} (copy).gpx`,
      points: track.points.map((p) => ({ ...p })),
      segments: track.segments.map((seg) => ({ ...seg })),
    }
    set({ tracks: { ...s.tracks, [id]: copy } })
  },

  cancelDraft() {
    set(DRAFT_CLEARED)
  },

  commitDraft() {
    const s = get()
    const draft = s.draft
    if (!draft) return 'No track being edited'
    if (draft.points.length < 2) return 'A track needs at least a start and an end point'
    const points = reinterpolateTimes(draft.points)
    const invalid = validateDraftTimes(points)
    if (invalid) return invalid

    if (draft.trackId && s.tracks[draft.trackId]) {
      const old = s.tracks[draft.trackId]
      const track = trackFromDraft({ ...draft, points }, old.id, old.color, old.fileName)
      set({ tracks: { ...s.tracks, [old.id]: track }, ...DRAFT_CLEARED })
    } else {
      const id = nextTrackId()
      const color = nextTrackColor(s.tracks)
      const track = trackFromDraft({ ...draft, points }, id, color)
      set({ tracks: { ...s.tracks, [id]: track }, ...DRAFT_CLEARED })
    }
    return undefined
  },

  startCalibrate(sourceId, photoBaseUtcMs, photoName) {
    set({ calibrate: { sourceId, photoBaseUtcMs, photoName } })
  },

  cancelCalibrate() {
    set({ calibrate: undefined })
  },

  startPlacement(ids) {
    if (ids.length === 0) return
    // Placement and calibration both consume the next map tap — exclusive.
    set({ placement: { ids }, calibrate: undefined })
  },

  cancelPlacement() {
    set({ placement: undefined })
  },

  notify(kind, text) {
    const id = noticeCounter++
    set((s) => ({ notices: [...s.notices, { id, kind, text }] }))
    setTimeout(() => get().dismissNotice(id), kind === 'error' ? 12000 : 6000)
  },

  dismissNotice(id) {
    set((s) => ({ notices: s.notices.filter((n) => n.id !== id) }))
  },
}))

// Test/debug hook (dev builds only): lets E2E tests inspect and drive state.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__store = useStore
}

let sourceCounter = 1
let trackCounter = 1

export function nextSourceId(): string {
  return `src${sourceCounter++}`
}

export function nextTrackId(): string {
  return `trk${trackCounter++}`
}

export function makePhotoRecord(
  sourceId: SourceId,
  handle: FileSystemFileHandle,
  relativePath: string,
  name: string,
  sizeBytes: number,
  lastModified: number
): Photo | undefined {
  const kind = photoKindFromName(name)
  if (!kind) return undefined
  return {
    id: `${sourceId}:${relativePath}`,
    sourceId,
    fileName: name,
    relativePath,
    kind,
    sizeBytes,
    lastModified,
    fileHandle: handle,
    scanState: 'pending',
    writeState: 'clean',
  }
}
