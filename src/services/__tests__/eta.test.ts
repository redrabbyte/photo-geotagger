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
    // Near the tail, fewer files than workers: the divisor shrinks with them.
    expect(eta.estimate({ raw: 2 })).toBeCloseTo((2 * 5000) / 2, -2)
  })

  it('falls back to the global rate for classes without samples', () => {
    const eta = makeBatchEtaEstimator(1)
    eta.record('jpeg', 300)
    expect(eta.estimate({ raw: 2 })).toBeCloseTo(600, 5)
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
