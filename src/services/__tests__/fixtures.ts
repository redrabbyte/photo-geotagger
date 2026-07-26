import piexif from 'piexifjs'

/** Minimal valid 1x1 JPEG. */
const TINY_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q=='

function b64ToBinaryString(b64: string): string {
  return atob(b64)
}

function binaryStringToBytes(str: string): Uint8Array {
  const bytes = new Uint8Array(str.length)
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff
  return bytes
}

/** Build a small JPEG with a chosen DateTimeOriginal (EXIF, no GPS). */
export function makeJpegWithExif(dateTimeOriginal: string): ArrayBuffer {
  const jpeg = b64ToBinaryString(TINY_JPEG_B64)
  const exifObj = {
    '0th': {},
    Exif: { [piexif.ExifIFD.DateTimeOriginal]: dateTimeOriginal },
    GPS: {},
  }
  const exifBytes = piexif.dump(exifObj)
  const out = piexif.insert(exifBytes, jpeg)
  const bytes = binaryStringToBytes(out)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/**
 * Minimal little-endian TIFF, laid out like a RAW: header → IFD0 (ExifIFD
 * pointer, optional pre-existing tags) → Exif IFD (DateTimeOriginal etc.)
 * → a "raw strip" marker whose position must never change.
 */
export function makeTiff(
  opts: { offsetTime?: boolean; ifd0Padding?: number; interop?: boolean } = {}
): Uint8Array<ArrayBuffer> {
  const chunks: Uint8Array[] = []
  let pos = 0
  const push = (b: Uint8Array) => {
    chunks.push(b)
    pos += b.length
  }
  const u16 = (n: number) => {
    const b = new Uint8Array(2)
    new DataView(b.buffer).setUint16(0, n, true)
    return b
  }
  const u32 = (n: number) => {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setUint32(0, n, true)
    return b
  }
  const ascii = (s: string) => new TextEncoder().encode(s)
  const entry = (tag: number, type: number, count: number, slot: Uint8Array) => {
    const padded = new Uint8Array(4)
    padded.set(slot)
    return [u16(tag), u16(type), u32(count), padded]
  }

  // Layout (computed sizes): header 8, IFD0 (1 entry) 2+12+4=18, the zero
  // padding camera files tend to leave behind it, ExifIFD (2 or 4 entries),
  // then values, then the strip marker.
  const ifd0Offset = 8
  const ifd0Padding = opts.ifd0Padding ?? 16
  const exifIfdOffset = ifd0Offset + 18 + ifd0Padding
  const exifEntryCount = (opts.offsetTime ? 4 : 2) + (opts.interop ? 1 : 0)
  const valuesOffset = exifIfdOffset + 2 + exifEntryCount * 12 + 4
  const dtoOffset = valuesOffset
  const digitizedOffset = dtoOffset + 20
  let next = digitizedOffset + 20
  let ot1 = 0
  let ot2 = 0
  if (opts.offsetTime) {
    ot1 = next
    next += 7
    ot2 = next
    next += 7
    next += 1 // even padding
  }

  // The interop IFD (when present) lives after the strip marker.
  const interopOffset = next + 26

  push(ascii('II'))
  push(u16(42))
  push(u32(ifd0Offset))
  // IFD0
  push(u16(1))
  entry(0x8769, 4, 1, u32(exifIfdOffset)).forEach(push)
  push(u32(0)) // next IFD
  if (ifd0Padding > 0) push(new Uint8Array(ifd0Padding))
  // Exif IFD
  push(u16(exifEntryCount))
  entry(0x9003, 2, 20, u32(dtoOffset)).forEach(push)
  entry(0x9004, 2, 20, u32(digitizedOffset)).forEach(push)
  if (opts.offsetTime) {
    entry(0x9011, 2, 7, u32(ot1)).forEach(push)
    entry(0x9012, 2, 7, u32(ot2)).forEach(push)
  }
  // 0xA005 InteropOffset — the directory Windows merges into the GPS namespace.
  // Points at the interop IFD appended after the strip marker below.
  if (opts.interop) entry(0xa005, 4, 1, u32(interopOffset)).forEach(push)
  push(u32(0))
  // values
  push(ascii('2026:07:04 17:30:00\0'))
  push(ascii('2026:07:04 17:30:00\0'))
  if (opts.offsetTime) {
    push(ascii('+09:00\0'))
    push(ascii('+09:00\0'))
    push(new Uint8Array(1))
  }
  if (pos !== next) throw new Error(`layout mismatch: ${pos} != ${next}`)
  push(ascii('RAW-STRIP-DATA-DO-NOT-MOVE'))
  if (opts.interop) {
    if (pos !== interopOffset) throw new Error(`interop layout: ${pos} != ${interopOffset}`)
    // InteropIndex "R98" (ASCII, inline) + InteropVersion "0100" (UNDEFINED).
    push(u16(2))
    entry(0x0001, 2, 4, ascii('R98\0')).forEach(push)
    entry(0x0002, 7, 4, ascii('0100')).forEach(push)
    push(u32(0))
  }

  const out = new Uint8Array(pos)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}

/** JPEG-shaped bytes: real SOI/EOI markers around filler, unique per marker. */
export function fakeJpeg(size: number, fill = 0x41): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(Math.max(8, size)).fill(fill)
  out.set([0xff, 0xd8, 0xff, 0xe0], 0)
  out.set([0xff, 0xd9], out.length - 2)
  return out
}

/**
 * A RAW laid out the way a camera does it: the small thumbnail in IFD1, the
 * real preview behind a SubIFD pointer (0x014A) and megabytes into the file —
 * i.e. exactly where a chunked EXIF parse cannot see it.
 */
export function makeRawWithPreview(
  opts: {
    previewBytes?: number
    thumbBytes?: number
    previewAt?: number
    thumbAt?: number
    /** Omit the SubIFD preview, leaving only IFD1's thumbnail. */
    noSubIfd?: boolean
    /** Point the SubIFD at bytes that are not a JPEG (a stale pointer). */
    breakSubIfd?: boolean
    bigEndian?: boolean
  } = {}
): { bytes: Uint8Array<ArrayBuffer>; preview: Uint8Array; thumb: Uint8Array } {
  const thumbAt = opts.thumbAt ?? 64 * 1024
  const previewAt = opts.previewAt ?? 2 * 1024 * 1024
  const thumb = fakeJpeg(opts.thumbBytes ?? 8 * 1024, 0x54)
  const preview = fakeJpeg(opts.previewBytes ?? 64 * 1024, 0x50)
  const total = previewAt + preview.length + 4096
  const bytes = new Uint8Array(total)
  const view = new DataView(bytes.buffer)
  const le = !opts.bigEndian
  const u16 = (at: number, n: number) => view.setUint16(at, n, le)
  const u32 = (at: number, n: number) => view.setUint32(at, n, le)

  const IFD0 = 8
  const IFD1 = 38
  const SUB = 80
  bytes.set(new TextEncoder().encode(le ? 'II' : 'MM'), 0)
  u16(2, 42)
  u32(4, IFD0)

  // IFD0: image size and the SubIFD pointer, then the chain to IFD1.
  u16(IFD0, 2)
  const rec = (at: number, tag: number, type: number, count: number, slot: number) => {
    u16(at, tag)
    u16(at + 2, type)
    u32(at + 4, count)
    if (type === 3) {
      u16(at + 8, slot) // SHORT values sit in the high half on big-endian too
      u16(at + 10, 0)
    } else {
      u32(at + 8, slot)
    }
  }
  rec(IFD0 + 2, 0x0100, 3, 1, 6000)
  rec(IFD0 + 14, 0x014a, 4, 1, opts.noSubIfd ? 0 : SUB)
  u32(IFD0 + 26, IFD1)

  // IFD1: the small thumbnail every JPEG-shaped parser finds.
  u16(IFD1, 3)
  rec(IFD1 + 2, 0x0201, 4, 1, thumbAt)
  rec(IFD1 + 14, 0x0202, 4, 1, thumb.length)
  rec(IFD1 + 26, 0x0103, 3, 1, 6)
  u32(IFD1 + 38, 0)

  // SubIFD: the full preview, far away.
  u16(SUB, 2)
  rec(SUB + 2, 0x0201, 4, 1, opts.breakSubIfd ? previewAt + 32 : previewAt)
  rec(SUB + 14, 0x0202, 4, 1, preview.length)
  u32(SUB + 26, 0)

  bytes.set(thumb, thumbAt)
  if (!opts.breakSubIfd) bytes.set(preview, previewAt)
  return { bytes, preview, thumb }
}
