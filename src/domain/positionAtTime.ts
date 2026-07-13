import type { GeoPoint, Photo, Source, Track } from './types'
import { displayPosition, effectiveUtcMs } from './types'
import { findNeighborsInTrack } from './trackIndex'

/**
 * The coordinate best matching a moment in time: nearest in time wins;
 * on a tie tracks beat photos; on a further tie the first one found wins.
 */
export function positionAtTime(
  tracks: Track[],
  photos: Photo[],
  sources: Record<string, Source>,
  tMs: number
): GeoPoint | undefined {
  let best: { point: GeoPoint; absDelta: number; kindRank: number } | undefined
  const consider = (point: GeoPoint, absDelta: number, kindRank: number) => {
    if (
      !best ||
      absDelta < best.absDelta ||
      (absDelta === best.absDelta && kindRank < best.kindRank)
    ) {
      best = { point, absDelta, kindRank }
    }
  }
  for (const track of tracks) {
    const pair = findNeighborsInTrack(track, tMs)
    for (const ref of [pair.before, pair.after]) {
      if (ref) consider(ref.point, Math.abs(ref.deltaMs), 0)
    }
  }
  for (const p of photos) {
    const pos = displayPosition(p)
    const src = sources[p.sourceId]
    if (!pos || !src) continue
    const t = effectiveUtcMs(p, src)
    if (t === undefined) continue
    consider(pos, Math.abs(t - tMs), 1)
  }
  return best?.point
}
