/**
 * Remaining-time estimator for write batches.
 *
 * The counts per file class are known before the first file is touched, and
 * they do not depend on the processing order — only the per-file cost has to
 * be learned. So the estimator keeps one exponentially weighted average per
 * class (recent files dominate, so a cold start stops distorting the estimate
 * after a few files) and projects:
 *
 *   ETA = Σ serial[kind] × rate[kind]
 *       + max( Σ parallel[kind] × rate[kind] / concurrency, slowest rate )
 *
 * Two properties matter more than precision here:
 *
 * - **A class is never priced by another class's measurements.** A class with
 *   no sample yet is priced from the measured class of most similar cost via
 *   `priors` (relative per-file cost, e.g. a RAW rewrite costs ~25 JPEGs).
 *   A blended global average would instead make a run of fast JPEGs collapse
 *   the projection for the RAWs and videos still queued.
 * - **Draining one class does not move another's projection.** The parallel
 *   mass is divided by the worker count, but never below the slowest single
 *   remaining file: one file cannot be split across workers. Without that
 *   floor, a handful of queued JPEGs would divide a slow RAW tail by the full
 *   worker count and the estimate would jump the moment they finish.
 *
 * Per-file durations measured under worker-side batching inflate by the batch
 * factor (all files of a batch finish after the whole run), and the division
 * by concurrency cancels exactly that.
 *
 * Classes named in `serialKinds` skip the division: the pipeline runs them one
 * at a time (videos in ExifTool mode hold whole files in WASM memory), so
 * dividing their work by the worker count would under-report the tail of a
 * batch by up to the full concurrency factor.
 */
export interface BatchEtaEstimator {
  /** Feed one completed file's class and measured duration. */
  record(kind: string, durationMs: number): void
  /** Project the remaining wall time for the given per-class counts. */
  estimate(remaining: Record<string, number>): number | undefined
}

export interface BatchEtaOptions {
  /** Classes the pipeline runs strictly one at a time. */
  serialKinds?: ReadonlySet<string>
  /**
   * Relative per-file cost per class — only used to price classes that have no
   * measurement yet, by scaling the measured class of most similar cost.
   * Absolute units are irrelevant; only the ratios are.
   */
  priors?: Record<string, number>
  /** EWMA weight of the newest sample. */
  alpha?: number
}

export function makeBatchEtaEstimator(concurrency: number, options: BatchEtaOptions = {}): BatchEtaEstimator {
  const { serialKinds, priors = {}, alpha = 0.3 } = options
  const rateByKind = new Map<string, number>()
  const priorValues = Object.values(priors).filter((v) => v > 0)
  const fallbackPrior = priorValues.length > 0 ? Math.max(...priorValues) : 1
  /** Unknown classes are assumed expensive rather than cheap — never collapse. */
  const priorOf = (kind: string) => {
    const p = priors[kind]
    return p !== undefined && p > 0 ? p : fallbackPrior
  }

  /**
   * Cost of one file of this class: its own measurement when it has one, else
   * the measured class whose prior cost is closest, scaled by the prior ratio.
   */
  const priceOf = (kind: string): number | undefined => {
    const measured = rateByKind.get(kind)
    if (measured !== undefined) return measured
    const prior = priorOf(kind)
    let best: { rate: number; prior: number; distance: number } | undefined
    for (const [other, rate] of rateByKind) {
      const otherPrior = priorOf(other)
      const distance = Math.abs(Math.log(prior / otherPrior))
      if (!best || distance < best.distance) best = { rate, prior: otherPrior, distance }
    }
    if (!best) return undefined
    return (best.rate * prior) / best.prior
  }

  return {
    record(kind, durationMs) {
      const prev = rateByKind.get(kind)
      rateByKind.set(kind, prev === undefined ? durationMs : prev + alpha * (durationMs - prev))
    },

    estimate(remaining) {
      let parallelMs = 0
      let serialMs = 0
      let slowest = 0
      let count = 0
      for (const [kind, n] of Object.entries(remaining)) {
        if (n <= 0) continue
        const rate = priceOf(kind)
        if (rate === undefined) return undefined
        if (serialKinds?.has(kind)) {
          serialMs += rate * n
        } else {
          parallelMs += rate * n
          slowest = Math.max(slowest, rate)
          count += n
        }
      }
      if (count === 0 && serialMs === 0) return 0
      // A single file is never faster than itself, however many workers idle.
      return serialMs + Math.max(parallelMs / Math.max(1, concurrency), count > 0 ? slowest : 0)
    },
  }
}
