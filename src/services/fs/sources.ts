import { photoKindFromName, isGpxName } from '../../domain/types'

export interface FoundFile {
  handle: FileSystemFileHandle
  relativePath: string
  name: string
}

export interface FolderScan {
  photos: FoundFile[]
  gpxFiles: FoundFile[]
  xmpFiles: FoundFile[]
  skipped: number
}

export interface ImportFilters {
  jpeg: boolean
  /** RAW formats and HEIC. */
  raw: boolean
  xmp: boolean
  /** MP4/MOV videos (GPS written via ExifTool into QuickTime metadata). */
  video: boolean
}

export const DEFAULT_IMPORT_FILTERS: ImportFilters = { jpeg: true, raw: true, xmp: true, video: true }

export function fsaSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
}

const IGNORED_DIRS = new Set(['@eaDir', '.thumbnails', '__MACOSX'])

/** Recursively enumerate photo, GPX and XMP files under a directory handle. */
export async function enumerateFolder(
  dir: FileSystemDirectoryHandle,
  filters: ImportFilters = DEFAULT_IMPORT_FILTERS,
  onProgress?: (count: number) => void
): Promise<FolderScan> {
  const result: FolderScan = { photos: [], gpxFiles: [], xmpFiles: [], skipped: 0 }
  let seen = 0

  async function walk(handle: FileSystemDirectoryHandle, prefix: string): Promise<void> {
    for await (const entry of handle.values()) {
      if (entry.name.startsWith('.')) continue
      if (entry.kind === 'directory') {
        if (IGNORED_DIRS.has(entry.name)) continue
        await walk(entry as FileSystemDirectoryHandle, `${prefix}${entry.name}/`)
      } else {
        const file = entry as FileSystemFileHandle
        const rel = `${prefix}${entry.name}`
        const kind = photoKindFromName(entry.name)
        if (kind) {
          const wanted = kind === 'jpeg' ? filters.jpeg : kind === 'video' ? filters.video : filters.raw
          if (wanted) result.photos.push({ handle: file, relativePath: rel, name: entry.name })
          else result.skipped++
        } else if (isGpxName(entry.name)) {
          result.gpxFiles.push({ handle: file, relativePath: rel, name: entry.name })
        } else if (entry.name.toLowerCase().endsWith('.xmp')) {
          if (filters.xmp) result.xmpFiles.push({ handle: file, relativePath: rel, name: entry.name })
          else result.skipped++
        } else {
          result.skipped++
        }
        if (++seen % 200 === 0) onProgress?.(seen)
      }
    }
  }

  await walk(dir, '')
  result.photos.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  return result
}

/**
 * Resolve the directory handle containing a file, walking relativePath from
 * the source root. Needed to place sidecars/backups next to originals.
 */
export async function directoryOf(
  root: FileSystemDirectoryHandle,
  relativePath: string
): Promise<FileSystemDirectoryHandle> {
  const parts = relativePath.split('/').slice(0, -1)
  let dir = root
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part)
  }
  return dir
}
