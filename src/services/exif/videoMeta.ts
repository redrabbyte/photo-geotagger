/**
 * Capture-date and GPS extraction for MP4/MOV without ExifTool: a full
 * ExifTool run would need the whole (multi-GB) file inside the WASM
 * filesystem just to read a few fields. Everything here reads tiny byte
 * ranges via Blob.slice:
 *
 * Date:
 * 1. Sony XAVC (C0167.MP4 …): a uuid box near the file start carries XML
 *    non-real-time metadata with `<CreationDate value="…+HH:MM"/>` — the
 *    tag ExifTool shows as CreationDateValue. Local time WITH timezone,
 *    so it is the best possible source.
 * 2. Generic QuickTime: moov/mvhd creation_time (seconds since 1904, UTC).
 *
 * GPS (what players/galleries read, and what our own writer produces):
 * 1. moov/udta/©xyz — UserData GPSCoordinates, an ISO 6709 string.
 * 2. Keys com.apple.quicktime.location.ISO6709 — same string format,
 *    found by pattern inside moov (the ilst indirection is not worth
 *    parsing structurally).
 */
import type { GeoPoint } from '../../domain/types'

export interface VideoDate {
  /** Wall-clock capture time as epoch ms (fields interpreted as UTC). */
  wallClockMs: number
  /** Minutes east of UTC when the source carries a timezone. */
  tzOffsetMin?: number
}

export interface VideoMeta {
  date?: VideoDate
  gps?: GeoPoint
}

const SECONDS_1904_TO_1970 = 2_082_844_800
const MOOV_READ_LIMIT = 8 * 1024 * 1024

/** Sony XML metadata sits within the first ~2 MB; binary noise around the
 * ASCII XML survives lossy UTF-8 decoding just fine for a regex. */
async function sonyCreationDate(blob: Blob): Promise<VideoDate | undefined> {
  const head = await blob.slice(0, Math.min(blob.size, 2 * 1024 * 1024)).text()
  const m =
    /<CreationDate[^>]*?\bvalue="(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?"/.exec(
      head
    )
  if (!m) return undefined
  const wallClockMs = Date.UTC(
    parseInt(m[1], 10),
    parseInt(m[2], 10) - 1,
    parseInt(m[3], 10),
    parseInt(m[4], 10),
    parseInt(m[5], 10),
    parseInt(m[6], 10)
  )
  let tzOffsetMin: number | undefined
  const tz = m[7]
  if (tz === 'Z') tzOffsetMin = 0
  else if (tz) {
    const tm = /([+-])(\d{2}):?(\d{2})/.exec(tz)
    if (tm) tzOffsetMin = (tm[1] === '-' ? -1 : 1) * (parseInt(tm[2], 10) * 60 + parseInt(tm[3], 10))
  }
  return { wallClockMs, tzOffsetMin }
}

function fourCC(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  )
}

/** Walk top-level boxes and return the moov body (moov may sit at the start
 * or the end of the file). */
async function findMoov(blob: Blob): Promise<Uint8Array | undefined> {
  let offset = 0
  for (let guard = 0; guard < 64 && offset + 8 <= blob.size; guard++) {
    const header = new DataView(await blob.slice(offset, Math.min(blob.size, offset + 16)).arrayBuffer())
    if (header.byteLength < 8) return undefined
    let size = header.getUint32(0)
    const type = fourCC(header, 4)
    let headerLen = 8
    if (size === 1) {
      if (header.byteLength < 16) return undefined
      size = Number(header.getBigUint64(8))
      headerLen = 16
    } else if (size === 0) {
      size = blob.size - offset
    }
    if (size < headerLen) return undefined
    if (type === 'moov') {
      const end = Math.min(offset + size, offset + headerLen + MOOV_READ_LIMIT)
      return new Uint8Array(await blob.slice(offset + headerLen, end).arrayBuffer())
    }
    offset += size
  }
  return undefined
}

/** moov/mvhd creation_time (UTC, seconds since 1904). */
function mvhdDateFromMoov(moov: Uint8Array): VideoDate | undefined {
  const body = new DataView(moov.buffer, moov.byteOffset, moov.byteLength)
  let p = 0
  while (p + 8 <= body.byteLength) {
    let s = body.getUint32(p)
    const t = fourCC(body, p + 4)
    let hl = 8
    if (s === 1) {
      if (p + 16 > body.byteLength) break
      s = Number(body.getBigUint64(p + 8))
      hl = 16
    }
    if (s < hl) break
    if (t === 'mvhd') {
      if (p + hl + 12 > body.byteLength) break
      const version = body.getUint8(p + hl)
      const creation = version === 1 ? Number(body.getBigUint64(p + hl + 4)) : body.getUint32(p + hl + 4)
      const ms = (creation - SECONDS_1904_TO_1970) * 1000
      // 0 or garbage (cameras with unset clocks) → not usable.
      if (ms < Date.UTC(1980, 0, 1)) return undefined
      return { wallClockMs: ms, tzOffsetMin: 0 }
    }
    p += s
  }
  return undefined
}

/** "+48.8581+002.2947+035.000/" (ISO 6709) → GeoPoint. */
function parseIso6709(s: string): GeoPoint | undefined {
  const m = /^([+-]\d{1,2}(?:\.\d+)?)([+-]\d{1,3}(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?/.exec(s.trim())
  if (!m) return undefined
  const lat = parseFloat(m[1])
  const lon = parseFloat(m[2])
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined
  const ele = m[3] !== undefined ? parseFloat(m[3]) : undefined
  return { lat, lon, ele }
}

/** GPS from moov: the ©xyz UserData atom, else any ISO 6709 token (Keys). */
function gpsFromMoov(moov: Uint8Array): GeoPoint | undefined {
  // Lossy latin1-ish decode: box names and the coordinate strings are ASCII.
  let text = ''
  for (let i = 0; i < moov.length; i++) text += String.fromCharCode(moov[i])

  // ©xyz atom: [2-byte length][2-byte language][ISO 6709 string]
  const xyz = text.indexOf('©xyz')
  if (xyz >= 0 && xyz + 8 <= text.length) {
    const len = (moov[xyz + 4] << 8) | moov[xyz + 5]
    const value = text.slice(xyz + 8, xyz + 8 + len)
    const gps = parseIso6709(value)
    if (gps) return gps
  }
  // Keys value (com.apple.quicktime.location.ISO6709) — find by shape.
  // Decimals are required to keep random binary from matching.
  const m = /[+-]\d{1,2}\.\d+[+-]\d{1,3}\.\d+(?:[+-]\d+(?:\.\d+)?)?\/?/.exec(text)
  if (m) return parseIso6709(m[0])
  return undefined
}

/**
 * Metadata-only copy of an MP4/MOV: every top-level box except mdat, which
 * is replaced by an empty `free` box. ExifTool reads all container metadata
 * (moov, Sony's XML uuid, …) from it — without the multi-GB media payload
 * that no ArrayBuffer could hold. Undefined when the structure is unusual
 * or the metadata alone exceeds the limit; callers then fall back.
 * (Timed metadata inside mdat — e.g. Sony rtmd per-frame tags — is absent
 * from the copy by construction.)
 */
export async function metadataOnlyCopy(
  blob: Blob,
  limit = 64 * 1024 * 1024
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const FREE_BOX = new Uint8Array([0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65])
  const parts: Uint8Array[] = []
  let total = 0
  let offset = 0
  for (let guard = 0; guard < 64 && offset + 8 <= blob.size; guard++) {
    const header = new DataView(await blob.slice(offset, Math.min(blob.size, offset + 16)).arrayBuffer())
    if (header.byteLength < 8) return undefined
    let size = header.getUint32(0)
    const type = fourCC(header, 4)
    let headerLen = 8
    if (size === 1) {
      if (header.byteLength < 16) return undefined
      size = Number(header.getBigUint64(8))
      headerLen = 16
    } else if (size === 0) {
      size = blob.size - offset
    }
    if (size < headerLen || offset + size > blob.size) return undefined
    // Anything not starting with ftyp is not an MP4 worth slimming down.
    if (offset === 0 && type !== 'ftyp') return undefined
    if (type === 'mdat') {
      parts.push(FREE_BOX)
      total += FREE_BOX.length
    } else {
      if (total + size > limit) return undefined
      parts.push(new Uint8Array(await blob.slice(offset, offset + size).arrayBuffer()))
      total += size
    }
    offset += size
    if (offset === blob.size) {
      const out = new Uint8Array(total)
      let o = 0
      for (const p of parts) {
        out.set(p, o)
        o += p.length
      }
      return out
    }
  }
  return undefined
}

/** Best available capture date + GPS of a video file. */
export async function readVideoMetadata(blob: Blob): Promise<VideoMeta> {
  try {
    const moov = await findMoov(blob)
    const date = (await sonyCreationDate(blob)) ?? (moov ? mvhdDateFromMoov(moov) : undefined)
    const gps = moov ? gpsFromMoov(moov) : undefined
    return { date, gps }
  } catch {
    return {}
  }
}

/** Best available capture date of a video file, or undefined. */
export async function readVideoCaptureDate(blob: Blob): Promise<VideoDate | undefined> {
  return (await readVideoMetadata(blob)).date
}
