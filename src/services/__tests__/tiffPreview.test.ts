// RAW thumbnails come from the JPEG preview embedded in the file. exifr cannot
// find it: exifr.thumbnail() looks only at IFD1's ThumbnailOffset/Length and
// reads them out of whatever chunk is loaded — so a Sony ARW, which keeps its
// preview behind a SubIFD pointer megabytes into the file, produced no tile at
// all while phone JPEGs were fine.
import { describe, it, expect } from 'vitest'
import { readTiffPreview } from '../exif/tiffReader'
import { fakeJpeg, makeRawWithPreview, makeTiff } from './fixtures'

/** Blob that records how much of itself was actually read. */
class CountingBlob extends Blob {
  read = 0
  slice(start?: number, end?: number, type?: string): Blob {
    const sliced = super.slice(start, end, type)
    // Only count what the caller pulls into memory, not the lazy slices.
    return new Proxy(sliced, {
      get: (target, prop, receiver) => {
        if (prop === 'arrayBuffer') {
          return async () => {
            this.read += target.size
            return target.arrayBuffer()
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
  }
}

const blobOf = (bytes: Uint8Array) => new CountingBlob([bytes.slice()])

describe('readTiffPreview', () => {
  it('finds the preview behind a SubIFD pointer, megabytes into the file', async () => {
    const raw = makeRawWithPreview()
    const found = await readTiffPreview(blobOf(raw.bytes))
    expect(found).toBeDefined()
    expect(found!.size).toBe(raw.preview.length)
    expect(new Uint8Array(await found!.arrayBuffer())).toEqual(raw.preview)
    expect(found!.type).toBe('image/jpeg')
  })

  it('reads kilobytes, not the megabytes the file is long', async () => {
    const raw = makeRawWithPreview({ previewAt: 8 * 1024 * 1024 })
    const blob = blobOf(raw.bytes)
    const found = await readTiffPreview(blob)
    expect(found!.size).toBe(raw.preview.length)
    // Directories and the SOI check only — the preview itself stays a lazy
    // slice the caller decodes, and the RAW's pixel data is never touched.
    expect(blob.read).toBeLessThan(64 * 1024)
    expect(blob.size).toBeGreaterThan(8 * 1024 * 1024)
  })

  it('falls back to the IFD1 thumbnail when there is no SubIFD preview', async () => {
    const raw = makeRawWithPreview({ noSubIfd: true })
    const found = await readTiffPreview(blobOf(raw.bytes))
    expect(new Uint8Array(await found!.arrayBuffer())).toEqual(raw.thumb)
  })

  it('ignores a pointer that does not lead to a JPEG', async () => {
    // A stale/garbage offset must not produce a broken image: verify the SOI
    // marker first, then fall back to the candidate that does check out.
    const raw = makeRawWithPreview({ breakSubIfd: true })
    const found = await readTiffPreview(blobOf(raw.bytes))
    expect(new Uint8Array(await found!.arrayBuffer())).toEqual(raw.thumb)
  })

  it('prefers a preview that is cheap to decode over a full-resolution one', async () => {
    // 20 MB "JpgFromRaw" in the SubIFD, 900 kB preview in IFD1: take the small
    // one — it is plenty for a 320px tile and a side panel.
    const raw = makeRawWithPreview({ previewBytes: 20 * 1024 * 1024, thumbBytes: 900 * 1024 })
    const found = await readTiffPreview(blobOf(raw.bytes))
    expect(found!.size).toBe(raw.thumb.length)
  })

  it('takes the only preview there is, even oversized', async () => {
    const raw = makeRawWithPreview({ previewBytes: 12 * 1024 * 1024, thumbBytes: 8 })
    const found = await readTiffPreview(blobOf(raw.bytes))
    expect(found!.size).toBe(raw.preview.length)
  })

  it('handles big-endian files', async () => {
    const raw = makeRawWithPreview({ bigEndian: true })
    const found = await readTiffPreview(blobOf(raw.bytes))
    expect(new Uint8Array(await found!.arrayBuffer())).toEqual(raw.preview)
  })

  it('returns nothing for files without a preview or without TIFF structure', async () => {
    expect(await readTiffPreview(blobOf(makeTiff()))).toBeUndefined()
    expect(await readTiffPreview(blobOf(fakeJpeg(4096)))).toBeUndefined()
    expect(await readTiffPreview(new Blob([new Uint8Array(64)]))).toBeUndefined()
  })
})
