import { describe, it, expect } from 'vitest'
import exifr from 'exifr'
import { TiffStructureError, rewriteTiffMetadata } from '../exif/tiffWriter'
import { makeTiff } from './fixtures'


const asBuffer = (b: Uint8Array): ArrayBuffer => b.buffer as ArrayBuffer

describe('rewriteTiffMetadata', () => {
  const gps = { lat: 48.8581, lon: 2.2947, ele: 35 }

  it('adds a GPS IFD by appending and repointing IFD0', async () => {
    const original = makeTiff()
    const rewritten = rewriteTiffMetadata(asBuffer(original), { gps })

    // Every original byte except the 4-byte IFD0 pointer is untouched.
    const stripAt = original.length - 26
    expect(rewritten.slice(stripAt, original.length)).toEqual(original.slice(stripAt))
    expect(rewritten.slice(8, original.length)).toEqual(original.slice(8))

    const parsed = await exifr.parse(asBuffer(rewritten), { tiff: true, gps: true, exif: true })
    expect(parsed.latitude).toBeCloseTo(gps.lat, 4)
    expect(parsed.longitude).toBeCloseTo(gps.lon, 4)
    expect(parsed.GPSAltitude).toBeCloseTo(35, 1)
    // Untouched capture time still parses.
    expect(parsed.DateTimeOriginal).toBeInstanceOf(Date)
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
   * The regression that shipped GPS-less RAWs: chunked readers (exifr, used by
   * the app's own import) fetch a window around the offset they seek to, so
   * anything the new IFD0 references must lie AFTER it. A full-buffer parse
   * cannot catch a violation — this checks the layout itself.
   */
  it('keeps every new offset in one forward window starting at the relocated IFD0', () => {
    const u16 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset).getUint16(o, true)
    const u32 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset).getUint32(o, true)

    for (const edit of [
      { gps },
      { time: { wallClockMs: Date.UTC(2026, 6, 4, 15, 0, 0), tzOffsetMin: 120 } },
      { gps, time: { wallClockMs: Date.UTC(2026, 6, 4, 15, 0, 0), tzOffsetMin: 120 } },
    ]) {
      const original = makeTiff()
      const out = rewriteTiffMetadata(asBuffer(original), edit)
      const ifd0Offset = u32(out, 4)
      // IFD0 was relocated into the appended block.
      expect(ifd0Offset).toBeGreaterThanOrEqual(original.length)

      const count = u16(out, ifd0Offset)
      const pointers: number[] = []
      for (let i = 0; i < count; i++) {
        const rec = ifd0Offset + 2 + i * 12
        const tag = u16(out, rec)
        // GPSInfo / ExifIFD pointers, and every GPS value offset behind them.
        if (tag === 0x8825 || tag === 0x8769) {
          const target = u32(out, rec + 8)
          if (target >= original.length) {
            pointers.push(target)
            const subCount = u16(out, target)
            for (let j = 0; j < subCount; j++) {
              const subRec = target + 2 + j * 12
              const subCountVal = u32(out, subRec + 4)
              const type = u16(out, subRec + 2)
              const size = subCountVal * (type === 5 ? 8 : type === 4 ? 4 : 1)
              if (size > 4) pointers.push(u32(out, subRec + 8))
            }
          }
        }
      }
      expect(pointers.length).toBeGreaterThan(0)
      // Either in the original front region (covered by the reader's first
      // chunk) or in the forward window — never stranded in between, which is
      // what a GPS IFD appended before the new IFD0 used to be.
      const stranded = pointers.filter((p) => p >= original.length && p < ifd0Offset)
      expect(stranded).toEqual([])
    }
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
