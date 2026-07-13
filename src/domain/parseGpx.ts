import type { Track, TrackPoint, TrackSegment } from './types'

export class GpxParseError extends Error {}

/**
 * Parse GPX XML into Tracks. Points without a <time> are dropped (they cannot
 * participate in time matching); a track whose points ALL lack time raises an
 * error so the UI can explain the file is unusable for matching.
 */
export function parseGpx(
  xml: string,
  fileName: string,
  makeId: (n: number) => string,
  parser: DOMParser = new DOMParser()
): Track[] {
  const doc = parser.parseFromString(xml, 'application/xml')
  if (doc.querySelector('parsererror')) {
    throw new GpxParseError(`${fileName}: not valid XML`)
  }
  const trkElems = Array.from(doc.getElementsByTagName('trk'))
  if (trkElems.length === 0) {
    throw new GpxParseError(`${fileName}: no <trk> elements found`)
  }

  const tracks: Track[] = []
  trkElems.forEach((trk, trkIdx) => {
    const name =
      trk.getElementsByTagName('name')[0]?.textContent?.trim() ||
      (trkElems.length > 1 ? `${fileName} #${trkIdx + 1}` : fileName)

    const points: TrackPoint[] = []
    const segments: TrackSegment[] = []
    let droppedNoTime = 0

    for (const seg of Array.from(trk.getElementsByTagName('trkseg'))) {
      const segStart = points.length
      for (const pt of Array.from(seg.getElementsByTagName('trkpt'))) {
        const lat = parseFloat(pt.getAttribute('lat') ?? '')
        const lon = parseFloat(pt.getAttribute('lon') ?? '')
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
        const timeText = pt.getElementsByTagName('time')[0]?.textContent
        const t = timeText ? Date.parse(timeText) : NaN
        if (!Number.isFinite(t)) {
          droppedNoTime++
          continue
        }
        const eleText = pt.getElementsByTagName('ele')[0]?.textContent
        const ele = eleText ? parseFloat(eleText) : undefined
        points.push({ lat, lon, t, ele: Number.isFinite(ele!) ? ele : undefined })
      }
      if (points.length > segStart) {
        // Ensure time-sortedness within the segment (GPX should already be sorted).
        const segment = points.slice(segStart).sort((a, b) => a.t - b.t)
        points.length = segStart
        points.push(...segment)
        segments.push({ startIdx: segStart, endIdx: points.length - 1 })
      }
    }

    if (points.length === 0) {
      throw new GpxParseError(
        droppedNoTime > 0
          ? `${fileName}: trackpoints have no timestamps — cannot use for time matching`
          : `${fileName}: track "${name}" contains no valid trackpoints`
      )
    }

    tracks.push({
      id: makeId(trkIdx),
      name,
      fileName,
      color: '',
      points,
      segments,
      startMs: points[0].t,
      endMs: points[points.length - 1].t,
    })
  })
  return tracks
}
