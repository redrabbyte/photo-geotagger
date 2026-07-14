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
 * Find the surrounding trackpoints for a moment in time within a single
 * track: the LATEST point at/before tMs and the EARLIEST point after it,
 * each searched independently across all segments. sameSegment is true only
 * when both come from the same <trkseg> (then they are adjacent points).
 */
export function findNeighborsInTrack(track: Track, tMs: number): NeighborPair {
  let before: TrackPointRef | undefined
  let after: TrackPointRef | undefined
  let beforeSeg = -1
  let afterSeg = -1
  for (let segIdx = 0; segIdx < track.segments.length; segIdx++) {
    const seg = track.segments[segIdx]
    const idx = lowerBound(track, tMs, seg.startIdx, seg.endIdx)
    if (idx >= seg.startIdx) {
      const cand = ref(track, idx, tMs)
      if (!before || cand.t > before.t) {
        before = cand
        beforeSeg = segIdx
      }
    }
    if (idx + 1 <= seg.endIdx) {
      const cand = ref(track, idx + 1, tMs)
      if (!after || cand.t < after.t) {
        after = cand
        afterSeg = segIdx
      }
    }
  }
  return {
    before,
    after,
    sameSegment: before !== undefined && after !== undefined && beforeSeg === afterSeg,
  }
}

/**
 * Find the surrounding trackpoints across ALL tracks: best before and best
 * after are chosen independently, so a photo between two tracks gets the
 * earlier track's end as 'before' and the later track's start as 'after'.
 */
export function findNeighbors(tracks: Track[], tMs: number): NeighborPair {
  let before: TrackPointRef | undefined
  let after: TrackPointRef | undefined
  let beforeTrack: Track | undefined
  let afterTrack: Track | undefined
  let beforePairSameSegment = false
  for (const track of tracks) {
    if (track.points.length === 0) continue
    const pair = findNeighborsInTrack(track, tMs)
    if (pair.before && (!before || pair.before.t > before.t)) {
      before = pair.before
      beforeTrack = track
      beforePairSameSegment = pair.sameSegment
    }
    if (pair.after && (!after || pair.after.t < after.t)) {
      after = pair.after
      afterTrack = track
    }
  }
  return {
    before,
    after,
    // Adjacent within one segment only when both winners came from the same
    // track and that track's own pair was same-segment.
    sameSegment:
      before !== undefined && after !== undefined && beforeTrack === afterTrack && beforePairSameSegment,
  }
}
