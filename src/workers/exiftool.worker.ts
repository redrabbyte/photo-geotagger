/// <reference lib="webworker" />
// Dedicated worker for ExifTool-WASM (zeroperl) writes: the Perl runtime is
// ~25 MB of WASM and each invocation takes noticeable CPU, so it stays off
// the main thread. Loaded lazily — this worker is only created when the user
// switches to ExifTool write mode.
import { writeMetadata, parseMetadata } from '@uswriting/exiftool'
// Vite emits the 25 MB WASM as a hashed asset; zeroperl's own relative
// "./zeroperl.wasm" URL would 404, so every request for it is redirected
// to the emitted asset via the custom fetch below.
// Relative path because the package's `exports` field forbids deep imports.
import zeroperlWasmUrl from '../../node_modules/@6over3/zeroperl-ts/dist/esm/zeroperl.wasm?url'
import type { GeoPoint } from '../domain/types'

// zeroperl detects "browser" as `typeof window/document !== 'undefined'`,
// which is false in a Web Worker and sends it down a Node-only code path.
// Shim both so it uses fetch() (with our custom fetch below) for the WASM.
const workerGlobal = self as unknown as Record<string, unknown>
if (typeof window === 'undefined') {
  workerGlobal.window = self
  workerGlobal.document ??= {}
}

const wasmFetch =(...args: unknown[]): Promise<Response> => {
  const [input, init] = args as [RequestInfo | URL, RequestInit | undefined]
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url.endsWith('zeroperl.wasm')) return fetch(zeroperlWasmUrl, init)
  return fetch(input, init)
}

export interface ExiftoolWriteRequest {
  type: 'write-gps'
  requestId: number
  fileName: string
  bytes: ArrayBuffer
  gps: GeoPoint
}

export type ExiftoolWriteResponse =
  | { type: 'result'; requestId: number; ok: true; bytes: ArrayBuffer }
  | { type: 'result'; requestId: number; ok: false; error: string }

async function writeGps(fileName: string, bytes: ArrayBuffer, gps: GeoPoint): Promise<ArrayBuffer> {
  const input = { name: fileName, data: new Uint8Array(bytes) }
  const tags: Record<string, string | number> = {
    GPSVersionID: '2.3.0.0',
    GPSLatitude: Math.abs(gps.lat),
    GPSLatitudeRef: gps.lat >= 0 ? 'N' : 'S',
    GPSLongitude: Math.abs(gps.lon),
    GPSLongitudeRef: gps.lon >= 0 ? 'E' : 'W',
  }
  if (gps.ele !== undefined) {
    tags.GPSAltitude = Math.abs(gps.ele)
    tags.GPSAltitudeRef = gps.ele < 0 ? 1 : 0
  }

  const result = await writeMetadata(input, tags, { fetch: wasmFetch })
  if (!result.success) {
    throw new Error(result.error || `exiftool failed with exit code ${result.exitCode}`)
  }
  const outBytes: Uint8Array = result.data instanceof Uint8Array ? result.data : new Uint8Array(result.data as ArrayBuffer)

  // Verify with an independent read before the caller may overwrite anything.
  const verify = await parseMetadata<Array<Record<string, number>>>(
    { name: fileName, data: outBytes },
    {
      args: ['-json', '-n', '-GPSLatitude', '-GPSLongitude'],
      transform: (s) => JSON.parse(s) as Array<Record<string, number>>,
      fetch: wasmFetch,
    }
  )
  if (!verify.success) throw new Error(`verification read failed: ${verify.error}`)
  const entry = verify.data[0] ?? {}
  const lat = entry.GPSLatitude
  const lon = entry.GPSLongitude
  if (typeof lat !== 'number' || typeof lon !== 'number') {
    throw new Error('GPS missing from rewritten file — refusing to overwrite original')
  }
  if (Math.abs(lat - gps.lat) > 1e-4 || Math.abs(lon - gps.lon) > 1e-4) {
    throw new Error('GPS in rewritten file does not match assigned position')
  }
  if (outBytes.length < bytes.byteLength * 0.5) {
    throw new Error('Rewritten file is implausibly small — refusing to overwrite original')
  }
  return outBytes.buffer.slice(outBytes.byteOffset, outBytes.byteOffset + outBytes.byteLength) as ArrayBuffer
}

self.onmessage = async (event: MessageEvent<ExiftoolWriteRequest>) => {
  const { requestId, fileName, bytes, gps } = event.data
  try {
    const out = await writeGps(fileName, bytes, gps)
    postMessage({ type: 'result', requestId, ok: true, bytes: out } satisfies ExiftoolWriteResponse, { transfer: [out] })
  } catch (err) {
    postMessage({
      type: 'result',
      requestId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } satisfies ExiftoolWriteResponse)
  }
}
