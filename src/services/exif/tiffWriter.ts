/**
 * Pure-JS metadata writer for TIFF-based RAW files (ARW, NEF, CR2, DNG…) —
 * the "experimental fast RAW" path.
 *
 * TIFF is a web of absolute file offsets (IFD tables, values, maker notes,
 * previews, raw strips), so this writer never recalculates one. It also never
 * MOVES an existing structure: RAW decoders in gallery apps commonly parse a
 * bounded region at the front of the file, and an IFD0 relocated to the end —
 * legal TIFF, and what an earlier version of this writer did — leaves them
 * unable to display the image at all.
 *
 * What it does instead, in order of preference:
 *
 * - Capture time: DateTimeOriginal/DateTimeDigitized and existing OffsetTime*
 *   tags are fixed-size ASCII values, patched exactly where they already sit.
 * - GPS when IFD0 already has a GPSInfo tag: only that tag's 12-byte record is
 *   rewritten, pointing at a GPS IFD appended to the end of the file.
 * - GPS when IFD0 has no GPSInfo tag: the table needs 12 more bytes, which are
 *   claimed from verified padding right behind it (all zero, referenced by
 *   nothing, ahead of any image data). Values stay put; only the table region
 *   is rewritten, tag-sorted, with the next-IFD pointer shifted along.
 * - Missing OffsetTime* tags grow the Exif IFD the same way; their short string
 *   values are appended, which no decoder needs to reach.
 *
 * Anything that does not fit throws TiffStructureError and the caller falls
 * back to ExifTool, which rewrites the file properly. Reading these files back
 * does not depend on the appended block being near the front: tiffReader.ts
 * follows the pointers with ranged reads.
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

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }

/**
 * Slack reserved behind the original bytes for everything this writer can
 * append: a GPS IFD with its rationals, a grown Exif IFD copy, timezone
 * strings. Two orders of magnitude more than the ~200 bytes actually used, and
 * the assembly step fails loudly rather than overrunning it.
 */
const APPEND_CAPACITY = 64 * 1024

/** Tags whose value is an offset to bulk data (strips, tiles, previews). */
const DATA_OFFSET_TAGS = new Set([0x0111, 0x0144, 0x0201, 0x014a])

/**
 * Is [start, start+length) unused padding? It must be zero-filled, overlap no
 * IFD table or value of the structures we know, and lie ahead of every bulk
 * data block — anything less certain and we leave the file to ExifTool.
 */
function isFreePadding(tiff: TiffFile, ifds: Ifd[], start: number, length: number): boolean {
  if (start < 0 || start + length > tiff.bytes.byteLength) return false
  for (let i = start; i < start + length; i++) if (tiff.bytes[i] !== 0) return false
  let dataStart = Number.POSITIVE_INFINITY
  for (const ifd of ifds) {
    if (start < ifd.nextPtrOffset + 4 && ifd.offset < start + length) return false
    for (const e of ifd.entries) {
      const size = (TYPE_SIZE[e.type] ?? 1) * e.count
      if (size > 4 && start < e.slot + size && e.slot < start + length) return false
      if (DATA_OFFSET_TAGS.has(e.tag) && e.count === 1 && e.slot > 0) {
        dataStart = Math.min(dataStart, e.slot)
      }
    }
  }
  return start + length <= dataStart
}

type NewRecord = { tag: number; bytes: Uint8Array }

/** An IFD's table with extra records merged in, tag-sorted, next pointer kept. */
function mergedTable(tiff: TiffFile, b: Builder, ifd: Ifd, newRecords: NewRecord[]): Uint8Array {
  const records: NewRecord[] = ifd.entries.map((e) => ({
    tag: e.tag,
    bytes: tiff.bytes.slice(e.recordOffset, e.recordOffset + 12),
  }))
  records.push(...newRecords)
  records.sort((x, y) => x.tag - y.tag)
  const nextPtr = tiff.bytes.slice(ifd.nextPtrOffset, ifd.nextPtrOffset + 4)
  return concatBytes([b.u16(records.length), ...records.map((r) => r.bytes), nextPtr])
}

/**
 * Add records to an IFD without moving anything: the table is rewritten where
 * it stands (tag-sorted, next-IFD pointer shifted along) into verified padding
 * behind it. Undefined when that padding is not there.
 */
function tryGrowIfdInPlace(
  tiff: TiffFile,
  b: Builder,
  ifd: Ifd,
  known: Ifd[],
  newRecords: NewRecord[]
): Patch | undefined {
  // The old next-IFD pointer is absorbed by the grown table; the bytes behind
  // it must be free for the pointer's new home plus the added records.
  if (!isFreePadding(tiff, known, ifd.nextPtrOffset + 4, newRecords.length * 12)) return undefined
  return { offset: ifd.offset, bytes: mergedTable(tiff, b, ifd, newRecords) }
}

/**
 * Compute the rewritten file: patches into a copy of the original plus an
 * appended tail. Throws TiffStructureError for anything not fully understood.
 */
export function rewriteTiffMetadata(original: ArrayBuffer, edit: TiffEdit): Uint8Array {
  if (!edit.gps && !edit.time) throw new TiffStructureError('Nothing to write')
  // One buffer for the whole job: the original copied in once, with slack for
  // the appended block, so a 20 MB RAW peaks at ~2x its size instead of ~3x
  // (the caller holds the source bytes until this returns). `work` is the
  // original-sized view of it; patches land in it immediately so a later phase
  // that copies IFD records sees the repointed values.
  const buffer = new Uint8Array(original.byteLength + APPEND_CAPACITY)
  buffer.set(new Uint8Array(original), 0)
  const work = buffer.subarray(0, original.byteLength)
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
  const needsOffsetTags = addOffsetTags.length > 0
  if (!edit.gps && !needsOffsetTags) return work // pure in-place patch

  /*
   * ---- phase 2: grow tables in place, append only new values ----
   *
   * Nothing that already exists moves. Tables gain records inside padding
   * behind them; brand-new values (the GPS IFD, the timezone strings) go to the
   * end of the file, referenced by offset. Reading them back does not depend on
   * their distance — tiffReader.ts follows the pointers.
   */
  const known = [ifd0, ...(exifIfd ? [exifIfd] : [])]
  const padding = original.byteLength % 2
  const block: Uint8Array[] = []
  let cursor = original.byteLength + padding
  /** Append bytes to the new block; returns the file offset they will live at. */
  const emit = (bytes: Uint8Array): number => {
    const at = cursor
    block.push(bytes)
    cursor += bytes.length
    return at
  }

  if (needsOffsetTags) {
    const tz = ascii(`${formatTzOffset(edit.time!.tzOffsetMin)}\0`)
    const record = (tag: number, valueAt: number) => ({
      tag,
      bytes: b.entry(tag, T_ASCII, tz.length, b.u32(valueAt)),
    })
    if (isFreePadding(tiff, known, exifIfd!.nextPtrOffset + 4, addOffsetTags.length * 12)) {
      const records = addOffsetTags.map((tag) => record(tag, emit(tz.slice())))
      apply({ offset: exifIfd!.offset, bytes: mergedTable(tiff, b, exifIfd!, records) })
    } else {
      // No padding behind the Exif IFD. Unlike IFD0 this one carries no image
      // structure — no decoder reads it — so append a grown copy and repoint
      // IFD0's pointer to it, which is a 4-byte patch in place. Its new values
      // go directly behind the table so one forward read covers both.
      const tableSize = 2 + (exifIfd!.entries.length + addOffsetTags.length) * 12 + 4
      const valuesAt = cursor + tableSize
      const records = addOffsetTags.map((tag, i) => record(tag, valuesAt + i * tz.length))
      const at = emit(mergedTable(tiff, b, exifIfd!, records))
      for (const _ of addOffsetTags) emit(tz.slice())
      apply({ offset: exifPtr!.recordOffset + 8, bytes: b.u32(at) })
    }
  }

  if (edit.gps) {
    if (cursor % 2 === 1) emit(new Uint8Array(1)) // rationals on even offsets
    const gpsAt = cursor
    emit(buildGpsIfd(b, edit.gps, gpsAt))
    const record = b.entry(TAG_GPS_IFD, T_LONG, 1, b.u32(gpsAt))
    const existing = ifd0.entries.find((e) => e.tag === TAG_GPS_IFD)
    if (existing) {
      // Rewrite the whole record: some writers type this tag as IFD/SHORT.
      apply({ offset: existing.recordOffset, bytes: record })
    } else {
      // IFD0 must never move: a gallery app's decoder reads the image layout
      // from it, often from a bounded region at the front of the file.
      const grown = tryGrowIfdInPlace(tiff, b, ifd0, known, [{ tag: TAG_GPS_IFD, bytes: record }])
      if (!grown) throw new TiffStructureError('No room to add a GPS tag to IFD0 without moving data')
      apply(grown)
    }
  }

  const total = original.byteLength + padding + block.reduce((n, p) => n + p.length, 0)
  if (total > buffer.length) throw new TiffStructureError('Appended metadata exceeds the reserved space')
  let o = original.byteLength + padding
  for (const part of block) {
    buffer.set(part, o)
    o += part.length
  }
  return buffer.subarray(0, total)
}
