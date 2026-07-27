import { describe, it, expect } from 'vitest'
import {
  Mp4StructureError,
  formatIso6709,
  formatKeysCreationDate,
  rewriteMp4Metadata,
} from '../exif/mp4Writer'
import { readVideoMetadata, topLevelBoxes } from '../exif/videoMeta'

function box(type: string, ...bodies: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const size = 8 + bodies.reduce((n, b) => n + b.length, 0)
  const out = new Uint8Array(size)
  new DataView(out.buffer).setUint32(0, size)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i) & 0xff
  let o = 8
  for (const b of bodies) {
    out.set(b, o)
    o += b.length
  }
  return out
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

const SECONDS_1904_TO_1970 = 2_082_844_800
const FTYP = box('ftyp', new Uint8Array([0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]))
const T_ORIG = Date.parse('2026-07-04T17:30:00Z')
const T_NEW = Date.parse('2026-07-04T15:00:00Z')

function mvhd(creationUtcMs: number): Uint8Array {
  const body = new Uint8Array(100)
  new DataView(body.buffer).setUint32(4, Math.floor(creationUtcMs / 1000) + SECONDS_1904_TO_1970)
  return box('mvhd', body)
}

/** A trak stand-in whose bytes must survive the rewrite untouched. */
const TRAK = box('trak', new TextEncoder().encode('chunk-offset-tables-live-here'))

async function bytesOf(parts: (Blob | Uint8Array)[]): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer())
}

async function layoutOf(blob: Blob): Promise<Array<{ type: string; offset: number; size: number }>> {
  const out = []
  for await (const { header, offset } of topLevelBoxes(blob)) {
    out.push({ type: header.type, offset, size: header.size })
  }
  return out
}

describe('formatters', () => {
  it('formats padded ISO 6709 with and without elevation', () => {
    expect(formatIso6709({ lat: 48.8581, lon: 2.2947, ele: 35 })).toBe('+48.8581+002.2947+035.000/')
    expect(formatIso6709({ lat: -33.8568, lon: -151.2153 })).toBe('-33.8568-151.2153/')
  })

  it('formats Keys creationdate as local time with offset', () => {
    expect(formatKeysCreationDate({ utcMs: Date.UTC(2026, 6, 4, 17, 30, 0), tzOffsetMin: -300 })).toBe(
      '2026-07-04T12:30:00-0500'
    )
  })
})

describe('rewriteMp4Metadata', () => {
  const gps = { lat: 48.8581, lon: 2.2947, ele: 35 }

  it('moov-at-end: replaces moov in place, mdat untouched', async () => {
    const mdat = box('mdat', new Uint8Array(50_000).fill(7))
    const original = concat(FTYP, mdat, box('moov', mvhd(T_ORIG), TRAK))
    const { parts } = await rewriteMp4Metadata(new Blob([original]), {
      gps,
      time: { utcMs: T_NEW, tzOffsetMin: 120 },
    })
    const rewritten = await bytesOf(parts)

    // Everything before moov is byte-identical: mdat never moved.
    expect(rewritten.slice(0, FTYP.length + mdat.length)).toEqual(original.slice(0, FTYP.length + mdat.length))
    const meta = await readVideoMetadata(new Blob([rewritten]))
    expect(meta.gps?.lat).toBeCloseTo(gps.lat, 4)
    expect(meta.gps?.lon).toBeCloseTo(gps.lon, 4)
    expect(meta.gps?.ele).toBeCloseTo(35, 1)
    expect(meta.date?.wallClockMs).toBe(T_NEW)
    // The trak (chunk offsets) bytes survive inside the new moov unchanged.
    const text = new TextDecoder('latin1').decode(rewritten)
    expect(text).toContain('chunk-offset-tables-live-here')
  })

  it('faststart: old moov becomes free, mdat keeps its offset, new moov appended', async () => {
    const mdat = box('mdat', new Uint8Array(50_000).fill(7))
    const original = concat(FTYP, box('moov', mvhd(T_ORIG), TRAK), mdat)
    const origLayout = await layoutOf(new Blob([original]))
    const mdatBefore = origLayout.find((b) => b.type === 'mdat')!

    const { parts } = await rewriteMp4Metadata(new Blob([original]), { gps })
    const rewritten = await bytesOf(parts)
    const layout = await layoutOf(new Blob([rewritten]))

    expect(layout.map((b) => b.type)).toEqual(['ftyp', 'free', 'mdat', 'moov'])
    expect(layout.find((b) => b.type === 'mdat')!.offset).toBe(mdatBefore.offset)
    const meta = await readVideoMetadata(new Blob([rewritten]))
    expect(meta.gps?.lat).toBeCloseTo(gps.lat, 4)
    // Original capture date still readable from the appended moov.
    expect(meta.date?.wallClockMs).toBe(T_ORIG)
  })

  it('replaces an existing ©xyz instead of duplicating it', async () => {
    const oldIso = new TextEncoder().encode('+11.0000+022.0000/')
    const xyzBody = new Uint8Array(4 + oldIso.length)
    xyzBody[1] = oldIso.length
    xyzBody.set(oldIso, 4)
    const original = concat(FTYP, box('moov', mvhd(T_ORIG), box('udta', box('©xyz', xyzBody))))
    const { parts } = await rewriteMp4Metadata(new Blob([original]), { gps })
    const rewritten = await bytesOf(parts)
    const text = new TextDecoder('latin1').decode(rewritten)
    expect(text).not.toContain('+11.0000')
    expect((await readVideoMetadata(new Blob([rewritten]))).gps?.lat).toBeCloseTo(gps.lat, 4)
  })

  it('extends an existing Keys structure without breaking other keys', async () => {
    const otherKey = new TextEncoder().encode('com.apple.quicktime.make')
    const keys = box('keys', new Uint8Array(4), concat(new Uint8Array([0, 0, 0, 1]), concat(
      (() => { const s = new Uint8Array(4); new DataView(s.buffer).setUint32(0, 8 + otherKey.length); return s })(),
      new TextEncoder().encode('mdta'),
      otherKey
    )))
    const makeValue = box('data', new Uint8Array([0, 0, 0, 1]), new Uint8Array(4), new TextEncoder().encode('Sony'))
    const entry = concat((() => { const s = new Uint8Array(8); const v = new DataView(s.buffer); v.setUint32(0, 8 + makeValue.length); v.setUint32(4, 1); return s })(), makeValue)
    const ilst = box('ilst', entry)
    const hdlr = box('hdlr', new Uint8Array(4), new Uint8Array(4), new TextEncoder().encode('mdta'), new Uint8Array(12))
    const original = concat(FTYP, box('moov', mvhd(T_ORIG), box('meta', hdlr, keys, ilst)))

    const { parts } = await rewriteMp4Metadata(new Blob([original]), { gps })
    const rewritten = await bytesOf(parts)
    const text = new TextDecoder('latin1').decode(rewritten)
    // The foreign key and its value survive; our key is appended.
    expect(text).toContain('com.apple.quicktime.make')
    expect(text).toContain('Sony')
    expect(text).toContain('com.apple.quicktime.location.ISO6709')
    expect((await readVideoMetadata(new Blob([rewritten]))).gps?.lat).toBeCloseTo(gps.lat, 4)
  })

  it('grows the file only by the metadata it adds', async () => {
    const mdat = box('mdat', new Uint8Array(100_000))
    const original = concat(FTYP, mdat, box('moov', mvhd(T_ORIG)))
    const { size } = await rewriteMp4Metadata(new Blob([original]), { gps })
    expect(size).toBeGreaterThan(original.length)
    expect(size).toBeLessThan(original.length + 1000)
  })

  it('bails with Mp4StructureError on structures it does not understand', async () => {
    // Not an MP4 at all.
    await expect(rewriteMp4Metadata(new Blob([new Uint8Array(64)]), { gps })).rejects.toThrow(Mp4StructureError)
    // No moov.
    await expect(
      rewriteMp4Metadata(new Blob([concat(FTYP, box('mdat', new Uint8Array(10)))]), { gps })
    ).rejects.toThrow(Mp4StructureError)
    // meta owned by a foreign handler must not be rewritten.
    const foreignHdlr = box('hdlr', new Uint8Array(4), new Uint8Array(4), new TextEncoder().encode('mdir'), new Uint8Array(12))
    const original = concat(FTYP, box('moov', mvhd(T_ORIG), box('meta', foreignHdlr)))
    await expect(rewriteMp4Metadata(new Blob([original]), { gps })).rejects.toThrow(Mp4StructureError)
  })

  it('writes a time-only correction into mvhd and Keys', async () => {
    const original = concat(FTYP, box('mdat', new Uint8Array(100)), box('moov', mvhd(T_ORIG)))
    const { parts } = await rewriteMp4Metadata(new Blob([original]), {
      time: { utcMs: T_NEW, tzOffsetMin: 120 },
    })
    const rewritten = await bytesOf(parts)
    const meta = await readVideoMetadata(new Blob([rewritten]))
    expect(meta.date?.wallClockMs).toBe(T_NEW)
    expect(new TextDecoder('latin1').decode(rewritten)).toContain('2026-07-04T17:00:00+0200')
  })

  it('sets the UTC instant but claims no local time when no zone is known', async () => {
    const original = concat(FTYP, box('mdat', new Uint8Array(100)), box('moov', mvhd(T_ORIG)))
    const { parts } = await rewriteMp4Metadata(new Blob([original]), { time: { utcMs: T_NEW } })
    const rewritten = await bytesOf(parts)
    // mvhd is UTC by spec, so it is always correct to write; Keys creationdate
    // is a local time plus offset and would be a guess.
    expect((await readVideoMetadata(new Blob([rewritten]))).date?.wallClockMs).toBe(T_NEW)
    expect(new TextDecoder('latin1').decode(rewritten)).not.toContain('creationdate')
  })
})
