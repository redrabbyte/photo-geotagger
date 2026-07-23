import { describe, it, expect } from 'vitest'
import { readVideoCaptureDate } from '../exif/videoMeta'
import { extractMeta } from '../exif/readMeta'

function box(type: string, body: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(8 + body.length)
  new DataView(out.buffer).setUint32(0, out.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(body, 8)
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

/** mvhd v0 with the given UTC creation time. */
function mvhd(creationUtcMs: number): Uint8Array {
  const body = new Uint8Array(100)
  const view = new DataView(body.buffer)
  view.setUint8(0, 0) // version 0
  view.setUint32(4, Math.floor(creationUtcMs / 1000) + SECONDS_1904_TO_1970)
  return box('mvhd', body)
}

const FTYP = box('ftyp', new Uint8Array([0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]))

describe('readVideoCaptureDate', () => {
  it('prefers the Sony XML CreationDate (with timezone)', async () => {
    const xml = `<?xml version="1.0"?><NonRealTimeMeta><CreationDate value="2026-07-04T12:30:00-05:00"/></NonRealTimeMeta>`
    const uuid = box('uuid', new TextEncoder().encode(xml))
    // Even with an mvhd present, the Sony date must win (it carries a tz).
    const moov = box('moov', mvhd(Date.parse('2026-07-04T00:00:00Z')))
    const blob = new Blob([concat(FTYP, uuid, moov)])
    const d = await readVideoCaptureDate(blob)
    expect(d).toEqual({ wallClockMs: Date.UTC(2026, 6, 4, 12, 30, 0), tzOffsetMin: -300 })
  })

  it('falls back to moov/mvhd creation_time, even with moov at the end', async () => {
    const t = Date.parse('2026-07-04T17:30:00Z')
    const mdat = box('mdat', new Uint8Array(5000))
    const blob = new Blob([concat(FTYP, mdat, box('moov', mvhd(t)))])
    expect(await readVideoCaptureDate(blob)).toEqual({ wallClockMs: t, tzOffsetMin: 0 })
  })

  it('rejects unset camera clocks and garbage', async () => {
    const blob = new Blob([concat(FTYP, box('moov', mvhd(Date.parse('1904-01-02T00:00:00Z'))))])
    expect(await readVideoCaptureDate(blob)).toBeUndefined()
    expect(await readVideoCaptureDate(new Blob([new Uint8Array(100)]))).toBeUndefined()
  })
})

describe('extractMeta for videos', () => {
  it('uses the container date instead of the file date', async () => {
    const xml = `<CreationDate value="2026-07-04T12:30:00-05:00"/>`
    const bytes = concat(FTYP, box('uuid', new TextEncoder().encode(xml)))
    const meta = await extractMeta(bytes.buffer as ArrayBuffer, 12345, 'video')
    expect(meta.timeSource).toBe('exif')
    expect(meta.captureLocalMs).toBe(Date.UTC(2026, 6, 4, 12, 30, 0))
    expect(meta.tzOffsetMin).toBe(-300)
  })

  it('still falls back to mtime when the container has no date', async () => {
    const bytes = concat(FTYP, box('mdat', new Uint8Array(100)))
    const meta = await extractMeta(bytes.buffer as ArrayBuffer, 999_000, 'video')
    expect(meta.timeSource).toBe('file')
    expect(meta.captureLocalMs).toBe(999_000)
  })
})
