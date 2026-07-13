import { get, set, del } from 'idb-keyval'

export interface PersistedSource {
  id: string
  name: string
  color: string
  clockOffsetMs: number
  assumedTzOffsetMin: number
  dirHandle: FileSystemDirectoryHandle
}

const KEY = 'photo-geotagger.sources.v1'

/**
 * Best-effort persistence of directory handles across sessions. Chrome may
 * still require a user-gesture permission re-grant per handle; callers must
 * treat restore as an offer, never an invariant.
 */
export async function loadPersistedSources(): Promise<PersistedSource[]> {
  try {
    return ((await get(KEY)) as PersistedSource[] | undefined) ?? []
  } catch {
    return []
  }
}

export async function persistSources(sources: PersistedSource[]): Promise<void> {
  try {
    await set(KEY, sources)
  } catch {
    // IndexedDB unavailable (private mode etc.) — persistence is optional.
  }
}

export async function clearPersistedSources(): Promise<void> {
  try {
    await del(KEY)
  } catch {
    // ignore
  }
}

export interface PersistedGpx {
  name: string
  fileHandle: FileSystemFileHandle
}

const GPX_KEY = 'photo-geotagger.gpx.v1'

export async function loadPersistedGpx(): Promise<PersistedGpx[]> {
  try {
    return ((await get(GPX_KEY)) as PersistedGpx[] | undefined) ?? []
  } catch {
    return []
  }
}

/** Remember explicitly-picked GPX files (folder-discovered ones restore with their source). */
export async function rememberGpxHandles(handles: FileSystemFileHandle[]): Promise<void> {
  try {
    const existing = await loadPersistedGpx()
    const byName = new Map(existing.map((g) => [g.name, g]))
    for (const h of handles) byName.set(h.name, { name: h.name, fileHandle: h })
    await set(GPX_KEY, [...byName.values()])
  } catch {
    // persistence is best-effort
  }
}

/** (Re-)request permission for a handle. Needs a user gesture. */
export async function ensurePermission(
  handle: FileSystemHandle,
  mode: 'read' | 'readwrite' = 'read'
): Promise<boolean> {
  try {
    if ((await handle.queryPermission({ mode })) === 'granted') return true
    return (await handle.requestPermission({ mode })) === 'granted'
  } catch {
    return false
  }
}
