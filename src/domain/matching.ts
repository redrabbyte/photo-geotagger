import type {
  AssignmentMethod,
  GeoPoint,
  Photo,
  PositionAssignment,
  Source,
  Track,
  TrackPointRef,
} from './types'
import { effectiveUtcMs, displayPosition } from './types'
import { findNeighbors } from './trackIndex'
import { lerpPoint, roundGps } from './gpsMath'

export interface MatchSettings {
  /** Never interpolate across a larger time gap between trackpoints. */
  maxGapMs: number
  /** Max time distance for inheriting from an adjacent geotagged photo. */
  maxInheritGapMs: number
}

export const DEFAULT_MATCH_SETTINGS: MatchSettings = {
  maxGapMs: 300_000,
  maxInheritGapMs: 600_000,
}

export type MatchResult =
  | { ok: true; assignment: PositionAssignment }
  | { ok: false; reason: 'no-time' | 'no-match' | 'no-neighbor' }

/**
 * Compute a track-based assignment for one photo.
 * Methods: closest | before | after | interpolated.
 */
export function matchToTracks(
  photo: Photo,
  source: Source,
  tracks: Track[],
  method: Extract<AssignmentMethod, 'closest' | 'before' | 'after' | 'interpolated'>,
  settings: MatchSettings = DEFAULT_MATCH_SETTINGS
): MatchResult {
  const t = effectiveUtcMs(photo, source)
  if (t === undefined) return { ok: false, reason: 'no-time' }

  // No time cutoff: a photo taken hours outside the track still snaps to the
  // nearest/previous/next trackpoint — the delta is shown in the inspector.
  const pair = findNeighbors(tracks, t)
  const before = pair.before
  const after = pair.after
  if (!before && !after) return { ok: false, reason: 'no-match' }

  const base: Omit<PositionAssignment, 'point' | 'method'> = {
    trackId: (before ?? after)!.trackId,
    neighbors: { before, after },
    effectiveUtcMs: t,
  }

  const closest = (): TrackPointRef => {
    if (before && after) {
      return Math.abs(before.deltaMs) <= Math.abs(after.deltaMs) ? before : after
    }
    return (before ?? after)!
  }

  switch (method) {
    case 'before': {
      if (!before) return { ok: false, reason: 'no-neighbor' }
      return { ok: true, assignment: { ...base, method, point: roundGps(before.point), trackId: before.trackId } }
    }
    case 'after': {
      if (!after) return { ok: false, reason: 'no-neighbor' }
      return { ok: true, assignment: { ...base, method, point: roundGps(after.point), trackId: after.trackId } }
    }
    case 'closest': {
      const c = closest()
      return { ok: true, assignment: { ...base, method, point: roundGps(c.point), trackId: c.trackId } }
    }
    case 'interpolated': {
      const canInterpolate =
        before !== undefined &&
        after !== undefined &&
        pair.sameSegment &&
        before.trackId === after.trackId &&
        after.t - before.t <= settings.maxGapMs
      if (!canInterpolate) {
        // Degrade to closest, flagged so the UI can surface it.
        const c = closest()
        return {
          ok: true,
          assignment: { ...base, method: 'closest', point: roundGps(c.point), trackId: c.trackId, degraded: true },
        }
      }
      const span = after.t - before.t
      const f = span === 0 ? 0 : (t - before.t) / span
      const clamped = Math.min(1, Math.max(0, f))
      const point = roundGps(lerpPoint(before.point, after.point, clamped))
      return { ok: true, assignment: { ...base, method, point } }
    }
  }
}

interface TimedPosition {
  photoId: string
  t: number
  point: GeoPoint
}

/**
 * Build the list of reference positions usable for inheritance: every photo
 * (any source) that has a position (original or assigned) and a usable time —
 * excluding the photos currently being assigned.
 */
export function buildInheritReferences(
  photos: Photo[],
  sources: Map<string, Source>,
  excludeIds: Set<string>
): TimedPosition[] {
  const refs: TimedPosition[] = []
  for (const p of photos) {
    if (excludeIds.has(p.id)) continue
    const pos = displayPosition(p)
    if (!pos) continue
    const src = sources.get(p.sourceId)
    if (!src) continue
    const t = effectiveUtcMs(p, src)
    if (t === undefined) continue
    refs.push({ photoId: p.id, t, point: pos })
  }
  refs.sort((a, b) => a.t - b.t)
  return refs
}

/**
 * Inherit a position from time-adjacent geotagged photos. Interpolates when a
 * reference exists on both sides, otherwise copies the nearest one.
 */
export function matchByInherit(
  photo: Photo,
  source: Source,
  refs: TimedPosition[],
  settings: MatchSettings = DEFAULT_MATCH_SETTINGS
): MatchResult {
  const t = effectiveUtcMs(photo, source)
  if (t === undefined) return { ok: false, reason: 'no-time' }
  if (refs.length === 0) return { ok: false, reason: 'no-match' }

  // Binary search: last ref with t <= photo time.
  let lo = 0
  let hi = refs.length - 1
  let idx = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (refs[mid].t <= t) {
      idx = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  const before = idx >= 0 ? refs[idx] : undefined
  const after = idx + 1 < refs.length ? refs[idx + 1] : undefined
  const beforeOk = before !== undefined && t - before.t <= settings.maxInheritGapMs
  const afterOk = after !== undefined && after.t - t <= settings.maxInheritGapMs

  if (beforeOk && afterOk) {
    const span = after.t - before.t
    const f = span === 0 ? 0 : (t - before.t) / span
    const point = roundGps(lerpPoint(before.point, after.point, f))
    const nearest = t - before.t <= after.t - t ? before : after
    return {
      ok: true,
      assignment: { method: 'inherit', point, inheritedFrom: nearest.photoId, effectiveUtcMs: t },
    }
  }
  const only = beforeOk ? before : afterOk ? after : undefined
  if (!only) return { ok: false, reason: 'no-match' }
  return {
    ok: true,
    assignment: { method: 'inherit', point: roundGps(only.point), inheritedFrom: only.photoId, effectiveUtcMs: t },
  }
}

export function manualAssignment(
  point: GeoPoint,
  effectiveUtc: number | undefined,
  onTrack?: { trackId: string }
): PositionAssignment {
  return {
    method: onTrack ? 'manual-on-track' : 'manual',
    point: roundGps(point),
    trackId: onTrack?.trackId,
    effectiveUtcMs: effectiveUtc ?? Number.NaN,
  }
}

/**
 * A track/inherit assignment is stale when the photo's effective time has
 * changed since it was computed (e.g. the source clock offset was edited).
 * Manual placements never go stale.
 */
export function isStale(photo: Photo, source: Source): boolean {
  const a = photo.assignment
  if (!a || a.method === 'manual' || a.method === 'manual-on-track') return false
  const t = effectiveUtcMs(photo, source)
  return t !== undefined && t !== a.effectiveUtcMs
}
