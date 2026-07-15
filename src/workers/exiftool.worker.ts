/// <reference lib="webworker" />
// Dedicated worker for ExifTool-WASM (zeroperl) writes: the Perl runtime is
// ~25 MB of WASM and each invocation takes noticeable CPU, so it stays off
// the main thread. Loaded lazily — this worker is only created when the user
// switches to ExifTool write mode.
//
// Requests are queued and consecutive write requests are coalesced into ONE
// ExifTool execution (argfile + -execute): the Perl boot dominates per-call
// cost, so batching N files per run cuts it to a fraction. Each request still
// gets its own response — batching is invisible to the caller.
import exifr from 'exifr'
// Vite emits the 25 MB WASM as a hashed asset; zeroperl's own relative
// "./zeroperl.wasm" URL would 404, so every request for it is redirected
// to the emitted asset via the custom fetch below.
// Relative path because the package's `exports` field forbids deep imports.
import zeroperlWasmUrl from '../../node_modules/@6over3/zeroperl-ts/dist/esm/zeroperl.wasm?url'
import {
  ExiftoolRunner,
  isFatalWasmError,
  parseViaExiftool,
  writeBatchViaExiftool,
  type BatchWriteItem,
} from '../services/exif/exiftoolRunner'
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

const runner = new ExiftoolRunner(wasmFetch)

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
  | { type: 'warmup'; requestId: number }

export type ExiftoolResponse =
  | { type: 'result'; requestId: number; ok: true; bytes: ArrayBuffer }
  | { type: 'result'; requestId: number; ok: true; text: string }
  | { type: 'result'; requestId: number; ok: false; error: string }

function tagsFor(gps: GeoPoint | undefined, timeCorrection?: WorkerTimeCorrection): Record<string, string | number> {
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
  return tags
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
  const verify = await withWasmRecovery(() =>
    parseViaExiftool(runner, fileName, outBytes, ['-json', '-n', '-GPSLatitude', '-GPSLongitude', '-DateTimeOriginal'])
  )
  if (!verify.success) throw new Error(`verification read failed: ${verify.error}`)
  const entry = (JSON.parse(verify.output) as Array<Record<string, unknown>>)[0] ?? {}
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
  const result = await withWasmRecovery(() =>
    parseViaExiftool(runner, fileName, new Uint8Array(bytes), ['-ee', '-a', '-G3:1', '-s'])
  )
  if (!result.success) throw new Error(result.error || 'exiftool failed')
  return result.output
}

type WriteRequest = Extract<ExiftoolRequest, { type: 'write-gps' }>

/** Files coalesced into one Perl execution. Bounds batch memory (~4×RAW). */
const MAX_BATCH = 4

const queue: ExiftoolRequest[] = []
let pumping = false

/**
 * Run fn; on a fatal WASM fault (corrupted interpreter, e.g. after the tab
 * was frozen in the background) rebuild the instance and retry once. The
 * input bytes are still intact in this worker, so the retry is free.
 */
async function withWasmRecovery<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!isFatalWasmError(msg)) throw err
    runner.rebuild()
    return await fn()
  }
}

function fail(requestId: number, err: unknown): void {
  postMessage({
    type: 'result',
    requestId,
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  } satisfies ExiftoolResponse)
}

async function handleWriteBatch(requests: WriteRequest[]): Promise<void> {
  const items: BatchWriteItem[] = requests.map((r) => ({
    name: r.fileName,
    bytes: new Uint8Array(r.bytes),
    tags: tagsFor(r.gps, r.timeCorrection),
  }))
  const results = await withWasmRecovery(() => writeBatchViaExiftool(runner, items))
  for (let i = 0; i < requests.length; i++) {
    const req = requests[i]
    const res = results[i]
    if (!res.ok) {
      fail(req.requestId, new Error(res.error))
      continue
    }
    try {
      // Verify with an independent read before the caller may overwrite
      // anything. exifr does this in milliseconds; ExifTool remains the
      // fallback for formats exifr cannot parse.
      await verifyOutput(req.fileName, res.bytes, req.gps, req.timeCorrection)
      if (res.bytes.length < req.bytes.byteLength * 0.5) {
        throw new Error('Rewritten file is implausibly small — refusing to overwrite original')
      }
      const out = res.bytes.buffer.slice(
        res.bytes.byteOffset,
        res.bytes.byteOffset + res.bytes.byteLength
      ) as ArrayBuffer
      postMessage(
        { type: 'result', requestId: req.requestId, ok: true, bytes: out } satisfies ExiftoolResponse,
        { transfer: [out] }
      )
    } catch (err) {
      fail(req.requestId, err)
    }
  }
}

async function pump(): Promise<void> {
  if (pumping) return
  pumping = true
  try {
    while (queue.length > 0) {
      const first = queue.shift()!
      if (first.type === 'write-gps') {
        if (!first.gps && !first.timeCorrection) {
          fail(first.requestId, new Error('Nothing to write'))
          continue
        }
        // Coalesce every write request that queued up while the previous
        // batch was running — this is what amortizes the Perl boot.
        const batch: WriteRequest[] = [first]
        while (batch.length < MAX_BATCH && queue[0]?.type === 'write-gps') {
          batch.push(queue.shift() as WriteRequest)
        }
        try {
          await handleWriteBatch(batch)
        } catch (err) {
          for (const r of batch) fail(r.requestId, err)
        }
      } else if (first.type === 'inspect') {
        try {
          const text = await inspect(first.fileName, first.bytes)
          postMessage({ type: 'result', requestId: first.requestId, ok: true, text } satisfies ExiftoolResponse)
        } catch (err) {
          fail(first.requestId, err)
        }
      } else {
        try {
          // Boot the interpreter and run once so the first real write does
          // not pay the cold start (WASM fetch + instantiation).
          const warm = await withWasmRecovery(async () => {
            await runner.boot()
            return runner.run(['-ver'], [])
          })
          postMessage({
            type: 'result',
            requestId: first.requestId,
            ok: true,
            text: warm.stdout.trim(),
          } satisfies ExiftoolResponse)
        } catch (err) {
          fail(first.requestId, err)
        }
      }
    }
  } finally {
    pumping = false
  }
}

self.onmessage = (event: MessageEvent<ExiftoolRequest>) => {
  queue.push(event.data)
  void pump()
}
