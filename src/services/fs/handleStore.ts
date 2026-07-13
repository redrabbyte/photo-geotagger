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

/** (Re-)request permission for a handle. Needs a user gesture. */
export async function ensurePermission(
  handle: FileSystemDirectoryHandle,
  mode: 'read' | 'readwrite' = 'read'
): Promise<boolean> {
  try {
    if ((await handle.queryPermission({ mode })) === 'granted') return true
    return (await handle.requestPermission({ mode })) === 'granted'
  } catch {
    return false
  }
}
