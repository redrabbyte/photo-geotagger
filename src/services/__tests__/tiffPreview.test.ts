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

/**
 * Byte-exact comparison. expect().toEqual() walks typed arrays element by
 * element and builds a diff, which takes seconds on a preview-sized array —
 * enough to blow the test timeout on a slow runner.
 */
async function expectBytes(actual: Blob | undefined, expected: Uint8Array): Promise<void> {
  expect(actual).toBeDefined()
  expect(actual!.size).toBe(expected.length)
  const bytes = new Uint8Array(await actual!.arrayBuffer())
  let differsAt = -1
  for (let i = 0; i < expected.length; i++) {
    if (bytes[i] !== expected[i]) {
      differsAt = i
      break
    }
  }
  expect(differsAt, differsAt < 0 ? '' : `bytes differ at ${differsAt}`).toBe(-1)
}

describe('readTiffPreview', () => {
  it('finds the preview behind a SubIFD pointer, megabytes into the file', async () => {
    const raw = makeRawWithPreview()
    const found = await readTiffPreview(blobOf(raw.bytes))
    await expectBytes(found, raw.preview)
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
    await expectBytes(await readTiffPreview(blobOf(raw.bytes)), raw.thumb)
  })

  it('ignores a pointer that does not lead to a JPEG', async () => {
    // A stale/garbage offset must not produce a broken image: verify the SOI
    // marker first, then fall back to the candidate that does check out.
    const raw = makeRawWithPreview({ breakSubIfd: true })
    await expectBytes(await readTiffPreview(blobOf(raw.bytes)), raw.thumb)
  })

  it('prefers a preview that is cheap to decode over a full-resolution one', async () => {
    // 6 MB "JpgFromRaw" in the SubIFD, 300 kB preview in IFD1: take the small
    // one — it is plenty for a 320px tile and a side panel.
    const raw = makeRawWithPreview({ previewBytes: 6 * 1024 * 1024, thumbBytes: 300 * 1024 })
    const found = await readTiffPreview(blobOf(raw.bytes))
    expect(found!.size).toBe(raw.thumb.length)
  })

  it('takes the only preview there is, even oversized', async () => {
    const raw = makeRawWithPreview({ previewBytes: 6 * 1024 * 1024, thumbBytes: 8 })
    const found = await readTiffPreview(blobOf(raw.bytes))
    expect(found!.size).toBe(raw.preview.length)
  })

  it('handles big-endian files', async () => {
    const raw = makeRawWithPreview({ bigEndian: true })
    await expectBytes(await readTiffPreview(blobOf(raw.bytes)), raw.preview)
  })

  it('returns nothing for files without a preview or without TIFF structure', async () => {
    expect(await readTiffPreview(blobOf(makeTiff()))).toBeUndefined()
    expect(await readTiffPreview(blobOf(fakeJpeg(4096)))).toBeUndefined()
    expect(await readTiffPreview(new Blob([new Uint8Array(64)]))).toBeUndefined()
  })
})
