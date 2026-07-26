/**
 * Targeted GPS reader for TIFF-based RAWs, for coordinates a chunked EXIF
 * parser cannot reach.
 *
 * exifr reads a File in chunks and fetches a window around the offset it seeks
 * to. In a RAW, IFD0's GPSInfo pointer can aim megabytes away — at a block
 * appended by another tool, or by an older version of this app — and the parse
 * then yields no position even though the file carries one.
 *
 * This walks the pointers itself with small ranged reads: the TIFF header, the
 * IFD0 table, and (only when a GPSInfo tag is actually present) the GPS IFD
 * with its values. Files without GPS cost two tiny reads and bail; non-TIFF
 * input bails on the magic number.
 */
import type { GeoPoint } from '../../domain/types'

/** Reads small ranges from a Blob, keeping generous windows for reuse. */
class RangeReader {
  private blob: Blob
  private windows: Array<{ start: number; bytes: Uint8Array }> = []
  constructor(blob: Blob) {
    this.blob = blob
  }

  async bytes(start: number, length: number): Promise<Uint8Array | undefined> {
    if (start < 0 || length <= 0 || start + length > this.blob.size) return undefined
    for (const w of this.windows) {
      if (start >= w.start && start + length <= w.start + w.bytes.length) {
        return w.bytes.subarray(start - w.start, start - w.start + length)
      }
    }
    // Over-read so the table and the values behind it come in one round trip.
    const span = Math.min(this.blob.size - start, Math.max(length, 8192))
    const bytes = new Uint8Array(await this.blob.slice(start, start + span).arrayBuffer())
    if (bytes.length < length) return undefined
    this.windows.push({ start, bytes })
    return bytes.subarray(0, length)
  }

  async view(start: number, length: number): Promise<DataView | undefined> {
    const bytes = await this.bytes(start, length)
    return bytes && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
}

interface RawEntry {
  tag: number
  type: number
  count: number
  /** Raw 4-byte value slot: an inline value or an offset. */
  slot: number
  slotOffset: number
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }

async function readEntries(
  reader: RangeReader,
  offset: number,
  little: boolean
): Promise<RawEntry[] | undefined> {
  const head = await reader.view(offset, 2)
  if (!head) return undefined
  const count = head.getUint16(0, little)
  if (count === 0 || count > 512) return undefined
  const table = await reader.view(offset + 2, count * 12)
  if (!table) return undefined
  const entries: RawEntry[] = []
  for (let i = 0; i < count; i++) {
    const at = i * 12
    entries.push({
      tag: table.getUint16(at, little),
      type: table.getUint16(at + 2, little),
      count: table.getUint32(at + 4, little),
      slot: table.getUint32(at + 8, little),
      slotOffset: offset + 2 + at + 8,
    })
  }
  return entries
}

/** Values ≤ 4 bytes live in the slot itself; larger ones at the offset it holds. */
async function readValue(reader: RangeReader, entry: RawEntry): Promise<DataView | undefined> {
  const size = (TYPE_SIZE[entry.type] ?? 0) * entry.count
  if (size === 0) return undefined
  if (size <= 4) return reader.view(entry.slotOffset, size)
  return reader.view(entry.slot, size)
}

/** Three RATIONALs (degrees, minutes, seconds) → signed decimal degrees. */
function dmsToDegrees(view: DataView, little: boolean, negative: boolean): number | undefined {
  let degrees = 0
  for (let i = 0; i < 3; i++) {
    const num = view.getUint32(i * 8, little)
    const den = view.getUint32(i * 8 + 4, little)
    if (den === 0) return undefined
    degrees += num / den / 60 ** i
  }
  return negative ? -degrees : degrees
}

/** 'S' / 'W' hemisphere references flip the sign of the decimal degrees. */
async function refIsNegative(
  reader: RangeReader,
  entry: RawEntry | undefined,
  negativeChars: string
): Promise<boolean> {
  if (!entry) return false
  const view = await readValue(reader, entry)
  if (!view || view.byteLength === 0) return false
  return negativeChars.includes(String.fromCharCode(view.getUint8(0)).toUpperCase())
}

export interface TiffProbe {
  /** Coordinates, when the file carries a usable GPS IFD. */
  gps?: GeoPoint
  /**
   * The file has an Interoperability IFD (ExifIFD tag 0xA005). Windows' RAW
   * codec merges that directory into the GPS tag namespace, where Interop
   * 0x0001/0x0002 collide with GPSLatitudeRef/GPSLatitude — Explorer then shows
   * "R98" as the hemisphere and no latitude at all. Removing it is the fix.
   */
  hasInterop: boolean
}

/**
 * Read GPS coordinates from a TIFF-based file by following its pointers.
 * Undefined when the file is not TIFF, has no GPS IFD, or the values are
 * unusable — callers keep whatever their EXIF parser found.
 */
export async function readTiffGps(blob: Blob): Promise<GeoPoint | undefined> {
  return (await probeTiff(blob)).gps
}

/** GPS plus the Interop-IFD marker, from one pass of small ranged reads. */
export async function probeTiff(blob: Blob): Promise<TiffProbe> {
  const nothing: TiffProbe = { hasInterop: false }
  try {
    const reader = new RangeReader(blob)
    const header = await reader.view(0, 8)
    if (!header) return nothing
    const order = header.getUint16(0)
    if (order !== 0x4949 && order !== 0x4d4d) return nothing
    const little = order === 0x4949
    if (header.getUint16(2, little) !== 42) return nothing

    const ifd0 = await readEntries(reader, header.getUint32(4, little), little)
    // The Exif IFD usually sits in the window already fetched for IFD0, so
    // this costs no extra round trip in practice.
    const exifPointer = ifd0?.find((e) => e.tag === 0x8769)
    const exif = exifPointer ? await readEntries(reader, exifPointer.slot, little) : undefined
    const hasInterop = exif?.some((e) => e.tag === 0xa005 && e.slot > 0) ?? false

    const gpsPointer = ifd0?.find((e) => e.tag === 0x8825)
    if (!gpsPointer) return { hasInterop }

    const gps = await readEntries(reader, gpsPointer.slot, little)
    if (!gps) return { hasInterop }
    const latEntry = gps.find((e) => e.tag === 0x0002)
    const lonEntry = gps.find((e) => e.tag === 0x0004)
    if (!latEntry || !lonEntry || latEntry.count !== 3 || lonEntry.count !== 3) return { hasInterop }

    const latView = await readValue(reader, latEntry)
    const lonView = await readValue(reader, lonEntry)
    if (!latView || !lonView) return { hasInterop }
    const latRef = gps.find((e) => e.tag === 0x0001) // GPSLatitudeRef: 'N' | 'S'
    const lonRef = gps.find((e) => e.tag === 0x0003) // GPSLongitudeRef: 'E' | 'W'
    const lat = dmsToDegrees(latView, little, await refIsNegative(reader, latRef, 'S'))
    const lon = dmsToDegrees(lonView, little, await refIsNegative(reader, lonRef, 'W'))
    if (lat === undefined || lon === undefined) return { hasInterop }
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return { hasInterop }
    }

    let ele: number | undefined
    const altEntry = gps.find((e) => e.tag === 0x0006)
    if (altEntry) {
      const altView = await readValue(reader, altEntry)
      if (altView && altView.byteLength >= 8) {
        const den = altView.getUint32(4, little)
        if (den !== 0) {
          const value = altView.getUint32(0, little) / den
          // GPSAltitudeRef is a BYTE, not a character: 1 means below sea level.
          const refEntry = gps.find((e) => e.tag === 0x0005)
          const refView = refEntry ? await readValue(reader, refEntry) : undefined
          const below = refView !== undefined && refView.byteLength > 0 && refView.getUint8(0) === 1
          ele = below ? -value : value
        }
      }
    }
    return { gps: { lat, lon, ele }, hasInterop }
  } catch {
    // unreadable range, malformed structure — nothing to contribute
    return nothing
  }
}
