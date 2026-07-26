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
  const tail: Uint8Array[] = []
  // TIFF values must sit at even offsets — pad the appended region if needed.
  let base = original.byteLength + (original.byteLength % 2)

  if (edit.time) {
    const exifPtr = ifd0.entries.find((e) => e.tag === TAG_EXIF_IFD)
    if (!exifPtr) throw new TiffStructureError('No Exif IFD — cannot correct capture time')
    const exifIfd = tiff.readIfd(exifPtr.slot)
    const dto = exifIfd.entries.find((e) => e.tag === TAG_DATETIME_ORIGINAL)
    if (!dto) throw new TiffStructureError('No DateTimeOriginal to correct')
    const dateTime = formatExifDateTime(edit.time.wallClockMs)
    apply(asciiPatch(tiff, dto, dateTime))
    const digitized = exifIfd.entries.find((e) => e.tag === TAG_DATETIME_DIGITIZED)
    if (digitized) apply(asciiPatch(tiff, digitized, dateTime))

    const tz = formatTzOffset(edit.time.tzOffsetMin)
    const missing = new Map<number, Uint8Array>()
    for (const tag of [TAG_OFFSET_TIME_ORIGINAL, TAG_OFFSET_TIME_DIGITIZED]) {
      const existing = exifIfd.entries.find((e) => e.tag === tag)
      if (existing) {
        apply(asciiPatch(tiff, existing, tz))
      } else {
        // Value appended to the tail; entry added to the rebuilt Exif IFD.
        missing.set(tag, b.entry(tag, T_ASCII, tz.length + 1, b.u32(0)))
      }
    }
    if (missing.size > 0) {
      // Append an extended copy of the Exif IFD and repoint IFD0's entry at it.
      const valueBase = base
      let valueOffset = valueBase
      const values: Uint8Array[] = []
      for (const [tag, record] of missing) {
        const value = ascii(`${tz}\0`)
        const patched = record.slice()
        patched.set(b.u32(valueOffset), 8)
        missing.set(tag, patched)
        values.push(value)
        valueOffset += value.length
      }
      if (valueOffset % 2 === 1) {
        values.push(new Uint8Array(1))
        valueOffset += 1
      }
      const newExifIfdOffset = valueOffset
      const table = rebuildIfdTable(tiff, b, exifIfd, missing)
      tail.push(...values, table)
      base = newExifIfdOffset + table.length
      apply({ offset: exifPtr.recordOffset + 8, bytes: b.u32(newExifIfdOffset) })
    }
  }

  if (edit.gps) {
    const gpsIfdOffset = base
    const gpsIfd = buildGpsIfd(b, edit.gps, gpsIfdOffset)
    tail.push(gpsIfd)
    base += gpsIfd.length

    const existing = ifd0.entries.find((e) => e.tag === TAG_GPS_IFD)
    if (existing) {
      // Rewrite the whole 12-byte record: some writers use type IFD/SHORT.
      apply({
        offset: existing.recordOffset,
        bytes: b.entry(TAG_GPS_IFD, T_LONG, 1, b.u32(gpsIfdOffset)),
      })
    } else {
      const newIfd0Offset = base
      const table = rebuildIfdTable(tiff, b, ifd0, new Map([[TAG_GPS_IFD, b.entry(TAG_GPS_IFD, T_LONG, 1, b.u32(gpsIfdOffset))]]))
      tail.push(table)
      base = newIfd0Offset + table.length
      apply({ offset: 4, bytes: b.u32(newIfd0Offset) })
    }
  }

  const padding = tail.length > 0 ? original.byteLength % 2 : 0
  const out = new Uint8Array(original.byteLength + padding + tail.reduce((n, p) => n + p.length, 0))
  out.set(work, 0)
  let o = original.byteLength + padding
  for (const part of tail) {
    out.set(part, o)
    o += part.length
  }
  return out
}
