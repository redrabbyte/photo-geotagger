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
  /** Max time distance for inheriting from an adjacent geotagged photo. */
  maxInheritGapMs: number
}

export const DEFAULT_MATCH_SETTINGS: MatchSettings = {
  maxInheritGapMs: 600_000,
}

export type MatchResult =
  | { ok: true; assignment: PositionAssignment }
  | { ok: false; reason: 'no-time' | 'no-match' | 'no-neighbor' }

export interface TimedPosition {
  photoId: string
  t: number
  point: GeoPoint
}

/** One usable reference next to the photo's time: a trackpoint, or — when no
 * track has a point on that side at all — a geotagged photo. */
interface Side {
  point: GeoPoint
  t: number
  deltaMs: number
  track?: TrackPointRef
  photoId?: string
}

/** Nearest reference photos before/after t (refs sorted by t ascending). */
function photoRefNeighbors(refs: TimedPosition[], t: number): { before?: TimedPosition; after?: TimedPosition } {
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
  return { before: idx >= 0 ? refs[idx] : undefined, after: refs[idx + 1] }
}

/**
 * Compute a track-based assignment for one photo.
 * Methods: closest | before | after | interpolated.
 * Sides without ANY trackpoint fall back to geotagged reference photos, so
 * the methods keep working before/after/without GPX coverage.
 */
export function matchToTracks(
  photo: Photo,
  source: Source,
  tracks: Track[],
  method: Extract<AssignmentMethod, 'closest' | 'before' | 'after' | 'interpolated'>,
  photoRefs: TimedPosition[] = []
): MatchResult {
  const t = effectiveUtcMs(photo, source)
  if (t === undefined) return { ok: false, reason: 'no-time' }

  // No time cutoff: a photo taken hours outside the track still snaps to the
  // nearest/previous/next trackpoint — the delta is shown in the inspector.
  const pair = findNeighbors(tracks, t)
  const refPair = photoRefNeighbors(photoRefs, t)
  // Tracks win per side; photo references only fill a side no track covers.
  const before: Side | undefined = pair.before
    ? { point: pair.before.point, t: pair.before.t, deltaMs: pair.before.deltaMs, track: pair.before }
    : refPair.before
      ? { point: refPair.before.point, t: refPair.before.t, deltaMs: refPair.before.t - t, photoId: refPair.before.photoId }
      : undefined
  const after: Side | undefined = pair.after
    ? { point: pair.after.point, t: pair.after.t, deltaMs: pair.after.deltaMs, track: pair.after }
    : refPair.after
      ? { point: refPair.after.point, t: refPair.after.t, deltaMs: refPair.after.t - t, photoId: refPair.after.photoId }
      : undefined
  if (!before && !after) return { ok: false, reason: 'no-match' }

  const trackNeighbors = pair.before || pair.after ? { before: pair.before, after: pair.after } : undefined

  const fromSide = (
    m: Extract<AssignmentMethod, 'closest' | 'before' | 'after' | 'interpolated'>,
    side: Side,
    degraded?: boolean
  ): MatchResult => ({
    ok: true,
    assignment: {
      method: m,
      point: roundGps(side.point),
      trackId: side.track?.trackId,
      neighbors: trackNeighbors,
      inheritedFrom: side.photoId,
      effectiveUtcMs: t,
      degraded,
    },
  })

  const closest = (): Side => {
    if (before && after) {
      return Math.abs(before.deltaMs) <= Math.abs(after.deltaMs) ? before : after
    }
    return (before ?? after)!
  }

  switch (method) {
    case 'before': {
      if (!before) return { ok: false, reason: 'no-neighbor' }
      return fromSide(method, before)
    }
    case 'after': {
      if (!after) return { ok: false, reason: 'no-neighbor' }
      return fromSide(method, after)
    }
    case 'closest': {
      return fromSide(method, closest())
    }
    case 'interpolated': {
      // True track interpolation needs adjacent points of one segment (any
      // gap size); between segments or tracks it degrades to closest, flagged.
      if (pair.before && pair.after) {
        const canInterpolate = pair.sameSegment && pair.before.trackId === pair.after.trackId
        if (!canInterpolate) return fromSide('closest', closest(), true)
        const span = pair.after.t - pair.before.t
        const f = span === 0 ? 0 : (t - pair.before.t) / span
        const clamped = Math.min(1, Math.max(0, f))
        const point = roundGps(lerpPoint(pair.before.point, pair.after.point, clamped))
        return {
          ok: true,
          assignment: {
            method,
            point,
            trackId: pair.before.trackId,
            neighbors: trackNeighbors,
            effectiveUtcMs: t,
          },
        }
      }
      // A side without track coverage: interpolate against reference photos
      // (possibly mixing a trackpoint on one side with a photo on the other).
      if (before && after) {
        const span = after.t - before.t
        const f = span === 0 ? 0 : (t - before.t) / span
        const clamped = Math.min(1, Math.max(0, f))
        const point = roundGps(lerpPoint(before.point, after.point, clamped))
        const nearest = Math.abs(before.deltaMs) <= Math.abs(after.deltaMs) ? before : after
        return {
          ok: true,
          assignment: {
            method,
            point,
            neighbors: trackNeighbors,
            inheritedFrom: nearest.photoId ?? (before.photoId || after.photoId),
            effectiveUtcMs: t,
          },
        }
      }
      // Only one side exists at all — degrade to that point, flagged.
      return fromSide('closest', closest(), true)
    }
  }
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
