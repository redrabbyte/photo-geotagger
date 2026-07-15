import type { Photo, Source, Track } from '../domain/types'
import { isDirty } from '../domain/types'
import { parseGpx, GpxParseError } from '../domain/parseGpx'
import { enumerateFolder, fsaSupported, type FoundFile } from './fs/sources'
import { readGpsFromXmp, readTimeFromXmp } from '../domain/xmp'
import {
  ensurePermission,
  loadPersistedGpx,
  loadPersistedSources,
  persistSources,
  rememberGpxHandles,
} from './fs/handleStore'
import { ScanClient } from './scanClient'
import {
  recommendedExiftoolPool,
  setExiftoolPoolSize,
  timeCorrectionFor,
  warmupExiftool,
  writeBatch,
  writeTimeBatch,
} from './writePipeline'
import {
  useStore,
  nextSourceId,
  nextTrackId,
  makePhotoRecord,
  SOURCE_COLORS,
  type AppSettings,
  type ScanUpdate,
} from '../state/store'

/**
 * Safe-mode writes are pure FSA I/O: the per-file cost is fixed browser
 * round-trip latency (handle lookups, safe-browsing check on close), so
 * parallelism hides it almost linearly. ExifTool mode keeps ~3 requests in
 * flight per worker so each worker's queue coalesces into one Perl run
 * (the workers batch internally), bounded to limit RAW buffers in memory.
 */
function writeConcurrency(settings: AppSettings): number {
  if (settings.writeMode === 'exiftool') {
    return Math.min(8, recommendedExiftoolPool(settings.parallelExiftool) * 3)
  }
  return 6
}

/**
 * Pre-boot the ExifTool workers in the background so the first RAW write
 * skips the ~3 s cold start. Call when the user switches to ExifTool mode.
 */
export function prepareExiftool(): void {
  const settings = useStore.getState().settings
  if (settings.writeMode !== 'exiftool') return
  setExiftoolPoolSize(recommendedExiftoolPool(settings.parallelExiftool))
  warmupExiftool()
}

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
    // Each flush re-renders every photo-subscribed component; during a large
    // scan the flush rate dominates main-thread cost, so keep it low.
    flushTimer = setTimeout(() => {
      flushTimer = undefined
      flushUpdates()
    }, 300)
  }
}

function getScanClient(): ScanClient {
  if (!scanClient) {
    scanClient = new ScanClient({
      onMeta: (id, meta, sizeBytes, lastModified) => {
        queueUpdate({ id, kind: 'meta', meta, sizeBytes, lastModified })
        // The user is looking at this photo right now: skip the batch delay.
        if (urgentMetaIds.delete(id)) {
          if (flushTimer) {
            clearTimeout(flushTimer)
            flushTimer = undefined
          }
          flushUpdates()
        }
      },
      onThumb: (id, url) => {
        // Thumbnails are on-demand and user-facing: show them immediately.
        queueUpdate({ id, kind: 'thumb', url })
        if (flushTimer) {
          clearTimeout(flushTimer)
          flushTimer = undefined
        }
        flushUpdates()
      },
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

const thumbsRequested = new Set<string>()
const urgentMetaIds = new Set<string>()

let writeStopRequested = false

/** Stop the running export after the file currently being written finishes. */
export function requestWriteStop(): void {
  writeStopRequested = true
}

/** Progress reporter with a continuously updated time estimate. */
function makeProgressReporter() {
  const startedAt = Date.now()
  return (done: number, total: number, current: string) => {
    const etaMs = done > 0 ? ((Date.now() - startedAt) / done) * (total - done) : undefined
    useStore.getState().setWriteProgress(done < total ? { done, total, current, etaMs } : undefined)
  }
}

/**
 * Pull a not-yet-scanned photo's metadata to the front of the queue —
 * clicking a photo shows its time/GPS immediately even mid-import.
 */
export function ensureMeta(id: string): void {
  const p = useStore.getState().photos[id]
  if (!p || p.scanState !== 'pending' || !p.fileHandle) return
  urgentMetaIds.add(id)
  getScanClient().enqueue([{ id: p.id, handle: p.fileHandle, kind: p.kind }], true)
}

/**
 * Request thumbnails for the given photos (visible filmstrip items, the
 * inspector photo). Thumbnails are generated lazily so metadata scanning of
 * a large folder finishes first.
 */
export function ensureThumbs(ids: string[], priority = false): void {
  const store = useStore.getState()
  const jobs = []
  for (const id of ids) {
    // Priority requests re-enqueue even if already queued normally — the
    // selected photo must not wait behind the regular queue.
    if (thumbsRequested.has(id) && !priority) continue
    const p = store.photos[id]
    if (!p || p.thumbUrl || !p.fileHandle) continue
    thumbsRequested.add(id)
    jobs.push({ id: p.id, handle: p.fileHandle, kind: p.kind })
  }
  if (jobs.length > 0) getScanClient().enqueueThumbs(jobs, priority)
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

/**
 * Fill in file sizes/mtimes in the background. getFile() is only a stat, but
 * on Android's SAF each call is slow — blocking ingestion on it made large
 * folders appear to do nothing at all. Results stream in as batched updates.
 */
function statPhotosInBackground(photos: Photo[]): void {
  void (async () => {
    const CHUNK = 50
    for (let i = 0; i < photos.length; i += CHUNK) {
      await Promise.all(
        photos.slice(i, i + CHUNK).map(async (p) => {
          try {
            const file = await p.fileHandle!.getFile()
            queueUpdate({ id: p.id, kind: 'stat', sizeBytes: file.size, lastModified: file.lastModified })
          } catch {
            // stat failed — the scan worker will retry via getFile anyway
          }
        })
      )
    }
  })()
}

/** Read paired .xmp sidecars and attach their GPS to the photos. */
function readSidecarsInBackground(photos: Photo[]): void {
  void (async () => {
    for (const p of photos) {
      if (!p.sidecarHandle) continue
      try {
        const text = await (await p.sidecarHandle.getFile()).text()
        const gps = readGpsFromXmp(text)
        const time = readTimeFromXmp(text)
        if (gps || time) queueUpdate({ id: p.id, kind: 'sidecar', gps, time })
      } catch {
        // unreadable sidecar — photo simply keeps its embedded GPS (if any)
      }
    }
  })()
}

async function ingestSource(source: Source): Promise<void> {
  const store = useStore.getState()
  if (!source.dirHandle) return
  store.setScanning(true)
  try {
    const scan = await enumerateFolder(source.dirHandle, store.settings.importFilters)

    // Pair .xmp sidecars with their photo by base path (DSC01.xmp ~ DSC01.ARW).
    const xmpByBase = new Map<string, FoundFile>()
    for (const x of scan.xmpFiles) {
      const dot = x.relativePath.lastIndexOf('.')
      xmpByBase.set(x.relativePath.slice(0, dot).toLowerCase(), x)
    }

    const photos: Photo[] = []
    for (const f of scan.photos) {
      const record = makePhotoRecord(source.id, f.handle, f.relativePath, f.name, 0, 0)
      if (record) {
        const dot = f.relativePath.lastIndexOf('.')
        const sidecar = xmpByBase.get(f.relativePath.slice(0, dot).toLowerCase())
        if (sidecar) record.sidecarHandle = sidecar.handle
        photos.push(record)
      }
    }
    // Photos appear immediately; scanning starts immediately; stats stream in.
    store.addSource(source, photos)
    if (photos.length > 0) {
      getScanClient().enqueue(photos.map((p) => ({ id: p.id, handle: p.fileHandle!, kind: p.kind })))
      statPhotosInBackground(photos)
      readSidecarsInBackground(photos)
    } else {
      store.setScanning(false)
    }

    // GPX files found inside the folder are loaded as tracks automatically.
    store.addPendingGpx(scan.gpxFiles.map((g) => g.name))
    for (const gpx of scan.gpxFiles) {
      try {
        const text = await (await gpx.handle.getFile()).text()
        const tracks = parseGpx(text, gpx.name, () => nextTrackId())
        useStore.getState().addTracks(tracks)
      } catch (err) {
        store.notify('error', err instanceof GpxParseError ? err.message : `Failed to load ${gpx.name}`)
      } finally {
        useStore.getState().removePendingGpx(gpx.name)
      }
    }

    store.notify(
      'info',
      `${source.name}: ${photos.length} photos${scan.gpxFiles.length ? `, ${scan.gpxFiles.length} GPX file(s)` : ''}`
    )
  } catch (err) {
    store.setScanning(false)
    throw err
  }
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
  // Show list entries immediately; each resolves into a real track when read.
  store.addPendingGpx(handles.map((h) => h.name))
  const loaded: FileSystemFileHandle[] = []
  for (const handle of handles) {
    try {
      const file = await handle.getFile()
      const tracks: Track[] = parseGpx(await file.text(), file.name, () => nextTrackId())
      useStore.getState().addTracks(tracks)
      loaded.push(handle)
      store.notify('success', `Loaded ${file.name}: ${tracks.reduce((n, t) => n + t.points.length, 0)} points`)
    } catch (err) {
      store.notify('error', err instanceof GpxParseError ? err.message : `Failed to parse ${handle.name}`)
    } finally {
      useStore.getState().removePendingGpx(handle.name)
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
      store.addPendingGpx([p.name])
      try {
        const file = await p.fileHandle.getFile()
        const tracks = parseGpx(await file.text(), file.name, () => nextTrackId())
        useStore.getState().addTracks(tracks)
        store.notify('success', `Restored ${file.name}`)
      } catch (err) {
        store.notify('error', err instanceof GpxParseError ? err.message : `Failed to restore ${p.name}`)
      } finally {
        useStore.getState().removePendingGpx(p.name)
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
/** Photos whose file needs a clock/timezone fix written (independent of GPS). */
export function timeFixTargets(): Photo[] {
  const store = useStore.getState()
  return Object.values(store.photos).filter((p) => {
    if (!p.fileHandle || p.writeState === 'writing') return false
    const source = store.sources[p.sourceId]
    return source !== undefined && timeCorrectionFor(p, source) !== undefined
  })
}

/**
 * Write ONLY the corrected capture time into every file that needs it —
 * e.g. after calibrating a source's clock — regardless of GPS assignments.
 */
export async function writeTimesFlow(onlyIds?: string[]): Promise<void> {
  const store = useStore.getState()
  const all = timeFixTargets()
  const targets = onlyIds ? all.filter((p) => onlyIds.includes(p.id)) : all
  if (targets.length === 0) {
    store.notify('info', 'No files need a time correction.')
    return
  }

  for (const sourceId of new Set(targets.map((p) => p.sourceId))) {
    const source = store.sources[sourceId]
    if (!source) continue
    if (source.dirHandle) {
      if (!(await ensurePermission(source.dirHandle, 'readwrite'))) {
        store.notify('error', `Write permission denied for "${source.name}" — nothing was written.`)
        return
      }
    } else {
      for (const p of targets.filter((t) => t.sourceId === sourceId)) {
        if (p.fileHandle && !(await ensurePermission(p.fileHandle, 'readwrite'))) {
          store.notify('error', `Write permission denied for "${p.fileName}" — nothing was written.`)
          return
        }
      }
    }
  }

  const timeConcurrency = writeConcurrency(store.settings)
  setExiftoolPoolSize(recommendedExiftoolPool(store.settings.parallelExiftool))
  writeStopRequested = false
  store.markWriting(targets.map((p) => p.id))
  const results = await writeTimeBatch(
    targets,
    new Map(Object.entries(store.sources)),
    {
      mode: store.settings.writeMode,
      backupOriginals: store.settings.backupOriginals,
      concurrency: timeConcurrency,
      shouldStop: () => writeStopRequested,
      onProgress: makeProgressReporter(),
    },
    (result) =>
      useStore.getState().markTimeWriteResult(result.photoId, result.ok, result.error, result.timeCorrection, result.target)
  )

  useStore.getState().resetWriting(targets.map((p) => p.id))
  const okCount = results.filter((r) => r.ok).length
  const failed = results.length - okCount
  const stopped = writeStopRequested && results.length < targets.length
  useStore.getState().setWriteProgress(undefined)
  useStore
    .getState()
    .notify(
      failed ? 'error' : 'success',
      (stopped ? `Stopped — ` : '') +
        (failed
          ? `Corrected times in ${okCount}/${results.length} — ${failed} failed (see photo badges)`
          : `Corrected times in ${okCount} file(s)`)
    )
}

/** GPS write targets: assigned photos, plus sidecar-GPS embeds when enabled. */
export function gpsWriteTargets(): Photo[] {
  const store = useStore.getState()
  const embed = store.settings.writeMode === 'exiftool' && store.settings.embedSidecarGps
  return Object.values(store.photos).filter((p) => {
    if (p.writeState === 'writing') return false
    if (isDirty(p)) return true
    return embed && p.sidecarGps !== undefined && !p.assignment && p.writeState !== 'written'
  })
}

export async function writeDirtyFlow(onlyIds?: string[]): Promise<void> {
  const store = useStore.getState()
  const all = gpsWriteTargets()
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

  const gpsConcurrency = writeConcurrency(store.settings)
  setExiftoolPoolSize(recommendedExiftoolPool(store.settings.parallelExiftool))
  writeStopRequested = false
  store.markWriting(targets.map((p) => p.id))
  const sourcesMap = new Map(Object.entries(store.sources))
  const results = await writeBatch(
    targets,
    sourcesMap,
    {
      mode: store.settings.writeMode,
      backupOriginals: store.settings.backupOriginals,
      writeCorrectedTime: store.settings.writeCorrectedTime,
      embedSidecarGps: store.settings.writeMode === 'exiftool' && store.settings.embedSidecarGps,
      concurrency: gpsConcurrency,
      shouldStop: () => writeStopRequested,
      onProgress: makeProgressReporter(),
    },
    (result) =>
      useStore
        .getState()
        .markWriteResult(result.photoId, result.ok, result.target, result.error, result.timeCorrection)
  )

  useStore.getState().resetWriting(targets.map((p) => p.id))
  const okCount = results.filter((r) => r.ok).length
  const failed = results.length - okCount
  const stopped = writeStopRequested && results.length < targets.length
  useStore.getState().setWriteProgress(undefined)
  useStore
    .getState()
    .notify(
      failed ? 'error' : 'success',
      (stopped ? `Stopped — ` : '') +
        (failed ? `Wrote ${okCount}/${results.length} — ${failed} failed (see photo badges)` : `Wrote GPS to ${okCount} file(s)`)
    )
}
