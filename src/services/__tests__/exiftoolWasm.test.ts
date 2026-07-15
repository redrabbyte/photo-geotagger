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
  parseViaExiftool,
  writeBatchViaExiftool,
} from '../exif/exiftoolRunner'
import { makeJpegWithExif } from './fixtures'

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
})
