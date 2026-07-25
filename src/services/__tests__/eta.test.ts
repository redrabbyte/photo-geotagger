import { describe, it, expect } from 'vitest'
import { makeBatchEtaEstimator } from '../eta'

describe('makeBatchEtaEstimator', () => {
  it('returns undefined before the first sample, 0 when nothing remains', () => {
    const eta = makeBatchEtaEstimator(1)
    expect(eta.estimate({ jpeg: 3 })).toBeUndefined()
    eta.record('jpeg', 500)
    expect(eta.estimate({})).toBe(0)
    expect(eta.estimate({ jpeg: 0 })).toBe(0)
  })

  it('projects per-class service times', () => {
    const eta = makeBatchEtaEstimator(1)
    eta.record('jpeg', 200)
    eta.record('raw', 2000)
    expect(eta.estimate({ jpeg: 2, raw: 3 })).toBeCloseTo(2 * 200 + 3 * 2000, 5)
  })

  it('does not whipsaw when JPEGs and RAWs finish alternately', () => {
    // The old inter-arrival estimator produced a mixed rate that jumped up
    // and down with each completion; per-class rates must stay put.
    const eta = makeBatchEtaEstimator(1)
    const remaining = { jpeg: 5, raw: 5 }
    // Warm-up: one sample per class (the first RAW sample legitimately raises
    // the estimate — before it, the RAW cost is simply unknown).
    eta.record('jpeg', 200)
    remaining.jpeg--
    eta.record('raw', 2000)
    remaining.raw--
    const estimates: number[] = [eta.estimate(remaining)!]
    const durations: Array<['jpeg' | 'raw', number]> = [
      ['jpeg', 210], ['raw', 1990], ['jpeg', 195], ['raw', 2010], ['jpeg', 205], ['raw', 2000],
    ]
    for (const [kind, d] of durations) {
      eta.record(kind, d)
      remaining[kind]--
      estimates.push(eta.estimate(remaining)!)
    }
    // Each step removes one file's worth of work — the estimate must strictly
    // decrease, never bounce back up after a fast JPEG.
    for (let i = 1; i < estimates.length; i++) {
      expect(estimates[i]).toBeLessThan(estimates[i - 1])
    }
  })

  it('divides by the worker count so parallel bursts do not spike the ETA', () => {
    // 2 workers batching 3 files per run: every file measures ~one batch
    // duration; the division by the concurrency cancels the inflation.
    const eta = makeBatchEtaEstimator(6)
    for (let i = 0; i < 6; i++) eta.record('raw', 5000)
    // 6 more files across 6 in-flight slots ≈ one more batch round.
    expect(eta.estimate({ raw: 6 })).toBeCloseTo(5000, -2)
    // Near the tail, idle workers cannot speed up a single file: one RAW's
    // duration is the floor.
    expect(eta.estimate({ raw: 2 })).toBeCloseTo(5000, -2)
  })

  it('does not divide serial classes by the worker count', () => {
    // Videos run one at a time in ExifTool mode: their remaining work is the
    // full sum, while parallel classes still share the workers.
    const eta = makeBatchEtaEstimator(4, { serialKinds: new Set(['video']) })
    eta.record('raw', 4000)
    eta.record('video', 20_000)
    expect(eta.estimate({ video: 3 })).toBeCloseTo(60_000, -2)
    expect(eta.estimate({ raw: 4, video: 2 })).toBeCloseTo(40_000 + 4000, -2)
    // Without the exemption the same videos would look 4× faster.
    const parallel = makeBatchEtaEstimator(4)
    parallel.record('video', 20_000)
    expect(parallel.estimate({ video: 3 })).toBeCloseTo(20_000, -2)
  })

  it('prices an unmeasured class from the closest measured one via the priors', () => {
    const priors = { jpeg: 1, raw: 25, video: 250 }
    const eta = makeBatchEtaEstimator(1, { priors })
    // Only JPEGs measured: a RAW is assumed to cost 25 of them.
    eta.record('jpeg', 40)
    expect(eta.estimate({ raw: 2 })).toBeCloseTo(2 * 25 * 40, 5)
    // Once RAWs measure themselves, videos scale off RAW (the closest class),
    // not off the far cheaper JPEGs.
    eta.record('raw', 2000)
    expect(eta.estimate({ video: 1 })).toBeCloseTo((2000 * 250) / 25, 5)
  })

  it('a run of JPEGs does not collapse the projection for queued RAWs and videos', () => {
    // The user-visible bug: JPEGs are ~40× cheaper than RAWs, so a batch of
    // them finishing in a fraction of a second used to gut the estimate for
    // the heavy files still queued (they were priced by a blended average).
    const priors = { jpeg: 1, raw: 25, video: 250 }
    const eta = makeBatchEtaEstimator(8, { priors, serialKinds: new Set(['video']) })
    const remaining = { jpeg: 30, raw: 5, video: 3 }
    eta.record('raw', 2000) // one RAW went first
    const before = eta.estimate(remaining)!
    // Eight JPEGs complete back to back — a blink of real time.
    for (let i = 0; i < 8; i++) {
      eta.record('jpeg', 50)
      remaining.jpeg--
    }
    const after = eta.estimate(remaining)!
    // The heavy work is untouched, so the estimate may only shed the JPEGs.
    expect(after).toBeLessThanOrEqual(before)
    expect(after).toBeGreaterThan(before * 0.9)
    // And the video tail still dominates it (3 × ~20 s), not ~1 s.
    expect(after).toBeGreaterThan(50_000)
  })

  it('does not let queued fast files depress a slow tail', () => {
    // 8 JPEGs alongside 3 RAWs must not divide the RAW work by 8 workers —
    // otherwise the estimate jumps up the moment the JPEGs are done.
    const eta = makeBatchEtaEstimator(8, { priors: { jpeg: 1, raw: 25 } })
    eta.record('jpeg', 50)
    eta.record('raw', 2000)
    const withJpegs = eta.estimate({ jpeg: 8, raw: 3 })!
    const rawsOnly = eta.estimate({ raw: 3 })!
    expect(withJpegs).toBeGreaterThanOrEqual(rawsOnly)
    expect(withJpegs - rawsOnly).toBeLessThan(500)
  })

  it('adapts to recent durations (recency bias)', () => {
    const eta = makeBatchEtaEstimator(1)
    eta.record('raw', 6000) // cold boot
    for (let i = 0; i < 9; i++) eta.record('raw', 1000)
    const est = eta.estimate({ raw: 1 })!
    expect(est).toBeLessThan(1500)
    expect(est).toBeGreaterThan(900)
  })
})
