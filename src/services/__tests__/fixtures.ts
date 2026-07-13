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
