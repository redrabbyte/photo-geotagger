import type { Photo, Source, Track } from '../domain/types'
import { isDirty } from '../domain/types'
import { parseGpx, GpxParseError } from '../domain/parseGpx'
import { enumerateFolder, fsaSupported } from './fs/sources'
import {
  ensurePermission,
  loadPersistedGpx,
  loadPersistedSources,
  persistSources,
  rememberGpxHandles,
} from './fs/handleStore'
import { ScanClient } from './scanClient'
import { writeBatch } from './writePipeline'
import { useStore, nextSourceId, nextTrackId, makePhotoRecord, SOURCE_COLORS, type ScanUpdate } from '../state/store'

let scanClient: ScanClient | undefined
let updateBuffer: ScanUpdate[] = []
let flushTimer: ReturnType<typeof setTimeout> | undefined

function flushUpdates(): void {
  if (updateBuffer.length === 0) return
  const batch = updateBuffer
  updateBuffer = []
  useStore.getState().applyScanUpdates(batch)
}

function queueUpdate(update: ScanUpdate): void {
  updateBuffer.push(update)
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = undefined
      flushUpdates()
    }, 120)
  }
}

function getScanClient(): ScanClient {
  if (!scanClient) {
    scanClient = new ScanClient({
      onMeta: (id, meta, sizeBytes, lastModified) =>
        queueUpdate({ id, kind: 'meta', meta, sizeBytes, lastModified }),
      onThumb: (id, url) => queueUpdate({ id, kind: 'thumb', url }),
      onThumbFailed: (id) => queueUpdate({ id, kind: 'thumb-failed' }),
      onError: (id, message) => queueUpdate({ id, kind: 'error', message }),
      onIdle: () => {
        flushUpdates()
        useStore.getState().setScanning(false)
      },
    })
  }
  return scanClient
}

async function persistCurrentSources(): Promise<void> {
  const { sources } = useStore.getState()
  await persistSources(
    Object.values(sources)
      .filter((s) => s.dirHandle)
      .map((s) => ({
        id: s.id,
        name: s.name,
        color: s.color,
        clockOffsetMs: s.clockOffsetMs,
        assumedTzOffsetMin: s.assumedTzOffsetMin,
        dirHandle: s.dirHandle!,
      }))
  )
}

async function ingestSource(source: Source): Promise<void> {
  const store = useStore.getState()
  if (!source.dirHandle) return
  const scan = await enumerateFolder(source.dirHandle)

  // Size/mtime are filled in by the scan worker — reading every file here
  // would block the UI on large folders before anything shows up.
  const photos: Photo[] = []
  for (const f of scan.photos) {
    const record = makePhotoRecord(source.id, f.handle, f.relativePath, f.name, 0, 0)
    if (record) photos.push(record)
  }
  store.addSource(source, photos)

  // GPX files found inside the folder are loaded as tracks automatically.
  for (const gpx of scan.gpxFiles) {
    try {
      const text = await (await gpx.handle.getFile()).text()
      const tracks = parseGpx(text, gpx.name, () => nextTrackId())
      useStore.getState().addTracks(tracks)
    } catch (err) {
      store.notify('error', err instanceof GpxParseError ? err.message : `Failed to load ${gpx.name}`)
    }
  }

  if (photos.length > 0) {
    store.setScanning(true)
    getScanClient().enqueue(
      photos.map((p) => ({ id: p.id, handle: p.fileHandle!, kind: p.kind }))
    )
  }
  store.notify(
    'info',
    `${source.name}: ${photos.length} photos${scan.gpxFiles.length ? `, ${scan.gpxFiles.length} GPX file(s)` : ''}`
  )
}

/** Pick a folder and add it as a new source. */
export async function addSourceFlow(): Promise<void> {
  const store = useStore.getState()
  if (!fsaSupported()) {
    store.notify('error', 'This browser has no File System Access API — use Chrome or Edge.')
    return
  }
  let dirHandle: FileSystemDirectoryHandle
  try {
    // Read-only: avoids Chrome's extra "let site make changes?" prompt, which
    // aborts the picker when declined. Write permission is requested later,
    // when the user actually clicks "Write GPS".
    dirHandle = await showDirectoryPicker({ mode: 'read', id: 'photo-source' })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return // user cancelled
    store.notify('error', `Could not open folder: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  const existing = Object.keys(store.sources).length
  const source: Source = {
    id: nextSourceId(),
    name: dirHandle.name || `Source ${existing + 1}`,
    color: SOURCE_COLORS[existing % SOURCE_COLORS.length],
    clockOffsetMs: 0,
    assumedTzOffsetMin: -new Date().getTimezoneOffset(),
    dirHandle,
  }
  store.notify('info', `Reading "${source.name}"…`)
  try {
    await ingestSource(source)
  } catch (err) {
    store.notify('error', `Failed to read folder: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  await persistCurrentSources()
}

const PHOTO_EXTENSIONS = ['.jpg', '.jpeg', '.jpe', '.heic', '.heif', '.arw', '.cr2', '.cr3', '.nef', '.dng', '.raf', '.orf', '.rw2']

/**
 * Pick individual image files (not a folder). They form their own source;
 * without a folder handle, sidecars and .orig backups are unavailable, but
 * in-place writes work after a per-file permission grant.
 */
export async function addFilesFlow(): Promise<void> {
  const store = useStore.getState()
  if (typeof showOpenFilePicker !== 'function') {
    store.notify('error', 'File picker unavailable in this browser.')
    return
  }
  let handles: FileSystemFileHandle[]
  try {
    handles = await showOpenFilePicker({
      multiple: true,
      types: [{ description: 'Photos', accept: { 'image/*': PHOTO_EXTENSIONS } }],
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return
    store.notify('error', `Could not open files: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  if (handles.length === 0) return

  const existing = Object.keys(store.sources).length
  const source: Source = {
    id: nextSourceId(),
    name: handles.length === 1 ? handles[0].name : `${handles[0].name} +${handles.length - 1}`,
    color: SOURCE_COLORS[existing % SOURCE_COLORS.length],
    clockOffsetMs: 0,
    assumedTzOffsetMin: -new Date().getTimezoneOffset(),
  }
  const photos: Photo[] = []
  let skipped = 0
  for (const h of handles) {
    const record = makePhotoRecord(source.id, h, h.name, h.name, 0, 0)
    if (record) photos.push(record)
    else skipped++
  }
  if (photos.length === 0) {
    store.notify('error', 'None of the selected files are supported photo formats.')
    return
  }
  store.addSource(source, photos)
  store.setScanning(true)
  getScanClient().enqueue(photos.map((p) => ({ id: p.id, handle: p.fileHandle!, kind: p.kind })))
  store.notify('info', `Added ${photos.length} photo(s)${skipped ? `, skipped ${skipped} unsupported file(s)` : ''}`)
}

export interface RestorableSource {
  name: string
  restore: () => Promise<void>
}

/** List sources persisted from an earlier session; each restores on click (user gesture). */
export async function listRestorableSources(): Promise<RestorableSource[]> {
  if (!fsaSupported()) return []
  const persisted = await loadPersistedSources()
  return persisted.map((p) => ({
    name: p.name,
    restore: async () => {
      const store = useStore.getState()
      if (!(await ensurePermission(p.dirHandle, 'read'))) {
        store.notify('error', `Permission denied for "${p.name}" — pick the folder again instead.`)
        return
      }
      const source: Source = {
        id: nextSourceId(),
        name: p.name,
        color: p.color,
        clockOffsetMs: p.clockOffsetMs,
        assumedTzOffsetMin: p.assumedTzOffsetMin,
        dirHandle: p.dirHandle,
      }
      try {
        await ingestSource(source)
      } catch (err) {
        store.notify('error', `Failed to read folder: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  }))
}

/** Pick GPX files explicitly (outside any source folder). */
export async function addGpxFlow(): Promise<void> {
  const store = useStore.getState()
  if (typeof showOpenFilePicker !== 'function') {
    store.notify('error', 'File picker unavailable in this browser.')
    return
  }
  let handles: FileSystemFileHandle[]
  try {
    handles = await showOpenFilePicker({
      multiple: true,
      types: [{ description: 'GPX tracks', accept: { 'application/gpx+xml': ['.gpx'] } }],
    })
  } catch {
    return // cancelled
  }
  const loaded: FileSystemFileHandle[] = []
  for (const handle of handles) {
    try {
      const file = await handle.getFile()
      const tracks: Track[] = parseGpx(await file.text(), file.name, () => nextTrackId())
      store.addTracks(tracks)
      loaded.push(handle)
      store.notify('success', `Loaded ${file.name}: ${tracks.reduce((n, t) => n + t.points.length, 0)} points`)
    } catch (err) {
      store.notify('error', err instanceof GpxParseError ? err.message : `Failed to parse ${handle.name}`)
    }
  }
  if (loaded.length > 0) await rememberGpxHandles(loaded)
}

export interface RestorableGpx {
  name: string
  restore: () => Promise<void>
}

/** GPX files picked in earlier sessions; each restores on click (user gesture). */
export async function listRestorableGpx(): Promise<RestorableGpx[]> {
  if (!fsaSupported()) return []
  const persisted = await loadPersistedGpx()
  return persisted.map((p) => ({
    name: p.name,
    restore: async () => {
      const store = useStore.getState()
      if (!(await ensurePermission(p.fileHandle, 'read'))) {
        store.notify('error', `Permission denied for "${p.name}" — pick the file again instead.`)
        return
      }
      try {
        const file = await p.fileHandle.getFile()
        const tracks = parseGpx(await file.text(), file.name, () => nextTrackId())
        store.addTracks(tracks)
        store.notify('success', `Restored ${file.name}`)
      } catch (err) {
        store.notify('error', err instanceof GpxParseError ? err.message : `Failed to restore ${p.name}`)
      }
    },
  }))
}

/** Save the current track draft as a .gpx file (picker with download fallback). */
export async function exportDraftGpx(): Promise<void> {
  const store = useStore.getState()
  const draft = store.draft
  if (!draft || draft.points.length < 2) {
    store.notify('info', 'Nothing to export — the track needs at least two points.')
    return
  }
  const { generateGpx, reinterpolateTimes, validateDraftTimes } = await import('../domain/trackDraft')
  const points = reinterpolateTimes(draft.points)
  const invalid = validateDraftTimes(points)
  if (invalid) {
    store.notify('error', invalid)
    return
  }
  const xml = generateGpx(draft.name || 'manual track', points)
  const suggestedName = `${(draft.name || 'manual-track').replace(/[^\w.-]+/g, '-')}.gpx`

  if (typeof showSaveFilePicker === 'function') {
    try {
      const handle = await showSaveFilePicker({
        suggestedName,
        types: [{ description: 'GPX track', accept: { 'application/gpx+xml': ['.gpx'] } }],
      })
      const writable = await handle.createWritable()
      await writable.write(xml)
      await writable.close()
      store.notify('success', `Saved ${handle.name}`)
      return
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      // fall through to download
    }
  }
  const url = URL.createObjectURL(new Blob([xml], { type: 'application/gpx+xml' }))
  const a = document.createElement('a')
  a.href = url
  a.download = suggestedName
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  store.notify('success', `Downloaded ${suggestedName}`)
}

/** Write all dirty photos (or the given subset) using current settings. */
export async function writeDirtyFlow(onlyIds?: string[]): Promise<void> {
  const store = useStore.getState()
  const all = Object.values(store.photos).filter((p) => isDirty(p) && p.writeState !== 'writing')
  const targets = onlyIds ? all.filter((p) => onlyIds.includes(p.id)) : all
  if (targets.length === 0) {
    store.notify('info', 'Nothing to write — no photos with unsaved positions.')
    return
  }

  // Folders are opened read-only; escalate to readwrite now (user gesture).
  for (const sourceId of new Set(targets.map((p) => p.sourceId))) {
    const source = store.sources[sourceId]
    if (!source) continue
    if (source.dirHandle) {
      if (!(await ensurePermission(source.dirHandle, 'readwrite'))) {
        store.notify('error', `Write permission denied for "${source.name}" — nothing was written.`)
        return
      }
    } else {
      // Individually-picked files: permission is granted per file handle.
      for (const p of targets.filter((t) => t.sourceId === sourceId)) {
        if (p.fileHandle && !(await ensurePermission(p.fileHandle, 'readwrite'))) {
          store.notify('error', `Write permission denied for "${p.fileName}" — nothing was written.`)
          return
        }
      }
    }
  }

  store.markWriting(targets.map((p) => p.id))
  const sourcesMap = new Map(Object.entries(store.sources))
  const results = await writeBatch(
    targets,
    sourcesMap,
    {
      mode: store.settings.writeMode,
      backupOriginals: store.settings.backupOriginals,
      onProgress: (done, total, current) =>
        useStore.getState().setWriteProgress(done < total ? { done, total, current } : undefined),
    },
    (result) => useStore.getState().markWriteResult(result.photoId, result.ok, result.target, result.error)
  )

  const okCount = results.filter((r) => r.ok).length
  const failed = results.length - okCount
  useStore.getState().setWriteProgress(undefined)
  useStore
    .getState()
    .notify(
      failed ? 'error' : 'success',
      failed ? `Wrote ${okCount}/${results.length} — ${failed} failed (see photo badges)` : `Wrote GPS to ${okCount} file(s)`
    )
}
