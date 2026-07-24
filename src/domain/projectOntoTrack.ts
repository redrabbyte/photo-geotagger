import type { GeoPoint, Track } from './types'
import { lerpPoint } from './gpsMath'

export interface TrackProjection {
  point: GeoPoint
  /** Interpolated time at the projected position. */
  t: number
  /** Squared distance in the projection plane (for comparisons only). */
  distSq: number
  /** Index of the trackpoint starting the polyline piece that was hit. */
  pointIndex: number
}

/**
 * Project a coordinate onto the nearest point of a track's polyline.
 * Uses an equirectangular approximation around the cursor latitude — accurate
 * enough for picking a position on a visible track at any practical zoom.
 */
export function projectOntoTrack(track: Track, target: GeoPoint): TrackProjection | undefined {
  const cosLat = Math.cos((target.lat * Math.PI) / 180)
  const toXY = (p: { lat: number; lon: number }) => {
    let dLon = p.lon - target.lon
    if (dLon > 180) dLon -= 360
    else if (dLon < -180) dLon += 360
    return { x: dLon * cosLat, y: p.lat - target.lat }
  }

  let best: TrackProjection | undefined
  for (const seg of track.segments) {
    for (let i = seg.startIdx; i < seg.endIdx; i++) {
      const a = track.points[i]
      const b = track.points[i + 1]
      const pa = toXY(a)
      const pb = toXY(b)
      const dx = pb.x - pa.x
      const dy = pb.y - pa.y
      const lenSq = dx * dx + dy * dy
      // Fraction along segment closest to origin (the target point).
      const f = lenSq === 0 ? 0 : Math.min(1, Math.max(0, -(pa.x * dx + pa.y * dy) / lenSq))
      const px = pa.x + dx * f
      const py = pa.y + dy * f
      const distSq = px * px + py * py
      if (!best || distSq < best.distSq) {
        best = {
          point: lerpPoint(a, b, f),
          t: a.t + (b.t - a.t) * f,
          distSq,
          pointIndex: i,
        }
      }
    }
    // Single-point segment: the point itself is a candidate.
    if (seg.startIdx === seg.endIdx) {
      const a = track.points[seg.startIdx]
      const pa = toXY(a)
      const distSq = pa.x * pa.x + pa.y * pa.y
      if (!best || distSq < best.distSq) {
        best = {
          point: { lat: a.lat, lon: a.lon, ele: a.ele },
          t: a.t,
          distSq,
          pointIndex: seg.startIdx,
        }
      }
    }
  }
  return best
}
