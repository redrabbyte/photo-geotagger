import { create } from 'zustand'
import type {
  AssignmentMethod,
  GeoPoint,
  Photo,
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
import type { WriteMode } from '../services/writePipeline'

export const SOURCE_COLORS = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#b07aa1', '#76b7b2', '#edc948']
export const TRACK_COLORS = ['#d62728', '#9467bd', '#8c564b', '#e377c2', '#17becf', '#bcbd22']

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

interface AppSettings {
  writeMode: WriteMode
  backupOriginals: boolean
  match: MatchSettings
}

export interface AppState {
  sources: Record<SourceId, Source>
  photos: Record<string, Photo>
  tracks: Record<string, Track>
  selectedIds: ReadonlySet<string>
  activePhotoId?: string
  settings: AppSettings
  scanning: boolean
  writeProgress?: { done: number; total: number; current: string }
  notices: Notice[]
  /** Manual drags snap to the nearest track when enabled. */
  snapToTrack: boolean
  /** One-shot command for the map to fly somewhere; seq forces re-trigger. */
  mapTarget?: { point: GeoPoint; zoom?: number; seq: number }
  /** Active clock calibration: next map click sets the source's offset. */
  calibrate?: { sourceId: SourceId; photoBaseUtcMs: number; photoName: string }

  addSource(source: Source, photos: Photo[]): void
  removeSource(id: SourceId): void
  updateSource(id: SourceId, patch: Partial<Pick<Source, 'name' | 'clockOffsetMs' | 'assumedTzOffsetMin' | 'color'>>): void
  applyScanUpdates(updates: ScanUpdate[]): void
  setScanning(scanning: boolean): void
  addTracks(tracks: Track[]): void
  removeTrack(id: string): void
  setSelection(ids: Iterable<string>): void
  toggleSelected(id: string, additive: boolean): void
  setActivePhoto(id?: string): void
  assignSelected(method: AssignmentMethod): AssignSummary
  clearAssignment(ids: string[]): void
  setManualPosition(id: string, point: GeoPoint, onTrackId?: string): void
  markWriting(ids: string[]): void
  markWriteResult(photoId: string, ok: boolean, target?: 'exif' | 'sidecar', error?: string): void
  setWriteProgress(progress?: { done: number; total: number; current: string }): void
  setSettings(patch: Partial<AppSettings>): void
  setSnapToTrack(snap: boolean): void
  flyTo(point: GeoPoint, zoom?: number): void
  startCalibrate(sourceId: SourceId, photoBaseUtcMs: number, photoName: string): void
  cancelCalibrate(): void
  notify(kind: Notice['kind'], text: string): void
  dismissNotice(id: number): void
}

export type ScanUpdate =
  | { id: string; kind: 'meta'; meta: PhotoMeta; sizeBytes?: number; lastModified?: number }
  | { id: string; kind: 'thumb'; url: string }
  | { id: string; kind: 'thumb-failed' }
  | { id: string; kind: 'error'; message: string }

let noticeCounter = 1

export const useStore = create<AppState>((set, get) => ({
  sources: {},
  photos: {},
  tracks: {},
  selectedIds: new Set<string>(),
  settings: {
    writeMode: 'safe',
    backupOriginals: true,
    match: DEFAULT_MATCH_SETTINGS,
  },
  scanning: false,
  notices: [],
  snapToTrack: false,

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
      return { sources, photos, selectedIds }
    })
  },

  updateSource(id, patch) {
    set((s) => {
      const src = s.sources[id]
      if (!src) return s
      return { sources: { ...s.sources, [id]: { ...src, ...patch } } }
    })
  },

  applyScanUpdates(updates) {
    set((s) => {
      const photos = { ...s.photos }
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
          case 'thumb':
            photos[u.id] = { ...p, thumbUrl: u.url }
            break
          case 'thumb-failed':
            photos[u.id] = { ...p }
            break
          case 'error':
            photos[u.id] = { ...p, scanState: 'error', scanError: u.message }
            break
        }
      }
      return { photos }
    })
  },

  setScanning(scanning) {
    set({ scanning })
  },

  addTracks(tracks) {
    set((s) => {
      const map = { ...s.tracks }
      let colorIdx = Object.keys(map).length
      for (const t of tracks) {
        map[t.id] = t.color ? t : { ...t, color: TRACK_COLORS[colorIdx++ % TRACK_COLORS.length] }
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

  setSelection(ids) {
    set({ selectedIds: new Set(ids) })
  },

  toggleSelected(id, additive) {
    set((s) => {
      const next = additive ? new Set(s.selectedIds) : new Set<string>()
      if (additive && next.has(id)) next.delete(id)
      else next.add(id)
      return { selectedIds: next, activePhotoId: id }
    })
  },

  setActivePhoto(id) {
    set({ activePhotoId: id })
  },

  assignSelected(method) {
    const s = get()
    const summary: AssignSummary = { assigned: 0, degraded: 0, noMatch: 0, noTime: 0 }
    const tracks = Object.values(s.tracks)
    const sourcesMap = new Map(Object.entries(s.sources))
    const selected = [...s.selectedIds]
    const photos = { ...s.photos }

    const inheritRefs =
      method === 'inherit'
        ? buildInheritReferences(Object.values(s.photos), sourcesMap, new Set(selected))
        : []

    for (const id of selected) {
      const photo = photos[id]
      const source = photo && sourcesMap.get(photo.sourceId)
      if (!photo || !source) continue
      if (method === 'manual' || method === 'manual-on-track') continue

      const result =
        method === 'inherit'
          ? matchByInherit(photo, source, inheritRefs, s.settings.match)
          : matchToTracks(photo, source, tracks, method, s.settings.match)

      if (result.ok) {
        photos[id] = { ...photo, assignment: result.assignment, writeState: 'dirty' }
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
      return { photos: { ...s.photos, [id]: { ...p, assignment, writeState: 'dirty' } } }
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

  markWriteResult(photoId, ok, target, error) {
    set((s) => {
      const p = s.photos[photoId]
      if (!p) return s
      const updated: Photo = ok
        ? {
            ...p,
            writeState: 'written',
            writeTarget: target,
            writeError: undefined,
            meta: p.meta && p.assignment ? { ...p.meta, originalGps: p.assignment.point } : p.meta,
          }
        : { ...p, writeState: 'write-error', writeError: error }
      return { photos: { ...s.photos, [photoId]: updated } }
    })
  },

  setWriteProgress(writeProgress) {
    set({ writeProgress })
  },

  setSettings(patch) {
    set((s) => ({ settings: { ...s.settings, ...patch } }))
  },

  setSnapToTrack(snapToTrack) {
    set({ snapToTrack })
  },

  flyTo(point, zoom) {
    set((s) => ({ mapTarget: { point, zoom, seq: (s.mapTarget?.seq ?? 0) + 1 } }))
  },

  startCalibrate(sourceId, photoBaseUtcMs, photoName) {
    set({ calibrate: { sourceId, photoBaseUtcMs, photoName } })
  },

  cancelCalibrate() {
    set({ calibrate: undefined })
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
