/**
 * Capture-date extraction for MP4/MOV without ExifTool: a full ExifTool run
 * would need the whole (multi-GB) file inside the WASM filesystem just to
 * read a date. Both sources here need only tiny byte ranges via Blob.slice:
 *
 * 1. Sony XAVC (C0167.MP4 …): a uuid box near the file start carries XML
 *    non-real-time metadata with `<CreationDate value="…+HH:MM"/>` — the
 *    tag ExifTool shows as CreationDateValue. Local time WITH timezone,
 *    so it is the best possible source.
 * 2. Generic QuickTime: moov/mvhd creation_time (seconds since 1904, UTC).
 */
export interface VideoDate {
  /** Wall-clock capture time as epoch ms (fields interpreted as UTC). */
  wallClockMs: number
  /** Minutes east of UTC when the source carries a timezone. */
  tzOffsetMin?: number
}

const SECONDS_1904_TO_1970 = 2_082_844_800

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

/** Walk top-level boxes to moov (start OR end of file), then read mvhd. */
async function mvhdCreationDate(blob: Blob): Promise<VideoDate | undefined> {
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
      // mvhd is a direct child, normally right at the front of moov.
      const body = new DataView(
        await blob.slice(offset + headerLen, Math.min(offset + size, offset + headerLen + 1024 * 1024)).arrayBuffer()
      )
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
          const creation =
            version === 1 ? Number(body.getBigUint64(p + hl + 4)) : body.getUint32(p + hl + 4)
          const ms = (creation - SECONDS_1904_TO_1970) * 1000
          // 0 or garbage (cameras with unset clocks) → not usable.
          if (ms < Date.UTC(1980, 0, 1)) return undefined
          return { wallClockMs: ms, tzOffsetMin: 0 }
        }
        p += s
      }
      return undefined
    }
    offset += size
  }
  return undefined
}

/** Best available capture date of a video file, or undefined. */
export async function readVideoCaptureDate(blob: Blob): Promise<VideoDate | undefined> {
  try {
    return (await sonyCreationDate(blob)) ?? (await mvhdCreationDate(blob))
  } catch {
    return undefined
  }
}
