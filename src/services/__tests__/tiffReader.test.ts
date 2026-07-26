import { describe, it, expect } from 'vitest'
import { readTiffGps } from '../exif/tiffReader'
import { rewriteTiffMetadata } from '../exif/tiffWriter'
import { makeTiff } from './fixtures'

const u16 = (n: number, little = true) => {
  const b = new Uint8Array(2)
  new DataView(b.buffer).setUint16(0, n, little)
  return b
}
const u32 = (n: number, little = true) => {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n, little)
  return b
}
const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
const entry = (tag: number, type: number, count: number, slot: Uint8Array, little = true) =>
  concat(u16(tag, little), u16(type, little), u32(count, little), concat(slot, new Uint8Array(4 - slot.length)))
const rationals = (deg: number, little = true) => {
  const abs = Math.abs(deg)
  const d = Math.floor(abs)
  const m = Math.floor((abs - d) * 60)
  const s = Math.round(((abs - d) * 60 - m) * 60 * 10000)
  return concat(u32(d, little), u32(1, little), u32(m, little), u32(1, little), u32(s, little), u32(10000, little))
}

/** GPS IFD (5 entries) plus its rational values, based at `base`. */
function gpsBlock(lat: number, lon: number, base: number, little = true): Uint8Array {
  const table = 2 + 5 * 12 + 4
  const latAt = base + table
  const lonAt = latAt + 24
  return concat(
    u16(5, little),
    entry(0x0000, 1, 4, new Uint8Array([2, 3, 0, 0]), little),
    entry(0x0001, 2, 2, new TextEncoder().encode(lat >= 0 ? 'N\0' : 'S\0'), little),
    entry(0x0002, 5, 3, u32(latAt, little), little),
    entry(0x0003, 2, 2, new TextEncoder().encode(lon >= 0 ? 'E\0' : 'W\0'), little),
    entry(0x0004, 5, 3, u32(lonAt, little), little),
    u32(0, little),
    rationals(lat, little),
    rationals(lon, little)
  )
}

/**
 * A file laid out the way the first fast-RAW release wrote them: the GPS IFD
 * appended BEFORE the relocated IFD0, megabytes from the front. That is valid
 * TIFF but out of reach for a chunked EXIF parser — those files are what this
 * reader exists for.
 */
function makeOldLayoutFile(lat: number, lon: number, imageBytes: number): Uint8Array<ArrayBuffer> {
  const front = concat(
    new TextEncoder().encode('II'),
    u16(42),
    u32(8),
    u16(1),
    entry(0x0100, 4, 1, u32(1)), // ImageWidth — a plain entry, no GPS here
    u32(0),
    new Uint8Array(imageBytes).fill(0x5a)
  )
  const gpsAt = front.length
  const gps = gpsBlock(lat, lon, gpsAt)
  const ifd0At = gpsAt + gps.length
  const newIfd0 = concat(
    u16(2),
    entry(0x0100, 4, 1, u32(1)),
    entry(0x8825, 4, 1, u32(gpsAt)),
    u32(0)
  )
  const out = concat(front, gps, newIfd0)
  new DataView(out.buffer).setUint32(4, ifd0At, true) // header → relocated IFD0
  return out
}

describe('readTiffGps', () => {
  it('follows a GPS pointer megabytes into the file (old fast-RAW layout)', async () => {
    const file = makeOldLayoutFile(48.8581, 2.2947, 3_000_000)
    const gps = await readTiffGps(new Blob([file]))
    expect(gps?.lat).toBeCloseTo(48.8581, 4)
    expect(gps?.lon).toBeCloseTo(2.2947, 4)
  })

  it('honours S/W hemisphere references', async () => {
    const gps = await readTiffGps(new Blob([makeOldLayoutFile(-33.8568, -151.2153, 1000)]))
    expect(gps?.lat).toBeCloseTo(-33.8568, 4)
    expect(gps?.lon).toBeCloseTo(-151.2153, 4)
  })

  it('reads what the current writer produces, including altitude', async () => {
    const written = rewriteTiffMetadata(makeTiff().buffer as ArrayBuffer, {
      gps: { lat: 48.8581, lon: 2.2947, ele: 35 },
    })
    const gps = await readTiffGps(new Blob([written as BlobPart]))
    expect(gps?.lat).toBeCloseTo(48.8581, 4)
    expect(gps?.lon).toBeCloseTo(2.2947, 4)
    expect(gps?.ele).toBeCloseTo(35, 1)
  })

  it('returns undefined for files without GPS and for non-TIFF input', async () => {
    // No GPS IFD: the two header/IFD0 reads bail out.
    expect(await readTiffGps(new Blob([makeTiff()]))).toBeUndefined()
    // Not TIFF at all (JPEG magic, RAF magic, garbage).
    expect(await readTiffGps(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 0, 0, 0])]))).toBeUndefined()
    expect(await readTiffGps(new Blob([new TextEncoder().encode('FUJIFILMCCD-RAW')]))).toBeUndefined()
    expect(await readTiffGps(new Blob([new Uint8Array(4)]))).toBeUndefined()
  })

  it('rejects out-of-range coordinates instead of inventing a position', async () => {
    const file = makeOldLayoutFile(48.8581, 2.2947, 200)
    // Corrupt the latitude degrees to 200° — beyond any valid coordinate.
    const gpsAt = 8 + 18 + 200
    const latValuesAt = gpsAt + 2 + 5 * 12 + 4
    new DataView(file.buffer).setUint32(latValuesAt, 200, true)
    expect(await readTiffGps(new Blob([file]))).toBeUndefined()
  })

  it('handles big-endian (MM) files', async () => {
    const little = false
    const front = concat(
      new TextEncoder().encode('MM'),
      u16(42, little),
      u32(8, little),
      u16(1, little),
      entry(0x0100, 4, 1, u32(1, little), little),
      u32(0, little),
      new Uint8Array(500)
    )
    const gpsAt = front.length
    const gps = gpsBlock(48.8581, 2.2947, gpsAt, little)
    const ifd0At = gpsAt + gps.length
    const newIfd0 = concat(
      u16(2, little),
      entry(0x0100, 4, 1, u32(1, little), little),
      entry(0x8825, 4, 1, u32(gpsAt, little), little),
      u32(0, little)
    )
    const out = concat(front, gps, newIfd0)
    new DataView(out.buffer).setUint32(4, ifd0At, false)
    const read = await readTiffGps(new Blob([out]))
    expect(read?.lat).toBeCloseTo(48.8581, 4)
    expect(read?.lon).toBeCloseTo(2.2947, 4)
  })
})
