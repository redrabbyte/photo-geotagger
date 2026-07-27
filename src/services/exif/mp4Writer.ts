/**
 * Pure-JS metadata writer for MP4/MOV — the "experimental fast MP4" path.
 *
 * ExifTool-in-WASM must pull the whole video through the interpreter's memory
 * several times; this writer instead edits the few boxes the app actually
 * sets (mvhd timestamps, ©xyz GPS, the Keys entries) and never touches the
 * media data. The dangerous part of MP4 editing — the absolute chunk offsets
 * in stco/co64 that point into mdat — is avoided *structurally* instead of
 * being recalculated:
 *
 * - moov is the LAST top-level box (typical for camera recordings): the file
 *   up to moov stays byte-identical, only a rebuilt moov is appended.
 * - moov sits BEFORE mdat ("faststart", typical for phones): the old moov's
 *   type is patched to `free` (dead padding, 4 bytes) and the rebuilt moov is
 *   appended at the end. mdat does not move a single byte either way, so
 *   every chunk offset stays valid without ever being parsed.
 *
 * Anything the parser does not fully understand throws Mp4StructureError —
 * the caller falls back to the ExifTool path. The built moov is verified with
 * the app's own readers before it is handed back.
 */
import type { GeoPoint } from '../../domain/types'
import { childBoxes, gpsFromMoov, mvhdDateFromMoov, parseBoxHeader, topLevelBoxes } from './videoMeta'

/** Structure this writer does not handle — callers fall back to ExifTool. */
export class Mp4StructureError extends Error {}

export interface Mp4TimeEdit {
  /** True capture instant as epoch ms (mvhd stores UTC). */
  utcMs: number
  /**
   * Minutes east of UTC — Keys creationdate carries the local time. Undefined
   * when nothing states a zone: mvhd still gets the UTC instant, but no local
   * time is claimed.
   */
  tzOffsetMin?: number
}

export interface Mp4Edit {
  gps?: GeoPoint
  time?: Mp4TimeEdit
}

const SECONDS_1904_TO_1970 = 2_082_844_800
const MOOV_EDIT_LIMIT = 64 * 1024 * 1024
const KEY_LOCATION = 'com.apple.quicktime.location.ISO6709'
const KEY_CREATIONDATE = 'com.apple.quicktime.creationdate'

// ---- byte-level box building ----

const ascii = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

const u32 = (n: number): Uint8Array => {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, n)
  return out
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** Assemble one box: 32-bit size + fourcc + body parts. */
function box(type: string, ...body: Uint8Array[]): Uint8Array {
  const size = 8 + body.reduce((n, p) => n + p.length, 0)
  return concatBytes([u32(size), ascii(type), ...body])
}

// ---- payload formats ----

/** "+48.8581+002.2947+035.000/" — the padded style Apple devices write. */
export function formatIso6709(gps: GeoPoint): string {
  const f = (v: number, intDigits: number, decimals: number) => {
    const s = Math.abs(v).toFixed(decimals)
    const dot = s.indexOf('.')
    return (v < 0 ? '-' : '+') + s.slice(0, dot).padStart(intDigits, '0') + s.slice(dot)
  }
  const ele = gps.ele !== undefined ? f(gps.ele, 3, 3) : ''
  return `${f(gps.lat, 2, 4)}${f(gps.lon, 3, 4)}${ele}/`
}

/** "2026-07-04T12:30:00+0200" — local wall clock with offset (Apple style). */
export function formatKeysCreationDate(time: Mp4TimeEdit & { tzOffsetMin: number }): string {
  const local = new Date(time.utcMs + time.tzOffsetMin * 60_000)
  const p = (n: number) => String(n).padStart(2, '0')
  const abs = Math.abs(time.tzOffsetMin)
  const tz = `${time.tzOffsetMin < 0 ? '-' : '+'}${p(Math.floor(abs / 60))}${p(abs % 60)}`
  return (
    `${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(local.getUTCDate())}` +
    `T${p(local.getUTCHours())}:${p(local.getUTCMinutes())}:${p(local.getUTCSeconds())}${tz}`
  )
}

/** ©xyz body: 2-byte string length, 2-byte language code, ISO 6709 string. */
function xyzBox(gps: GeoPoint): Uint8Array {
  const value = ascii(formatIso6709(gps))
  const head = new Uint8Array(4)
  new DataView(head.buffer).setUint16(0, value.length)
  new DataView(head.buffer).setUint16(2, 0x15c7) // packed 'eng'
  return box('©xyz', head, value)
}

// ---- child slicing ----

interface Child {
  type: string
  /** Whole box including header, as a view into the parent body. */
  bytes: Uint8Array
  headerLen: number
}

/** Slice a container body into child boxes; throws when it doesn't add up. */
function sliceChildren(body: Uint8Array, context: string): Child[] {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  const children: Child[] = []
  let consumed = 0
  for (const { header, offset } of childBoxes(view)) {
    children.push({
      type: header.type,
      bytes: body.subarray(offset, offset + header.size),
      headerLen: header.headerLen,
    })
    consumed = offset + header.size
  }
  if (consumed !== body.byteLength) {
    throw new Mp4StructureError(`Unparseable ${context} contents — falling back to ExifTool`)
  }
  return children
}

const bodyOf = (c: Child): Uint8Array => c.bytes.subarray(c.headerLen)

/** Rebuild a container from its (possibly replaced/extended) children. */
function rebuild(type: string, children: Child[], append: Uint8Array[]): Uint8Array {
  return box(type, ...children.map((c) => c.bytes), ...append)
}

// ---- mvhd ----

function patchMvhd(mvhd: Child, time: Mp4TimeEdit): Uint8Array {
  const bytes = mvhd.bytes.slice()
  const view = new DataView(bytes.buffer)
  const p = mvhd.headerLen
  const version = view.getUint8(p)
  const seconds = Math.floor(time.utcMs / 1000) + SECONDS_1904_TO_1970
  if (version === 0) {
    if (bytes.length < p + 12) throw new Mp4StructureError('Truncated mvhd')
    view.setUint32(p + 4, seconds) // creation_time
    view.setUint32(p + 8, seconds) // modification_time
  } else if (version === 1) {
    if (bytes.length < p + 20) throw new Mp4StructureError('Truncated mvhd')
    view.setBigUint64(p + 4, BigInt(seconds))
    view.setBigUint64(p + 12, BigInt(seconds))
  } else {
    throw new Mp4StructureError(`Unknown mvhd version ${version}`)
  }
  return bytes
}

// ---- udta / ©xyz ----

function upsertUdta(udta: Child | undefined, gps: GeoPoint): Uint8Array {
  if (!udta) return box('udta', xyzBox(gps))
  const children = sliceChildren(bodyOf(udta), 'udta').filter((c) => c.type !== '©xyz')
  return rebuild('udta', children, [xyzBox(gps)])
}

// ---- meta / keys / ilst ----

interface MetaLayout {
  /** ISO-style meta carries 4 version/flags bytes before its children. */
  versionFlags: Uint8Array | undefined
  children: Child[]
}

/**
 * moov/meta comes in two flavours: QuickTime (children start immediately)
 * and ISO (4 version/flags bytes first). Detect by whether a plausible box
 * header sits at offset 0.
 */
function parseMeta(meta: Child): MetaLayout {
  const body = bodyOf(meta)
  const looksLikeChildren = (bytes: Uint8Array): boolean => {
    if (bytes.byteLength < 8) return false
    const header = parseBoxHeader(new DataView(bytes.buffer, bytes.byteOffset, Math.min(16, bytes.byteLength)), bytes.byteLength)
    return header !== undefined && /^[\x20-\x7e©]{4}$/.test(header.type)
  }
  if (looksLikeChildren(body)) return { versionFlags: undefined, children: sliceChildren(body, 'meta') }
  if (body.byteLength >= 4 && looksLikeChildren(body.subarray(4))) {
    return { versionFlags: body.slice(0, 4), children: sliceChildren(body.subarray(4), 'meta') }
  }
  throw new Mp4StructureError('Unrecognized meta box layout')
}

const MDTA_HDLR = box(
  'hdlr',
  u32(0), // version/flags
  u32(0), // predefined
  ascii('mdta'),
  new Uint8Array(12) // reserved
)

function parseKeyNames(keys: Child): string[] {
  const body = bodyOf(keys)
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  if (body.byteLength < 8) throw new Mp4StructureError('Truncated keys box')
  const count = view.getUint32(4)
  const names: string[] = []
  let p = 8
  for (let i = 0; i < count; i++) {
    if (p + 8 > body.byteLength) throw new Mp4StructureError('Truncated keys entry')
    const size = view.getUint32(p)
    const ns = new TextDecoder('latin1').decode(body.subarray(p + 4, p + 8))
    if (ns !== 'mdta' || size < 8 || p + size > body.byteLength) {
      throw new Mp4StructureError('Unsupported keys entry')
    }
    names.push(new TextDecoder().decode(body.subarray(p + 8, p + size)))
    p += size
  }
  if (p !== body.byteLength) throw new Mp4StructureError('Trailing bytes in keys box')
  return names
}

function buildKeysBox(names: string[]): Uint8Array {
  const entries = names.map((n) => {
    const bytes = new TextEncoder().encode(n)
    return concatBytes([u32(8 + bytes.length), ascii('mdta'), bytes])
  })
  return box('keys', u32(0), u32(names.length), ...entries)
}

/** ilst value entry: [size][key index][data box(type=1 UTF-8, locale=0, text)]. */
function buildIlstEntry(index: number, value: string): Uint8Array {
  const data = box('data', u32(1), u32(0), new TextEncoder().encode(value))
  return concatBytes([u32(8 + data.length), u32(index), data])
}

/**
 * Upsert Keys values. Existing keys keep their position (ilst entries refer
 * to keys by 1-based index), new keys are appended; entries for our keys are
 * replaced, all others carried over untouched.
 */
function upsertMeta(meta: Child | undefined, values: Map<string, string>): Uint8Array {
  let layout: MetaLayout = { versionFlags: undefined, children: [] }
  if (meta) layout = parseMeta(meta)

  const hdlr = layout.children.find((c) => c.type === 'hdlr')
  if (hdlr) {
    const handler = new TextDecoder('latin1').decode(bodyOf(hdlr).subarray(8, 12))
    if (handler !== 'mdta') throw new Mp4StructureError(`meta box owned by '${handler}' handler`)
  }
  const keysChild = layout.children.find((c) => c.type === 'keys')
  const ilstChild = layout.children.find((c) => c.type === 'ilst')
  const names = keysChild ? parseKeyNames(keysChild) : []
  const ilstEntries = ilstChild ? sliceChildren(bodyOf(ilstChild), 'ilst') : []

  const indexOf = new Map<string, number>()
  names.forEach((n, i) => indexOf.set(n, i + 1))
  for (const name of values.keys()) {
    if (!indexOf.has(name)) {
      names.push(name)
      indexOf.set(name, names.length)
    }
  }

  const ourIndices = new Set([...values.keys()].map((n) => indexOf.get(n)!))
  const keptEntries = ilstEntries.filter((e) => {
    const idx = new DataView(e.bytes.buffer, e.bytes.byteOffset, 8).getUint32(4)
    return !ourIndices.has(idx)
  })
  const newEntries = [...values.entries()].map(([name, value]) => buildIlstEntry(indexOf.get(name)!, value))
  const ilst = box('ilst', ...keptEntries.map((e) => e.bytes), ...newEntries)

  const rest = layout.children.filter((c) => !['hdlr', 'keys', 'ilst'].includes(c.type))
  const parts: Uint8Array[] = []
  if (layout.versionFlags) parts.push(layout.versionFlags)
  parts.push(hdlr ? hdlr.bytes : MDTA_HDLR, buildKeysBox(names), ilst, ...rest.map((c) => c.bytes))
  return box('meta', ...parts)
}

// ---- the writer ----

export interface Mp4Rewrite {
  /** Write these parts in order — Blob slices for untouched spans. */
  parts: (Blob | Uint8Array)[]
  /** Total size of the rewritten file. */
  size: number
}

/**
 * Compute the rewritten file for a GPS/time edit without loading the media
 * data. Throws Mp4StructureError for anything not fully understood.
 */
export async function rewriteMp4Metadata(blob: Blob, edit: Mp4Edit): Promise<Mp4Rewrite> {
  if (!edit.gps && !edit.time) throw new Mp4StructureError('Nothing to write')

  let moov: { offset: number; size: number; headerLen: number } | undefined
  let consumed = 0
  let first = true
  for await (const { header, offset } of topLevelBoxes(blob)) {
    if (first && header.type !== 'ftyp') throw new Mp4StructureError('Not an MP4/MOV (no ftyp)')
    first = false
    if (offset + header.size > blob.size) throw new Mp4StructureError('Box exceeds file size')
    if (header.type === 'moov') {
      if (moov) throw new Mp4StructureError('Multiple moov boxes')
      moov = { offset, size: header.size, headerLen: header.headerLen }
    }
    consumed = offset + header.size
  }
  if (consumed !== blob.size) throw new Mp4StructureError('Unparseable top-level box structure')
  if (!moov) throw new Mp4StructureError('No moov box found')
  if (moov.headerLen !== 8) throw new Mp4StructureError('64-bit moov size')
  if (moov.size - moov.headerLen > MOOV_EDIT_LIMIT) throw new Mp4StructureError('moov too large to edit')

  const moovBody = new Uint8Array(
    await blob.slice(moov.offset + moov.headerLen, moov.offset + moov.size).arrayBuffer()
  )
  const children = sliceChildren(moovBody, 'moov')
  if (!children.some((c) => c.type === 'mvhd')) throw new Mp4StructureError('moov without mvhd')
  // Replacement below is keyed by type — bail on duplicates of the edited boxes.
  for (const type of ['mvhd', 'udta', 'meta']) {
    if (children.filter((c) => c.type === type).length > 1) {
      throw new Mp4StructureError(`Multiple ${type} boxes in moov`)
    }
  }

  const keysValues = new Map<string, string>()
  if (edit.gps) keysValues.set(KEY_LOCATION, formatIso6709(edit.gps))
  // Keys creationdate is a local time plus its offset — skip it entirely when
  // no zone is known rather than pass off UTC as local.
  if (edit.time?.tzOffsetMin !== undefined) {
    keysValues.set(KEY_CREATIONDATE, formatKeysCreationDate({ ...edit.time, tzOffsetMin: edit.time.tzOffsetMin }))
  }

  const append: Uint8Array[] = []
  const replaced = new Map<string, Uint8Array>()
  if (edit.time) {
    const mvhd = children.find((c) => c.type === 'mvhd')!
    replaced.set('mvhd', patchMvhd(mvhd, edit.time))
  }
  if (edit.gps) {
    const udta = children.find((c) => c.type === 'udta')
    const rebuilt = upsertUdta(udta, edit.gps)
    if (udta) replaced.set('udta', rebuilt)
    else append.push(rebuilt)
  }
  const metaChild = children.find((c) => c.type === 'meta')
  const rebuiltMeta = upsertMeta(metaChild, keysValues)
  if (metaChild) replaced.set('meta', rebuiltMeta)
  else append.push(rebuiltMeta)

  const newMoov = box(
    'moov',
    ...children.map((c) => replaced.get(c.type) ?? c.bytes),
    ...append
  )

  // Verify the construction with the app's own readers before returning it.
  const newBody = newMoov.subarray(8)
  if (edit.gps) {
    const back = gpsFromMoov(newBody)
    if (!back || Math.abs(back.lat - edit.gps.lat) > 1e-4 || Math.abs(back.lon - edit.gps.lon) > 1e-4) {
      throw new Mp4StructureError('GPS did not round-trip through the rebuilt moov')
    }
  }
  if (edit.time) {
    const back = mvhdDateFromMoov(newBody)
    if (!back || Math.abs(back.wallClockMs - edit.time.utcMs) > 1000) {
      throw new Mp4StructureError('Capture time did not round-trip through the rebuilt moov')
    }
  }

  // moov last → replace it. moov elsewhere → turn it into `free` padding and
  // append the rebuilt moov; mdat never moves, so stco/co64 stay valid.
  const parts: (Blob | Uint8Array)[] =
    moov.offset + moov.size === blob.size
      ? [blob.slice(0, moov.offset), newMoov]
      : [blob.slice(0, moov.offset + 4), ascii('free'), blob.slice(moov.offset + 8, blob.size), newMoov]
  return { parts, size: parts.reduce((n, p) => n + (p instanceof Blob ? p.size : p.length), 0) }
}
