import type { Photo, Source, Track, TrackPoint } from './types'
import { displayPosition, effectiveUtcMs } from './types'

export interface TrackFromPhotosResult {
  track: Track
  /** Photos that contributed a trackpoint. */
  used: number
  /** Photos skipped for lack of GPS position or usable time. */
  skipped: number
}

/**
 * Build a GPX track from photos: every photo with a position (assigned,
 * sidecar, or embedded GPS) and a usable time becomes a trackpoint, sorted
 * by time. Photos without either are skipped, not an error.
 * Returns an error message when fewer than two usable points remain.
 */
export function trackFromPhotos(
  photos: Photo[],
  sources: Record<string, Source>,
  id: string,
  name?: string
): TrackFromPhotosResult | string {
  const raw: TrackPoint[] = []
  for (const p of photos) {
    const source = sources[p.sourceId]
    const pos = displayPosition(p)
    const t = source ? effectiveUtcMs(p, source) : undefined
    if (!pos || t === undefined) continue
    raw.push({ lat: pos.lat, lon: pos.lon, ele: pos.ele, t })
  }
  raw.sort((a, b) => a.t - b.t)
  // Interpolation divides by the time delta between neighbors — collapse
  // burst shots with identical timestamps to one point (the first).
  const points = raw.filter((p, i) => i === 0 || p.t !== raw[i - 1].t)
  if (points.length < 2) {
    return 'Need at least two selected photos with a GPS position and a usable time'
  }
  const trackName = name ?? `Photos ${new Date(points[0].t).toISOString().slice(0, 10)}`
  return {
    track: {
      id,
      name: trackName,
      fileName: `${trackName.replace(/[^\w.-]+/g, '_')}.gpx`,
      color: '',
      points,
      segments: [{ startIdx: 0, endIdx: points.length - 1 }],
      startMs: points[0].t,
      endMs: points[points.length - 1].t,
    },
    used: points.length,
    skipped: photos.length - points.length,
  }
}
