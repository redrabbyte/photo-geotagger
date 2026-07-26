// Exercises the real ExifTool-WASM (zeroperl) write path in Node, the same
// code the browser worker runs — now via the direct zeroperl runner that
// batches many files into one Perl execution. Slow (~25 MB WASM
// instantiation) — kept as a single file.
import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import exifr from 'exifr'
import {
  ExiftoolRunner,
  extractExiftoolScript,
  isFatalWasmError,
  parseViaExiftool,
  writeBatchViaExiftool,
} from '../exif/exiftoolRunner'
import { isRecoverableWriteError } from '../writePipeline'
import { makeJpegWithExif, makeTiff } from './fixtures'
import { rewriteTiffMetadata } from '../exif/tiffWriter'

const require = createRequire(import.meta.url)

/** Serve zeroperl.wasm from node_modules instead of a URL. */
const nodeFetch = async (...args: unknown[]): Promise<Response> => {
  const url = String(args[0])
  if (url.endsWith('zeroperl.wasm')) {
    const wasmPath = require
      .resolve('@6over3/zeroperl-ts')
      .replace(/index\.js$/, 'zeroperl.wasm')
    const bytes = await readFile(wasmPath)
    return new Response(bytes, { headers: { 'Content-Type': 'application/wasm' } })
  }
  return fetch(args[0] as RequestInfo, args[1] as RequestInit)
}

const GPS_A = { lat: 48.858093, lon: 2.294694 }
const GPS_B = { lat: -33.856784, lon: 151.215297 }

describe('exiftool runner', () => {
  it('extracts the embedded ExifTool script from the wrapper bundle', () => {
    const script = extractExiftoolScript()
    expect(script.startsWith('use strict')).toBe(true)
    expect(script).toContain('Image::ExifTool')
    expect(script.length).toBeGreaterThan(50_000)
  })

  it('classifies fatal WASM faults as recoverable, logical errors not', () => {
    expect(isFatalWasmError('memory access out of bounds')).toBe(true)
    expect(isFatalWasmError('RuntimeError: unreachable executed')).toBe(true)
    expect(isRecoverableWriteError('memory access out of bounds')).toBe(true)
    expect(isRecoverableWriteError('ExifTool worker crashed')).toBe(true)
    expect(isFatalWasmError('GPS missing from rewritten file — refusing to overwrite original')).toBe(false)
    expect(isRecoverableWriteError('Existing sidecar is malformed')).toBe(false)
  })

  it('keeps working after a rebuild (crash recovery path)', { timeout: 180_000 }, async () => {
    const runner = new ExiftoolRunner(nodeFetch)
    const first = await runner.run(['-ver'], [])
    expect(first.success).toBe(true)
    runner.rebuild()
    const second = await runner.run(['-ver'], [])
    expect(second.success).toBe(true)
    expect(second.stdout.trim()).toBe(first.stdout.trim())
  })

  it('writes QuickTime GPS + dates into an MP4 and reads them back', { timeout: 180_000 }, async () => {
    // Minimal MP4: ftyp + moov(mvhd v0) + mdat — enough structure for
    // ExifTool to rewrite the movie header and add Keys/UserData atoms.
    const box = (type: string, body: Uint8Array): Uint8Array => {
      const out = new Uint8Array(8 + body.length)
      new DataView(out.buffer).setUint32(0, out.length)
      for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
      out.set(body, 8)
      return out
    }
    const mvhdBody = new Uint8Array(100)
    new DataView(mvhdBody.buffer).setUint32(4, 2_082_844_800) // creation 1970-01-01
    const ftyp = box('ftyp', new Uint8Array([0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0, 0x6d, 0x70, 0x34, 0x32]))
    const mp4 = new Uint8Array([...ftyp, ...box('moov', box('mvhd', mvhdBody)), ...box('mdat', new Uint8Array(16))])

    const runner = new ExiftoolRunner(nodeFetch)
    const results = await writeBatchViaExiftool(runner, [
      {
        name: 'clip.mp4',
        bytes: mp4,
        tags: {
          'Keys:GPSCoordinates': `${GPS_A.lat}, ${GPS_A.lon}`,
          'UserData:GPSCoordinates': `${GPS_A.lat}, ${GPS_A.lon}`,
          'QuickTime:CreateDate': '2026:07:04 20:55:27',
          'QuickTime:ModifyDate': '2026:07:04 20:55:27',
          'Keys:CreationDate': '2026:07:04 22:55:27+02:00',
        },
      },
    ])
    expect(results[0].ok, results[0].ok ? '' : results[0].error).toBe(true)
    if (!results[0].ok) return

    const verify = await parseViaExiftool(runner, 'clip.mp4', results[0].bytes, [
      '-json',
      '-n',
      '-GPSLatitude',
      '-GPSLongitude',
      '-QuickTime:CreateDate',
    ])
    expect(verify.success, verify.error).toBe(true)
    const entry = (JSON.parse(verify.output) as Array<Record<string, unknown>>)[0]
    expect(entry.GPSLatitude as number).toBeCloseTo(GPS_A.lat, 4)
    expect(entry.GPSLongitude as number).toBeCloseTo(GPS_A.lon, 4)
    expect(entry.CreateDate).toBe('2026:07:04 20:55:27')

    // Re-import path: our own scanner must find the GPS ExifTool just wrote.
    const { readVideoMetadata } = await import('../exif/videoMeta')
    const reimported = await readVideoMetadata(new Blob([results[0].bytes.slice()]))
    expect(reimported.gps?.lat).toBeCloseTo(GPS_A.lat, 4)
    expect(reimported.gps?.lon).toBeCloseTo(GPS_A.lon, 4)
  })

  it('writes several files in one Perl run, with per-file errors', { timeout: 180_000 }, async () => {
    const runner = new ExiftoolRunner(nodeFetch)
    const results = await writeBatchViaExiftool(runner, [
      {
        name: 'a.jpg',
        bytes: new Uint8Array(makeJpegWithExif('2026:06:01 12:34:56')),
        tags: {
          GPSLatitude: Math.abs(GPS_A.lat),
          GPSLatitudeRef: 'N',
          GPSLongitude: Math.abs(GPS_A.lon),
          GPSLongitudeRef: 'E',
          // Clock correction: +1h and explicit timezone.
          DateTimeOriginal: '2026:06:01 13:34:56',
          OffsetTimeOriginal: '+02:00',
        },
      },
      {
        name: 'broken.jpg',
        bytes: new Uint8Array([1, 2, 3, 4]),
        tags: { GPSLatitude: 1, GPSLatitudeRef: 'N', GPSLongitude: 1, GPSLongitudeRef: 'E' },
      },
      {
        name: 'b.jpg',
        bytes: new Uint8Array(makeJpegWithExif('2026:06:02 08:00:00')),
        tags: {
          GPSLatitude: Math.abs(GPS_B.lat),
          GPSLatitudeRef: 'S',
          GPSLongitude: Math.abs(GPS_B.lon),
          GPSLongitudeRef: 'E',
        },
      },
    ])

    expect(results).toHaveLength(3)
    expect(results[0].ok, results[0].ok ? '' : results[0].error).toBe(true)
    expect(results[1].ok).toBe(false)
    expect(results[2].ok, results[2].ok ? '' : results[2].error).toBe(true)
    if (!results[0].ok || !results[2].ok) return

    const a = await exifr.parse(results[0].bytes.slice().buffer, { tiff: true, exif: true, gps: true })
    expect(a.latitude as number).toBeCloseTo(GPS_A.lat, 4)
    expect(a.longitude as number).toBeCloseTo(GPS_A.lon, 4)
    expect(a.OffsetTimeOriginal).toBe('+02:00')

    const b = await exifr.parse(results[2].bytes.slice().buffer, { tiff: true, exif: true, gps: true })
    expect(b.latitude as number).toBeCloseTo(GPS_B.lat, 4)
    expect(b.longitude as number).toBeCloseTo(GPS_B.lon, 4)

    // The verification read path (ExifTool fallback) works on the same runner.
    const verify = await parseViaExiftool(runner, 'a.jpg', results[0].bytes, [
      '-json',
      '-n',
      '-DateTimeOriginal',
    ])
    expect(verify.success, verify.error).toBe(true)
    const entry = (JSON.parse(verify.output) as Array<Record<string, unknown>>)[0]
    expect(entry.DateTimeOriginal).toBe('2026:06:01 13:34:56')
  })

  it('fast-RAW output is accepted by the real ExifTool', { timeout: 120_000 }, async () => {
    // The strongest cross-check available: the pure-JS TIFF writer's output
    // parsed by the reference implementation itself.
    const rewritten = rewriteTiffMetadata(makeTiff().buffer, {
      gps: { lat: 48.8581, lon: 2.2947, ele: 35 },
      time: { wallClockMs: Date.UTC(2026, 6, 4, 15, 0, 0), tzOffsetMin: 120 },
    })
    const runner = new ExiftoolRunner(nodeFetch)
    const read = await parseViaExiftool(runner, 'photo.tif', rewritten, [
      '-json',
      '-n',
      '-GPSLatitude',
      '-GPSLongitude',
      '-GPSAltitude',
      '-DateTimeOriginal',
      '-OffsetTimeOriginal',
      '-validate',
      '-Warning',
    ])
    expect(read.success, read.error).toBe(true)
    const tags = (JSON.parse(read.output) as Array<Record<string, unknown>>)[0]
    expect(tags.GPSLatitude as number).toBeCloseTo(48.8581, 4)
    expect(tags.GPSLongitude as number).toBeCloseTo(2.2947, 4)
    expect(tags.GPSAltitude as number).toBeCloseTo(35, 1)
    expect(tags.DateTimeOriginal).toBe('2026:07:04 15:00:00')
    expect(tags.OffsetTimeOriginal).toBe('+02:00')
  })

  it('the real ExifTool confirms the Interop IFD is gone after a fast-RAW fix', { timeout: 120_000 }, async () => {
    // Windows misreads GPS while that directory is present; the JS writer drops
    // it by shrinking the Exif IFD table in place. Ask the reference
    // implementation whether the result is clean.
    const original = makeTiff({ interop: true })
    const runner = new ExiftoolRunner(nodeFetch)
    const before = await parseViaExiftool(runner, 'a.tif', original, ['-json', '-a', '-u', '-InteropIndex'])
    expect(before.success, before.error).toBe(true)
    expect(before.output).toContain('R98')

    const fixed = rewriteTiffMetadata(original.buffer as ArrayBuffer, {
      gps: { lat: -0.9621714, lon: -90.9574566 },
      dropInterop: true,
    })
    // No -G1 here: group prefixes would turn the JSON keys into "GPS:GPSLatitude".
    const after = await parseViaExiftool(runner, 'a.tif', fixed, [
      '-json',
      '-a',
      '-u',
      '-n',
      '-InteropIndex',
      '-InteropVersion',
      '-GPSLatitude',
      '-GPSLatitudeRef',
      '-validate',
      '-warning',
    ])
    expect(after.success, after.error).toBe(true)
    const tags = (JSON.parse(after.output) as Array<Record<string, unknown>>)[0]
    // The directory is gone, the position reads correctly, nothing broke.
    expect(after.output).not.toContain('R98')
    expect(tags.InteropIndex).toBeUndefined()
    expect(tags.GPSLatitude as number).toBeCloseTo(-0.9621714, 5)
    expect(String(tags.Warning ?? '')).not.toMatch(/error|bad|invalid/i)
  })
})
