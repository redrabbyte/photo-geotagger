/**
 * Pure-JS metadata writer for TIFF-based RAW files (ARW, NEF, CR2, DNG…) —
 * the "experimental fast RAW" path.
 *
 * TIFF is a web of absolute file offsets (IFD tables, tag values, maker
 * notes, preview images, raw strips). Like the MP4 writer, this one never
 * recalculates any of them — it only ever appends and repoints:
 *
 * - Adding the GPS IFD: the GPS data is appended at the end of the file. If
 *   IFD0 already has a GPSInfo tag, only its 4-byte value slot is patched;
 *   otherwise a copy of IFD0 with one extra entry is appended too and the
 *   4-byte IFD0 pointer in the TIFF header is repointed at it. Every copied
 *   entry still references its original value bytes, which never move.
 * - Correcting the capture time: DateTimeOriginal/DateTimeDigitized are
 *   fixed-size ASCII values patched in place. Missing OffsetTime* tags are
 *   added by appending an extended copy of the Exif IFD and repointing the
 *   ExifIFD entry's value slot.
 *
 * The old tables become dead bytes — a few hundred bytes of padding, the
 * same trade the MP4 writer makes with its freed moov. Anything the parser
 * does not fully understand throws TiffStructureError and the caller falls
 * back to the ExifTool path; HEIC and non-TIFF RAW brands (RAF, CR3, RW2,
 * ORF) fail the magic check and fall back the same way.
 */
import type { GeoPoint } from '../../domain/types'
import { degToDmsRationals } from '../../domain/gpsMath'
import { formatExifDateTime, formatTzOffset, type TimeCorrection } from './writeJpeg'

/** Structure this writer does not handle — callers fall back to ExifTool. */
export class TiffStructureError extends Error {}

export interface TiffEdit {
  gps?: GeoPoint
  time?: TimeCorrection
}

// TIFF tag ids
const TAG_EXIF_IFD = 0x8769
const TAG_GPS_IFD = 0x8825
const TAG_DATETIME_ORIGINAL = 0x9003
const TAG_DATETIME_DIGITIZED = 0x9004
const TAG_OFFSET_TIME_ORIGINAL = 0x9011
const TAG_OFFSET_TIME_DIGITIZED = 0x9012

// TIFF field types
const T_BYTE = 1
const T_ASCII = 2
const T_LONG = 4
const T_RATIONAL = 5

interface Entry {
  tag: number
  type: number
  count: number
  /** File offset of this entry's 12-byte record. */
  recordOffset: number
  /** The raw 4-byte value slot (inline value or offset), as u32. */
  slot: number
}

interface Ifd {
  offset: number
  entries: Entry[]
  /** File offset of the 4-byte next-IFD pointer. */
  nextPtrOffset: number
}

interface Patch {
  offset: number
  bytes: Uint8Array
}

class TiffFile {
  readonly bytes: Uint8Array
  readonly view: DataView
  readonly little: boolean

  constructor(bytes: Uint8Array) {
    this.bytes = bytes
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (bytes.byteLength < 8) throw new TiffStructureError('File too small for a TIFF header')
    const order = this.view.getUint16(0)
    if (order === 0x4949) this.little = true
    else if (order === 0x4d4d) this.little = false
    else throw new TiffStructureError('Not a TIFF container')
    if (this.u16(2) !== 42) throw new TiffStructureError('Not a TIFF container (bad magic)')
  }

  u16(o: number): number {
    return this.view.getUint16(o, this.little)
  }
  u32(o: number): number {
    return this.view.getUint32(o, this.little)
  }

  readIfd(offset: number): Ifd {
    if (offset < 8 || offset + 2 > this.bytes.byteLength) {
      throw new TiffStructureError('IFD offset out of range')
    }
    const count = this.u16(offset)
    if (count === 0 || count > 1000 || offset + 2 + count * 12 + 4 > this.bytes.byteLength) {
      throw new TiffStructureError('Implausible IFD entry count')
    }
    const entries: Entry[] = []
    for (let i = 0; i < count; i++) {
      const recordOffset = offset + 2 + i * 12
      entries.push({
        tag: this.u16(recordOffset),
        type: this.u16(recordOffset + 2),
        count: this.u32(recordOffset + 4),
        recordOffset,
        slot: this.u32(recordOffset + 8),
      })
    }
    return { offset, entries, nextPtrOffset: offset + 2 + count * 12 }
  }
}

/** Endian-aware byte builders matching the file being edited. */
class Builder {
  private little: boolean
  constructor(little: boolean) {
    this.little = little
  }
  u16(n: number): Uint8Array {
    const out = new Uint8Array(2)
    new DataView(out.buffer).setUint16(0, n, this.little)
    return out
  }
  u32(n: number): Uint8Array {
    const out = new Uint8Array(4)
    new DataView(out.buffer).setUint32(0, n, this.little)
    return out
  }
  entry(tag: number, type: number, count: number, slot: Uint8Array): Uint8Array {
    if (slot.length > 4) throw new Error('slot must be ≤ 4 bytes')
    const padded = new Uint8Array(4)
    padded.set(slot)
    return concatBytes([this.u16(tag), this.u16(type), this.u32(count), padded])
  }
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

const ascii = (s: string): Uint8Array => new TextEncoder().encode(s)

/**
 * Build a GPS IFD located at file offset `base`:
 * entry table first, external values (the rationals) right after it.
 */
function buildGpsIfd(b: Builder, gps: GeoPoint, base: number): Uint8Array {
  const rationals = (deg: number): Uint8Array =>
    concatBytes(degToDmsRationals(deg).flatMap((r) => [b.u32(r.num), b.u32(r.den)]))

  const fields: Array<{ tag: number; type: number; count: number; inline?: Uint8Array; data?: Uint8Array }> = [
    { tag: 0x0000, type: T_BYTE, count: 4, inline: new Uint8Array([2, 3, 0, 0]) },
    { tag: 0x0001, type: T_ASCII, count: 2, inline: ascii(gps.lat >= 0 ? 'N\0' : 'S\0') },
    { tag: 0x0002, type: T_RATIONAL, count: 3, data: rationals(gps.lat) },
    { tag: 0x0003, type: T_ASCII, count: 2, inline: ascii(gps.lon >= 0 ? 'E\0' : 'W\0') },
    { tag: 0x0004, type: T_RATIONAL, count: 3, data: rationals(gps.lon) },
  ]
  if (gps.ele !== undefined) {
    fields.push(
      { tag: 0x0005, type: T_BYTE, count: 1, inline: new Uint8Array([gps.ele < 0 ? 1 : 0]) },
      {
        tag: 0x0006,
        type: T_RATIONAL,
        count: 1,
        data: concatBytes([b.u32(Math.round(Math.abs(gps.ele) * 100)), b.u32(100)]),
      }
    )
  }

  const tableSize = 2 + fields.length * 12 + 4
  let dataOffset = base + tableSize
  const dataParts: Uint8Array[] = []
  const entries = fields.map((f) => {
    if (f.inline) return b.entry(f.tag, f.type, f.count, f.inline)
    const entry = b.entry(f.tag, f.type, f.count, b.u32(dataOffset))
    dataParts.push(f.data!)
    dataOffset += f.data!.length
    return entry
  })
  return concatBytes([b.u16(fields.length), ...entries, b.u32(0), ...dataParts])
}

/** Copy an IFD's table, upserting extra entries (12-byte records), tag-sorted. */
function rebuildIfdTable(tiff: TiffFile, b: Builder, ifd: Ifd, upserts: Map<number, Uint8Array>): Uint8Array {
  const records: Array<{ tag: number; bytes: Uint8Array }> = []
  for (const e of ifd.entries) {
    const bytes = upserts.get(e.tag) ?? tiff.bytes.slice(e.recordOffset, e.recordOffset + 12)
    records.push({ tag: e.tag, bytes })
    upserts.delete(e.tag)
  }
  for (const [tag, bytes] of upserts) records.push({ tag, bytes })
  records.sort((a, z) => a.tag - z.tag)
  const nextPtr = tiff.bytes.slice(ifd.nextPtrOffset, ifd.nextPtrOffset + 4)
  return concatBytes([b.u16(records.length), ...records.map((r) => r.bytes), nextPtr])
}

/** ASCII value patch at the entry's target, keeping length and NUL intact. */
function asciiPatch(tiff: TiffFile, entry: Entry, text: string): Patch {
  if (entry.type !== T_ASCII) throw new TiffStructureError(`Tag 0x${entry.tag.toString(16)} is not ASCII`)
  if (entry.count !== text.length + 1) {
    throw new TiffStructureError(`Tag 0x${entry.tag.toString(16)} has unexpected length ${entry.count}`)
  }
  // count > 4 means the slot holds an offset to the value bytes.
  const target = entry.count > 4 ? entry.slot : entry.recordOffset + 8
  if (target + entry.count > tiff.bytes.byteLength) throw new TiffStructureError('ASCII value out of range')
  return { offset: target, bytes: ascii(`${text}\0`) }
}

/**
 * Compute the rewritten file: patches into a copy of the original plus an
 * appended tail. Throws TiffStructureError for anything not fully understood.
 */
export function rewriteTiffMetadata(original: ArrayBuffer, edit: TiffEdit): Uint8Array {
  if (!edit.gps && !edit.time) throw new TiffStructureError('Nothing to write')
  // All patches land in this working copy immediately, so a later phase that
  // copies IFD records (e.g. the GPS rebuild of IFD0) sees repointed values.
  const work = new Uint8Array(original.slice(0))
  const tiff = new TiffFile(work)
  const b = new Builder(tiff.little)
  const ifd0 = tiff.readIfd(tiff.u32(4))

  const apply = (patch: Patch) => work.set(patch.bytes, patch.offset)

  // ---- phase 1: same-size values patched where they already are ----
  let exifIfd: Ifd | undefined
  let exifPtr: Entry | undefined
  const addOffsetTags: number[] = []
  if (edit.time) {
    exifPtr = ifd0.entries.find((e) => e.tag === TAG_EXIF_IFD)
    if (!exifPtr) throw new TiffStructureError('No Exif IFD — cannot correct capture time')
    exifIfd = tiff.readIfd(exifPtr.slot)
    const dto = exifIfd.entries.find((e) => e.tag === TAG_DATETIME_ORIGINAL)
    if (!dto) throw new TiffStructureError('No DateTimeOriginal to correct')
    const dateTime = formatExifDateTime(edit.time.wallClockMs)
    apply(asciiPatch(tiff, dto, dateTime))
    const digitized = exifIfd.entries.find((e) => e.tag === TAG_DATETIME_DIGITIZED)
    if (digitized) apply(asciiPatch(tiff, digitized, dateTime))

    const tz = formatTzOffset(edit.time.tzOffsetMin)
    for (const tag of [TAG_OFFSET_TIME_ORIGINAL, TAG_OFFSET_TIME_DIGITIZED]) {
      const existing = exifIfd.entries.find((e) => e.tag === tag)
      if (existing) apply(asciiPatch(tiff, existing, tz))
      else addOffsetTags.push(tag)
    }
  }
  const needsExifCopy = addOffsetTags.length > 0
  if (!edit.gps && !needsExifCopy) return work // pure in-place patch

  /*
   * ---- phase 2: one contiguous appended block, IFD0 first ----
   *
   * Chunked readers (exifr, which the app's own import uses) fetch a window
   * around the offset they seek to. A GPS IFD appended *before* the new IFD0,
   * or left far from it, is outside that window: the file then parses without
   * coordinates even though it is valid TIFF. So everything new goes into one
   * block that STARTS with the IFD0 the header points at, and every value sits
   * after the table referencing it — one forward window covers all of it.
   */
  const padding = original.byteLength % 2
  let cursor = original.byteLength + padding
  const reserve = (size: number): number => {
    const offset = cursor
    cursor += size
    return offset
  }
  const tableSize = (entries: number) => 2 + entries * 12 + 4

  const hasGpsEntry = ifd0.entries.some((e) => e.tag === TAG_GPS_IFD)
  const ifd0Offset = reserve(tableSize(ifd0.entries.length + (edit.gps && !hasGpsEntry ? 1 : 0)))
  const exifIfdOffset = needsExifCopy
    ? reserve(tableSize(exifIfd!.entries.length + addOffsetTags.length))
    : undefined
  const tz = edit.time ? ascii(`${formatTzOffset(edit.time.tzOffsetMin)}\0`) : new Uint8Array(0)
  const tzOffsets = addOffsetTags.map(() => reserve(tz.length))
  if (cursor % 2 === 1) reserve(1) // rationals read better on even offsets
  const gpsIfdOffset = edit.gps ? cursor : undefined

  const ifd0Upserts = new Map<number, Uint8Array>()
  if (gpsIfdOffset !== undefined) {
    // Rewrite the whole record: some writers type this tag as IFD/SHORT.
    ifd0Upserts.set(TAG_GPS_IFD, b.entry(TAG_GPS_IFD, T_LONG, 1, b.u32(gpsIfdOffset)))
  }
  if (exifIfdOffset !== undefined) {
    ifd0Upserts.set(TAG_EXIF_IFD, b.entry(TAG_EXIF_IFD, T_LONG, 1, b.u32(exifIfdOffset)))
  }
  const block: Uint8Array[] = [rebuildIfdTable(tiff, b, ifd0, ifd0Upserts)]
  if (exifIfdOffset !== undefined) {
    const upserts = new Map<number, Uint8Array>()
    addOffsetTags.forEach((tag, i) => {
      upserts.set(tag, b.entry(tag, T_ASCII, tz.length, b.u32(tzOffsets[i])))
    })
    block.push(rebuildIfdTable(tiff, b, exifIfd!, upserts))
    for (const _ of addOffsetTags) block.push(tz.slice())
  }
  if (gpsIfdOffset !== undefined) {
    // Pad to the reserved (even) GPS offset before the IFD itself.
    const written = original.byteLength + padding + block.reduce((n, p) => n + p.length, 0)
    if (gpsIfdOffset > written) block.push(new Uint8Array(gpsIfdOffset - written))
    block.push(buildGpsIfd(b, edit.gps!, gpsIfdOffset))
  }
  // The header points at the relocated IFD0 — the start of the block.
  apply({ offset: 4, bytes: b.u32(ifd0Offset) })

  const out = new Uint8Array(original.byteLength + padding + block.reduce((n, p) => n + p.length, 0))
  out.set(work, 0)
  let o = original.byteLength + padding
  for (const part of block) {
    out.set(part, o)
    o += part.length
  }
  return out
}
