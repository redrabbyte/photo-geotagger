import type { Track, TrackPointRef } from './types'

export interface NeighborPair {
  before?: TrackPointRef
  after?: TrackPointRef
  /** True when before/after are adjacent points of the same segment. */
  sameSegment: boolean
}

/** Index of the last point with t <= tMs within [lo, hi], or lo-1 if none. */
function lowerBound(track: Track, tMs: number, lo: number, hi: number): number {
  let result = lo - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (track.points[mid].t <= tMs) {
      result = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return result
}

function ref(track: Track, index: number, tMs: number): TrackPointRef {
  const p = track.points[index]
  return {
    trackId: track.id,
    index,
    point: { lat: p.lat, lon: p.lon, ele: p.ele },
    t: p.t,
    deltaMs: p.t - tMs,
  }
}

/**
 * Find the surrounding trackpoints for a moment in time within a single track.
 * Segment boundaries are respected: before/after are only flagged sameSegment
 * when they belong to the same <trkseg>.
 */
export function findNeighborsInTrack(track: Track, tMs: number): NeighborPair {
  let best: NeighborPair = { sameSegment: false }
  let bestDelta = Infinity
  for (const seg of track.segments) {
    const idx = lowerBound(track, tMs, seg.startIdx, seg.endIdx)
    const before = idx >= seg.startIdx ? ref(track, idx, tMs) : undefined
    const afterIdx = idx + 1
    const after = afterIdx <= seg.endIdx ? ref(track, afterIdx, tMs) : undefined
    const delta = Math.min(
      before ? Math.abs(before.deltaMs) : Infinity,
      after ? Math.abs(after.deltaMs) : Infinity
    )
    if (delta < bestDelta) {
      bestDelta = delta
      best = { before, after, sameSegment: before !== undefined && after !== undefined }
    }
  }
  return best
}

/**
 * Find the best neighbor pair across all tracks: the pair whose nearest
 * point minimizes |Δt| to the photo time.
 */
export function findNeighbors(tracks: Track[], tMs: number): NeighborPair {
  let best: NeighborPair = { sameSegment: false }
  let bestDelta = Infinity
  for (const track of tracks) {
    if (track.points.length === 0) continue
    const pair = findNeighborsInTrack(track, tMs)
    const delta = Math.min(
      pair.before ? Math.abs(pair.before.deltaMs) : Infinity,
      pair.after ? Math.abs(pair.after.deltaMs) : Infinity
    )
    if (delta < bestDelta) {
      bestDelta = delta
      best = pair
    }
  }
  return best
}
