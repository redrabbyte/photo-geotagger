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
export function makeTiff(opts: { offsetTime?: boolean } = {}): Uint8Array<ArrayBuffer> {
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

  // Layout (computed sizes): header 8, IFD0 (1 entry) 2+12+4=18,
  // ExifIFD (2 or 4 entries), then values, then the strip marker.
  const ifd0Offset = 8
  const exifIfdOffset = ifd0Offset + 18
  const exifEntryCount = opts.offsetTime ? 4 : 2
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

  push(ascii('II'))
  push(u16(42))
  push(u32(ifd0Offset))
  // IFD0
  push(u16(1))
  entry(0x8769, 4, 1, u32(exifIfdOffset)).forEach(push)
  push(u32(0)) // next IFD
  // Exif IFD
  push(u16(exifEntryCount))
  entry(0x9003, 2, 20, u32(dtoOffset)).forEach(push)
  entry(0x9004, 2, 20, u32(digitizedOffset)).forEach(push)
  if (opts.offsetTime) {
    entry(0x9011, 2, 7, u32(ot1)).forEach(push)
    entry(0x9012, 2, 7, u32(ot2)).forEach(push)
  }
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

  const out = new Uint8Array(pos)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}
