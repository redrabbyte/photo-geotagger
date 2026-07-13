// Exercises the real ExifTool-WASM (zeroperl) write path in Node, the same
// code the browser worker runs. Slow (~25 MB WASM instantiation) — kept as a
// single test.
import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { writeMetadata, parseMetadata } from '@uswriting/exiftool'
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

const GPS = { lat: 48.858093, lon: 2.294694 }

describe('exiftool wasm', () => {
  it('writes GPS into a JPEG and reads it back', { timeout: 120_000 }, async () => {
    const jpeg = new Uint8Array(makeJpegWithExif('2026:06:01 12:34:56'))
    const written = await writeMetadata(
      { name: 'test.jpg', data: jpeg },
      {
        GPSLatitude: Math.abs(GPS.lat),
        GPSLatitudeRef: 'N',
        GPSLongitude: Math.abs(GPS.lon),
        GPSLongitudeRef: 'E',
      },
      { fetch: nodeFetch }
    )
    expect(written.success, written.success ? '' : written.error).toBe(true)
    if (!written.success) return

    // writeMetadata returns an ArrayBuffer in practice (typed as Uint8Array);
    // it must be wrapped or the verify pass sees an empty file.
    const outBytes =
      written.data instanceof Uint8Array
        ? written.data
        : new Uint8Array(written.data as unknown as ArrayBuffer)

    const verify = await parseMetadata<Array<Record<string, unknown>>>(
      { name: 'test.jpg', data: outBytes },
      {
        args: ['-json', '-n', '-GPSLatitude', '-GPSLongitude', '-DateTimeOriginal'],
        transform: (s) => JSON.parse(s) as Array<Record<string, unknown>>,
        fetch: nodeFetch,
      }
    )
    expect(verify.success).toBe(true)
    if (!verify.success) return
    const entry = verify.data[0]
    expect(entry.GPSLatitude as number).toBeCloseTo(GPS.lat, 4)
    expect(entry.GPSLongitude as number).toBeCloseTo(GPS.lon, 4)
    expect(entry.DateTimeOriginal).toBe('2026:06:01 12:34:56')
  })
})
