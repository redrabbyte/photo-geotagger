/**
 * Remaining-time estimator for write batches.
 *
 * Instead of inter-arrival times between completions (which whipsaw when
 * fast JPEGs and slow RAWs alternate, and when parallel workers deliver
 * completions in bursts), the pipeline feeds it each file's measured
 * service duration. The estimator keeps one exponentially weighted average
 * per file class — recent files dominate, so a cold start stops distorting
 * the estimate after a few files — and projects:
 *
 *   ETA = Σ remaining[kind] × rate[kind] / min(concurrency, remainingTotal)
 *
 * Per-file durations measured under worker-side batching inflate by the
 * batch factor (all files of a batch finish after the whole run), and the
 * division by concurrency cancels exactly that — the projection stays
 * consistent for serial, parallel, and batched execution alike.
 *
 * Classes named in `serialKinds` are exempt from that division: the pipeline
 * runs them one at a time (videos in ExifTool mode hold whole files in WASM
 * memory), so dividing their work by the worker count would under-report the
 * tail of a batch by up to the full concurrency factor.
 */
export interface BatchEtaEstimator {
  /** Feed one completed file's class and measured duration. */
  record(kind: string, durationMs: number): void
  /** Project the remaining wall time for the given per-class counts. */
  estimate(remaining: Record<string, number>): number | undefined
}

export function makeBatchEtaEstimator(
  concurrency: number,
  options: { serialKinds?: ReadonlySet<string>; alpha?: number } = {}
): BatchEtaEstimator {
  const { serialKinds, alpha = 0.3 } = options
  const rateByKind = new Map<string, number>()
  /** Fallback for classes without a sample yet (e.g. RAWs before the first finishes). */
  let globalRate: number | undefined

  return {
    record(kind, durationMs) {
      const prev = rateByKind.get(kind)
      rateByKind.set(kind, prev === undefined ? durationMs : prev + alpha * (durationMs - prev))
      globalRate = globalRate === undefined ? durationMs : globalRate + alpha * (durationMs - globalRate)
    },

    estimate(remaining) {
      let parallelMs = 0
      let serialMs = 0
      let count = 0
      for (const [kind, n] of Object.entries(remaining)) {
        if (n <= 0) continue
        const rate = rateByKind.get(kind) ?? globalRate
        if (rate === undefined) return undefined
        if (serialKinds?.has(kind)) serialMs += rate * n
        else {
          parallelMs += rate * n
          count += n
        }
      }
      if (count === 0 && serialMs === 0) return 0
      return serialMs + parallelMs / Math.max(1, Math.min(concurrency, count))
    },
  }
}
