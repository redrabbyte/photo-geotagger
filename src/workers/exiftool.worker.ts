/// <reference lib="webworker" />
// Dedicated worker for ExifTool-WASM (zeroperl) writes: the Perl runtime is
// ~25 MB of WASM and each invocation takes noticeable CPU, so it stays off
// the main thread. Loaded lazily — this worker is only created when the user
// switches to ExifTool write mode.
import exifr from 'exifr'
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

// zeroperl only holds the WASM bytes in a WeakRef; under the memory pressure
// of multi-MB photos it re-fetches 25 MB on every interpreter re-boot. Cache
// the bytes strongly so re-boots skip the fetch.
let wasmBytesCache: ArrayBuffer | undefined
const wasmFetch = async (...args: unknown[]): Promise<Response> => {
  const [input, init] = args as [RequestInfo | URL, RequestInit | undefined]
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url.endsWith('zeroperl.wasm')) {
    if (!wasmBytesCache) {
      wasmBytesCache = await (await fetch(zeroperlWasmUrl, init)).arrayBuffer()
    }
    return new Response(wasmBytesCache, { headers: { 'Content-Type': 'application/wasm' } })
  }
  return fetch(input, init)
}

export interface WorkerTimeCorrection {
  /** "YYYY:MM:DD HH:MM:SS" */
  exifDateTime: string
  /** "±HH:MM" */
  tzOffset: string
}

export type ExiftoolRequest =
  | {
      type: 'write-gps'
      requestId: number
      fileName: string
      bytes: ArrayBuffer
      /** Omit for time-only writes. */
      gps?: GeoPoint
      timeCorrection?: WorkerTimeCorrection
    }
  | { type: 'inspect'; requestId: number; fileName: string; bytes: ArrayBuffer }

export type ExiftoolResponse =
  | { type: 'result'; requestId: number; ok: true; bytes: ArrayBuffer }
  | { type: 'result'; requestId: number; ok: true; text: string }
  | { type: 'result'; requestId: number; ok: false; error: string }

async function writeGps(
  fileName: string,
  bytes: ArrayBuffer,
  gps: GeoPoint | undefined,
  timeCorrection?: WorkerTimeCorrection
): Promise<ArrayBuffer> {
  if (!gps && !timeCorrection) throw new Error('Nothing to write')
  const input = { name: fileName, data: new Uint8Array(bytes) }
  const tags: Record<string, string | number> = {}
  if (gps) {
    tags.GPSVersionID = '2.3.0.0'
    tags.GPSLatitude = Math.abs(gps.lat)
    tags.GPSLatitudeRef = gps.lat >= 0 ? 'N' : 'S'
    tags.GPSLongitude = Math.abs(gps.lon)
    tags.GPSLongitudeRef = gps.lon >= 0 ? 'E' : 'W'
    if (gps.ele !== undefined) {
      tags.GPSAltitude = Math.abs(gps.ele)
      tags.GPSAltitudeRef = gps.ele < 0 ? 1 : 0
    }
  }
  if (timeCorrection) {
    tags.DateTimeOriginal = timeCorrection.exifDateTime
    tags.CreateDate = timeCorrection.exifDateTime
    tags.OffsetTimeOriginal = timeCorrection.tzOffset
    tags.OffsetTimeDigitized = timeCorrection.tzOffset
  }

  const result = await writeMetadata(input, tags, { fetch: wasmFetch })
  if (!result.success) {
    throw new Error(result.error || `exiftool failed with exit code ${result.exitCode}`)
  }
  const outBytes: Uint8Array = result.data instanceof Uint8Array ? result.data : new Uint8Array(result.data as ArrayBuffer)

  // Verify with an independent read before the caller may overwrite anything.
  // exifr does this in milliseconds; a second full ExifTool run (Perl boot +
  // VFS copies) used to double the per-photo cost. ExifTool remains the
  // fallback for formats exifr cannot parse.
  await verifyOutput(fileName, outBytes, gps, timeCorrection)
  if (outBytes.length < bytes.byteLength * 0.5) {
    throw new Error('Rewritten file is implausibly small — refusing to overwrite original')
  }
  return outBytes.buffer.slice(outBytes.byteOffset, outBytes.byteOffset + outBytes.byteLength) as ArrayBuffer
}

function exifDateTimeOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

async function verifyOutput(
  fileName: string,
  outBytes: Uint8Array,
  gps: GeoPoint | undefined,
  timeCorrection?: WorkerTimeCorrection
): Promise<void> {
  let parsed: Record<string, unknown> | undefined
  try {
    const buf = outBytes.buffer.slice(outBytes.byteOffset, outBytes.byteOffset + outBytes.byteLength)
    parsed = await exifr.parse(buf, { tiff: true, exif: true, gps: true })
  } catch {
    parsed = undefined
  }

  if (parsed) {
    if (gps) {
      const lat = parsed.latitude
      const lon = parsed.longitude
      if (typeof lat !== 'number' || typeof lon !== 'number') {
        throw new Error('GPS missing from rewritten file — refusing to overwrite original')
      }
      if (Math.abs(lat - gps.lat) > 1e-4 || Math.abs(lon - gps.lon) > 1e-4) {
        throw new Error('GPS in rewritten file does not match assigned position')
      }
    }
    if (timeCorrection) {
      const dto = parsed.DateTimeOriginal
      if (!(dto instanceof Date) || exifDateTimeOf(dto) !== timeCorrection.exifDateTime) {
        throw new Error('Corrected capture time missing from rewritten file — refusing to overwrite original')
      }
    }
    return
  }

  // exifr could not parse this format — fall back to a full ExifTool read.
  const verify = await parseMetadata<Array<Record<string, unknown>>>(
    { name: fileName, data: outBytes },
    {
      args: ['-json', '-n', '-GPSLatitude', '-GPSLongitude', '-DateTimeOriginal'],
      transform: (s) => JSON.parse(s) as Array<Record<string, unknown>>,
      fetch: wasmFetch,
    }
  )
  if (!verify.success) throw new Error(`verification read failed: ${verify.error}`)
  const entry = verify.data[0] ?? {}
  if (gps) {
    const lat = entry.GPSLatitude
    const lon = entry.GPSLongitude
    if (typeof lat !== 'number' || typeof lon !== 'number') {
      throw new Error('GPS missing from rewritten file — refusing to overwrite original')
    }
    if (Math.abs(lat - gps.lat) > 1e-4 || Math.abs(lon - gps.lon) > 1e-4) {
      throw new Error('GPS in rewritten file does not match assigned position')
    }
  }
  if (timeCorrection && entry.DateTimeOriginal !== timeCorrection.exifDateTime) {
    throw new Error('Corrected capture time missing from rewritten file — refusing to overwrite original')
  }
}

/**
 * Full raw tag dump for diagnostics. -ee scans embedded documents too —
 * e.g. the MP4 trailer of Samsung/Android "motion photos", which can carry
 * GPS that gallery apps read even when the EXIF GPS was stripped.
 */
async function inspect(fileName: string, bytes: ArrayBuffer): Promise<string> {
  const result = await parseMetadata(
    { name: fileName, data: new Uint8Array(bytes) },
    { args: ['-ee', '-a', '-G3:1', '-s'], fetch: wasmFetch }
  )
  if (!result.success) {
    throw new Error(result.error || `exiftool failed with exit code ${result.exitCode}`)
  }
  return result.data
}

self.onmessage = async (event: MessageEvent<ExiftoolRequest>) => {
  const msg = event.data
  try {
    if (msg.type === 'write-gps') {
      const out = await writeGps(msg.fileName, msg.bytes, msg.gps, msg.timeCorrection)
      postMessage(
        { type: 'result', requestId: msg.requestId, ok: true, bytes: out } satisfies ExiftoolResponse,
        { transfer: [out] }
      )
    } else {
      const text = await inspect(msg.fileName, msg.bytes)
      postMessage({ type: 'result', requestId: msg.requestId, ok: true, text } satisfies ExiftoolResponse)
    }
  } catch (err) {
    postMessage({
      type: 'result',
      requestId: msg.requestId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } satisfies ExiftoolResponse)
  }
}
