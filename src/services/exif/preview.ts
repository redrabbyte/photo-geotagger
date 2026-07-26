/**
 * Embedded preview extraction, shared by the thumbnail worker and the
 * inspector's detail view.
 *
 * RAW files keep a JPEG preview inside them; finding it reliably is the whole
 * job here. `exifr.thumbnail()` only reads IFD1's ThumbnailOffset/Length out of
 * the chunk it happens to have loaded, which covers a JPEG's small thumbnail and
 * nothing else — a Sony ARW keeps its preview in a SubIFD, other RAWs keep it
 * megabytes into the file. So TIFF-based files are read by following their own
 * pointers, and exifr stays as the fallback for containers that are not TIFF
 * (RAF, CR3, HEIC).
 */
import exifr from 'exifr'
import type { PhotoKind } from '../../domain/types'
import { readTiffPreview } from './tiffReader'

/**
 * Accept only real JPEG bytes. A chunked parse can hand back a range that was
 * never loaded — passing those on produces a broken image rather than a visible
 * failure, which is worse than no preview at all.
 */
function jpegBlob(bytes: unknown): Blob | undefined {
  if (!(bytes instanceof Uint8Array) || bytes.length < 1024) return undefined
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return undefined
  return new Blob([bytes as BlobPart], { type: 'image/jpeg' })
}

/** The embedded preview of a photo, or undefined when it has none we can find. */
export async function embeddedPreview(file: File, kind: PhotoKind): Promise<Blob | undefined> {
  if (kind === 'video') return undefined
  if (kind === 'jpeg') return jpegBlob(await exifr.thumbnail(file).catch(() => undefined))

  // Ranged reads along the file's own directories: no reach limit, and it sees
  // the SubIFD previews exifr never looks at.
  const targeted = await readTiffPreview(file).catch(() => undefined)
  if (targeted) return targeted

  const chunked = jpegBlob(await exifr.thumbnail(file).catch(() => undefined))
  if (chunked) return chunked
  // Last resort for non-TIFF containers: parse the whole buffer. Previews are
  // only requested for what is (nearly) visible, so this reads a handful of
  // files, not the whole folder.
  return jpegBlob(await exifr.thumbnail(await file.arrayBuffer()).catch(() => undefined))
}
