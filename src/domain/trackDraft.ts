import type { GeoPoint, Track, TrackId } from './types'
import { haversineMeters } from './gpsMath'
import { projectOntoTrack, type TrackProjection } from './projectOntoTrack'

export interface DraftPoint {
  lat: number
  lon: number
  /** Epoch ms. */
  t: number
  /** Time anchored by the user (or from the original GPX); never recomputed. */
  manual: boolean
}

export interface TrackDraft {
  /** Set when editing an existing track; commit replaces that track. */
  trackId?: TrackId
  name: string
  points: DraftPoint[]
}

/**
 * Recompute the times of automatic points: between two manual anchors, time
 * is distributed by cumulative distance along the intermediate points. Falls
 * back to even spacing when the geometry has zero length.
 * First and last point are manual by construction (enforced by the UI).
 */
export function reinterpolateTimes(points: DraftPoint[]): DraftPoint[] {
  const out = points.map((p) => ({ ...p }))
  let anchor = -1
  for (let i = 0; i < out.length; i++) {
    if (!out[i].manual) continue
    if (anchor >= 0 && i - anchor > 1) {
      const a = out[anchor]
      const b = out[i]
      const cum: number[] = [0]
      let total = 0
      for (let j = anchor; j < i; j++) {
        total += haversineMeters(out[j], out[j + 1])
        cum.push(total)
      }
      for (let j = anchor + 1; j < i; j++) {
        const f = total === 0 ? (j - anchor) / (i - anchor) : cum[j - anchor] / total
        out[j].t = Math.round(a.t + (b.t - a.t) * f)
      }
    }
    if (out[i].manual) anchor = i
  }
  return out
}

/** Insert an automatic point after the given index; its time comes from distance interpolation. */
export function insertAutoPoint(
  points: DraftPoint[],
  afterIndex: number,
  pos: GeoPoint
): DraftPoint[] {
  const pts = points.map((p) => ({ ...p }))
  pts.splice(afterIndex + 1, 0, { lat: pos.lat, lon: pos.lon, t: 0, manual: false })
  return reinterpolateTimes(pts)
}

export function moveDraftPoint(points: DraftPoint[], index: number, pos: GeoPoint): DraftPoint[] {
  const pts = points.map((p) => ({ ...p }))
  pts[index] = { ...pts[index], lat: pos.lat, lon: pos.lon }
  return reinterpolateTimes(pts)
}

/** Set a point's time manually; it becomes an anchor and neighbors re-interpolate. */
export function setDraftPointTime(points: DraftPoint[], index: number, t: number): DraftPoint[] {
  const pts = points.map((p) => ({ ...p }))
  pts[index] = { ...pts[index], t, manual: true }
  return reinterpolateTimes(pts)
}

export function deleteDraftPoint(points: DraftPoint[], index: number): DraftPoint[] {
  if (index <= 0 || index >= points.length - 1) return points // endpoints stay
  const pts = points.filter((_, i) => i !== index)
  return reinterpolateTimes(pts)
}

/** Times must be non-decreasing for a valid GPX track. */
export function validateDraftTimes(points: DraftPoint[]): string | undefined {
  for (let i = 1; i < points.length; i++) {
    if (points[i].t < points[i - 1].t) {
      return `Point ${i + 1} is earlier than point ${i} — fix the times before saving`
    }
  }
  return undefined
}

export function draftFromTrack(track: Track): TrackDraft {
  return {
    trackId: track.id,
    name: track.name,
    // Recorded points carry real times: all manual anchors.
    points: track.points.map((p) => ({ lat: p.lat, lon: p.lon, t: p.t, manual: true })),
  }
}

export function trackFromDraft(
  draft: TrackDraft,
  id: TrackId,
  color: string,
  fileName?: string
): Track {
  const points = draft.points.map((p) => ({ lat: p.lat, lon: p.lon, t: p.t }))
  return {
    id,
    name: draft.name,
    fileName: fileName ?? `${draft.name}.gpx`,
    color,
    points,
    segments: [{ startIdx: 0, endIdx: points.length - 1 }],
    startMs: points[0].t,
    endMs: points[points.length - 1].t,
  }
}

/** Project a coordinate onto the draft polyline (for insert-by-dragging-the-line). */
export function projectOntoDraft(points: DraftPoint[], target: GeoPoint): TrackProjection | undefined {
  if (points.length < 2) return undefined
  const pseudo: Track = {
    id: 'draft',
    name: 'draft',
    fileName: '',
    color: '',
    points: points.map((p) => ({ lat: p.lat, lon: p.lon, t: p.t })),
    segments: [{ startIdx: 0, endIdx: points.length - 1 }],
    startMs: points[0].t,
    endMs: points[points.length - 1].t,
  }
  return projectOntoTrack(pseudo, target)
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Serialize draft points as a GPX 1.1 document. */
export function generateGpx(name: string, points: DraftPoint[]): string {
  const trkpts = points
    .map(
      (p) =>
        `   <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}"><time>${new Date(p.t).toISOString().replace(/\.\d{3}Z$/, 'Z')}</time></trkpt>`
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="photo-geotagger" xmlns="http://www.topografix.com/GPX/1/1">
 <trk>
  <name>${xmlEscape(name)}</name>
  <trkseg>
${trkpts}
  </trkseg>
 </trk>
</gpx>
`
}
