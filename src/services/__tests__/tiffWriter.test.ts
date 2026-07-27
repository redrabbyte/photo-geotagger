import { describe, it, expect } from 'vitest'
import exifr from 'exifr'
import { TiffStructureError, rewriteTiffMetadata } from '../exif/tiffWriter'
import { makeTiff } from './fixtures'


/** Exact-size copy: the writer returns a view into a buffer with slack. */
const asBuffer = (b: Uint8Array): ArrayBuffer => b.slice().buffer

describe('rewriteTiffMetadata', () => {
  const gps = { lat: 48.8581, lon: 2.2947, ele: 35 }

  it('adds GPS without moving IFD0 or any existing byte outside its table', async () => {
    const original = makeTiff()
    const rewritten = rewriteTiffMetadata(asBuffer(original), { gps })
    const u16 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset).getUint16(o, true)
    const u32 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset).getUint32(o, true)

    // A gallery app's RAW decoder parses the front of the file: IFD0 must stay
    // exactly where the camera put it.
    expect(u32(rewritten, 4)).toBe(u32(original, 4))
    const ifd0 = u32(original, 4)
    // The table grew by one record; everything from there on is untouched.
    const grownTableEnd = ifd0 + 2 + (u16(original, ifd0) + 1) * 12 + 4
    expect(rewritten.slice(0, ifd0)).toEqual(original.slice(0, ifd0))
    expect(rewritten.slice(grownTableEnd, original.length)).toEqual(original.slice(grownTableEnd))
    // Entries stay in ascending tag order (readers may binary-search them).
    const count = u16(rewritten, ifd0)
    const tags = Array.from({ length: count }, (_, i) => u16(rewritten, ifd0 + 2 + i * 12))
    expect(tags).toEqual([...tags].sort((a, z) => a - z))
    expect(tags).toContain(0x8825)

    const parsed = await exifr.parse(asBuffer(rewritten), { tiff: true, gps: true, exif: true })
    expect(parsed.latitude).toBeCloseTo(gps.lat, 4)
    expect(parsed.longitude).toBeCloseTo(gps.lon, 4)
    expect(parsed.GPSAltitude).toBeCloseTo(35, 1)
    expect(parsed.DateTimeOriginal).toBeInstanceOf(Date)
  })

  it('falls back instead of moving data when IFD0 has no room to grow', () => {
    // Tightly packed IFD0 (no padding behind the table) — ExifTool must take
    // over rather than this writer relocating anything.
    const packed = makeTiff({ ifd0Padding: 0 })
    expect(() => rewriteTiffMetadata(asBuffer(packed), { gps })).toThrow(TiffStructureError)
    // A time-only correction still works: those values are patched in place.
    expect(() =>
      rewriteTiffMetadata(asBuffer(packed), { time: { wallClockMs: Date.UTC(2026, 6, 4, 15, 0, 0), tzOffsetMin: -300 } })
    ).not.toThrow()
  })

  it('replaces an existing GPS pointer without growing IFD0 again', async () => {
    const original = makeTiff()
    const once = rewriteTiffMetadata(asBuffer(original), { gps })
    const twice = rewriteTiffMetadata(asBuffer(once), { gps: { lat: -33.8568, lon: 151.2153 } })
    const parsed = await exifr.parse(asBuffer(twice), { tiff: true, gps: true })
    expect(parsed.latitude).toBeCloseTo(-33.8568, 4)
    expect(parsed.longitude).toBeCloseTo(151.2153, 4)
  })

  it('patches the capture time in place and appends missing OffsetTime tags', async () => {
    const original = makeTiff()
    const t = Date.UTC(2026, 6, 4, 15, 0, 0)
    const rewritten = rewriteTiffMetadata(asBuffer(original), {
      time: { wallClockMs: t, tzOffsetMin: 120 },
    })
    const parsed = await exifr.parse(asBuffer(rewritten), { tiff: true, exif: true })
    const dto = parsed.DateTimeOriginal as Date
    expect(
      Date.UTC(dto.getFullYear(), dto.getMonth(), dto.getDate(), dto.getHours(), dto.getMinutes(), dto.getSeconds())
    ).toBe(t)
    expect(parsed.OffsetTimeOriginal).toBe('+02:00')
    expect(new TextDecoder('latin1').decode(rewritten)).toContain('RAW-STRIP-DATA-DO-NOT-MOVE')
  })

  it('writes the clock alone when no timezone is known', async () => {
    const original = makeTiff()
    const rewritten = rewriteTiffMetadata(asBuffer(original), {
      time: { wallClockMs: Date.UTC(2026, 6, 4, 15, 0, 0) },
    })
    // Purely in-place: no OffsetTime records were appended.
    expect(rewritten.length).toBe(original.length)
    const parsed = await exifr.parse(asBuffer(rewritten), { tiff: true, exif: true })
    expect(parsed.OffsetTimeOriginal).toBeUndefined()
    expect(new TextDecoder('latin1').decode(rewritten)).toContain('2026:07:04 15:00:00')
  })

  it('leaves an existing OffsetTime alone when the correction states no zone', () => {
    const original = makeTiff({ offsetTime: true })
    const rewritten = rewriteTiffMetadata(asBuffer(original), {
      time: { wallClockMs: Date.UTC(2026, 6, 4, 15, 0, 0) },
    })
    // Cannot happen through timeCorrectionFor (a stated zone always comes back
    // as the target), but the writer must not corrupt the tag if asked.
    expect(new TextDecoder('latin1').decode(rewritten)).toContain('+09:00')
  })

  it('patches existing OffsetTime tags without appending anything', () => {
    const original = makeTiff({ offsetTime: true })
    const rewritten = rewriteTiffMetadata(asBuffer(original), {
      time: { wallClockMs: Date.UTC(2026, 6, 4, 15, 0, 0), tzOffsetMin: -300 },
    })
    // Pure in-place patching: same length (no tail was needed).
    expect(rewritten.length).toBe(original.length)
    const text = new TextDecoder('latin1').decode(rewritten)
    expect(text).toContain('-05:00')
    expect(text).not.toContain('+09:00')
    expect(text).toContain('2026:07:04 15:00:00')
  })

  /**
   * Two regressions guarded here. Relocating IFD0 to the end of the file broke
   * RAW display in gallery apps that parse only the front; leaving GPS values
   * reachable only through a far pointer broke reading them back. So: IFD0 keeps
   * its offset, and everything appended is self-contained behind its own table.
   */
  it('never relocates IFD0 and keeps appended values behind their table', () => {
    const u16 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset).getUint16(o, true)
    const u32 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset).getUint32(o, true)

    for (const edit of [
      { gps },
      { time: { wallClockMs: Date.UTC(2026, 6, 4, 15, 0, 0), tzOffsetMin: 120 } },
      { gps, time: { wallClockMs: Date.UTC(2026, 6, 4, 15, 0, 0), tzOffsetMin: 120 } },
    ]) {
      const original = makeTiff()
      const out = rewriteTiffMetadata(asBuffer(original), edit)
      const ifd0 = u32(out, 4)
      expect(ifd0).toBe(u32(original, 4))
      expect(ifd0).toBeLessThan(original.length)

      // Every IFD the new file points into must have its own values behind its
      // table, so one forward read from that IFD covers them.
      const count = u16(out, ifd0)
      for (let i = 0; i < count; i++) {
        const rec = ifd0 + 2 + i * 12
        const tag = u16(out, rec)
        if (tag !== 0x8825 && tag !== 0x8769) continue
        const target = u32(out, rec + 8)
        if (target < original.length) continue // untouched front-region IFD
        const subCount = u16(out, target)
        for (let j = 0; j < subCount; j++) {
          const subRec = target + 2 + j * 12
          const type = u16(out, subRec + 2)
          const size = u32(out, subRec + 4) * (type === 5 ? 8 : type === 4 ? 4 : 1)
          if (size <= 4) continue
          const valueAt = u32(out, subRec + 8)
          // Either an original value left in place, or one behind this table.
          expect(valueAt < original.length || valueAt > target).toBe(true)
        }
      }
    }
  })

  /**
   * Windows' RAW codec merges the Interop IFD into the GPS tag namespace, where
   * Interop 0x0001/0x0002 overwrite GPSLatitudeRef/GPSLatitude — Explorer then
   * shows "R98" as the hemisphere and no latitude. Removing the directory is
   * the only thing that fixes it, and it must cost nothing else.
   */
  describe('dropping the Interop IFD', () => {
    const u16 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset).getUint16(o, true)
    const u32 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset).getUint32(o, true)
    const exifEntries = (b: Uint8Array) => {
      const exifPtr = u32(b, u32(b, 4) + 2 + 8) // IFD0's first entry is 0x8769
      const count = u16(b, exifPtr)
      return {
        offset: exifPtr,
        tags: Array.from({ length: count }, (_, i) => u16(b, exifPtr + 2 + i * 12)),
      }
    }

    it('removes the 0xA005 pointer in place, keeping the table where it was', () => {
      const original = makeTiff({ interop: true })
      expect(exifEntries(original).tags).toContain(0xa005)

      const out = rewriteTiffMetadata(asBuffer(original), { dropInterop: true })
      const after = exifEntries(out)
      expect(after.offset).toBe(exifEntries(original).offset) // not relocated
      expect(after.tags).not.toContain(0xa005)
      expect(after.tags).toEqual([0x9003, 0x9004]) // the rest survives, in order
      // Purely subtractive: same length, and the image payload is untouched.
      expect(out.length).toBe(original.length)
      expect(new TextDecoder('latin1').decode(out)).toContain('RAW-STRIP-DATA-DO-NOT-MOVE')
      // IFD0 keeps its offset and its pointer to the Exif IFD.
      expect(u32(out, 4)).toBe(u32(original, 4))
    })

    it('is a no-op for files that carry no Interop IFD', () => {
      const original = makeTiff()
      const out = rewriteTiffMetadata(asBuffer(original), { dropInterop: true })
      expect(out).toEqual(original)
    })

    it('combines with a GPS write — one pass, both fixes', async () => {
      const original = makeTiff({ interop: true })
      const out = rewriteTiffMetadata(asBuffer(original), { gps, dropInterop: true })
      expect(exifEntries(out).tags).not.toContain(0xa005)
      const parsed = await exifr.parse(asBuffer(out), { tiff: true, gps: true, exif: true })
      expect(parsed.latitude).toBeCloseTo(gps.lat, 4)
      expect(parsed.DateTimeOriginal).toBeInstanceOf(Date)
    })
  })

  it('bails with TiffStructureError on anything not understood', () => {
    const gpsOnly = { gps }
    // Not a TIFF (e.g. RAF/CR3/HEIC magic).
    expect(() => rewriteTiffMetadata(new ArrayBuffer(64), gpsOnly)).toThrow(TiffStructureError)
    const raf = new TextEncoder().encode('FUJIFILMCCD-RAW 0201FF129502').buffer as ArrayBuffer
    expect(() => rewriteTiffMetadata(raf, gpsOnly)).toThrow(TiffStructureError)
    // Time correction without an Exif IFD.
    const noExif = new Uint8Array(26)
    noExif.set(new TextEncoder().encode('II'))
    new DataView(noExif.buffer).setUint16(2, 42, true)
    new DataView(noExif.buffer).setUint32(4, 8, true)
    new DataView(noExif.buffer).setUint16(8, 1, true)
    new DataView(noExif.buffer).setUint16(10, 0x0100, true) // ImageWidth, not ExifIFD
    new DataView(noExif.buffer).setUint16(12, 4, true)
    new DataView(noExif.buffer).setUint32(14, 1, true)
    expect(() =>
      rewriteTiffMetadata(noExif.buffer as ArrayBuffer, { time: { wallClockMs: 0, tzOffsetMin: 0 } })
    ).toThrow(TiffStructureError)
  })

  it('writes GPS and time together', async () => {
    const original = makeTiff()
    const t = Date.UTC(2026, 6, 4, 15, 0, 0)
    const rewritten = rewriteTiffMetadata(asBuffer(original), {
      gps,
      time: { wallClockMs: t, tzOffsetMin: 120 },
    })
    const parsed = await exifr.parse(asBuffer(rewritten), { tiff: true, gps: true, exif: true })
    expect(parsed.latitude).toBeCloseTo(gps.lat, 4)
    const dto = parsed.DateTimeOriginal as Date
    expect(dto.getUTCFullYear?.() ?? dto.getFullYear()).toBe(2026)
    expect(parsed.OffsetTimeOriginal).toBe('+02:00')
  })
})
