import { describe, it, expect } from 'vitest'
import { makeEtaEstimator } from '../eta'

describe('makeEtaEstimator', () => {
  it('returns undefined before the first completion', () => {
    const eta = makeEtaEstimator()
    expect(eta(0, 10, 0)).toBeUndefined()
    expect(eta(0, 10, 5000)).toBeUndefined()
  })

  it('estimates from a steady rate', () => {
    const eta = makeEtaEstimator()
    eta(0, 10, 0)
    for (let i = 1; i <= 5; i++) eta(i, 10, i * 1000)
    // 1s per file, 5 remaining.
    expect(eta(5, 10, 5000)!).toBeCloseTo(5000, -2)
  })

  it('recovers quickly from a slow cold start (recency bias)', () => {
    const eta = makeEtaEstimator()
    eta(0, 20, 0)
    eta(1, 20, 5000) // first file: 5s (cold boot)
    const coldEta = eta(1, 20, 5000)!
    expect(coldEta).toBeCloseTo(5000 * 19, -3)
    // Next 9 files at 500ms each.
    for (let i = 2; i <= 10; i++) eta(i, 20, 5000 + (i - 1) * 500)
    const warmEta = eta(10, 20, 5000 + 9 * 500)!
    // 10 files remain; a global average would still predict ~9.5s
    // ((5000+4500)/10 per file × 10). Recency bias must be well below that
    // and near the true ~5s.
    expect(warmEta).toBeLessThan(7500)
    expect(warmEta).toBeGreaterThan(4500)
  })

  it('weights a batch of completions like that many single ones', () => {
    const single = makeEtaEstimator()
    single(0, 10, 0)
    single(1, 10, 1000)
    single(2, 10, 1100)
    single(3, 10, 1200)

    const batched = makeEtaEstimator()
    batched(0, 10, 0)
    batched(1, 10, 1000)
    batched(3, 10, 1200) // two files complete together at 100ms each

    expect(batched(3, 10, 1200)!).toBeCloseTo(single(3, 10, 1200)!, 0)
  })

  it('does not change the estimate while no file completes', () => {
    const eta = makeEtaEstimator()
    eta(0, 10, 0)
    eta(1, 10, 1000)
    const a = eta(1, 10, 1500)
    const b = eta(1, 10, 9000)
    expect(a).toBe(b)
  })
})
