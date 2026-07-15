/**
 * Remaining-time estimator with recency bias.
 *
 * Per-file duration is tracked as an exponentially weighted moving average,
 * so the estimate is dominated by the most recent completions: a slow cold
 * start (WASM boot, first batch) or a mid-batch switch between fast JPEGs
 * and slow RAWs stops distorting the ETA after a few files — unlike the
 * global average, which drags old outliers along to the end.
 */
export function makeEtaEstimator(alpha = 0.3): (done: number, total: number, nowMs: number) => number | undefined {
  let lastAt: number | undefined
  let lastDone = 0
  let ewmaMsPerFile: number | undefined

  return (done, total, nowMs) => {
    if (lastAt === undefined) lastAt = nowMs
    if (done > lastDone) {
      const sample = (nowMs - lastAt) / (done - lastDone)
      if (ewmaMsPerFile === undefined) {
        ewmaMsPerFile = sample
      } else {
        // One EWMA step per completed file: a batch of N completions moves
        // the average as far as N single ones would.
        const weight = 1 - Math.pow(1 - alpha, done - lastDone)
        ewmaMsPerFile += weight * (sample - ewmaMsPerFile)
      }
      lastAt = nowMs
      lastDone = done
    }
    return ewmaMsPerFile !== undefined ? ewmaMsPerFile * (total - done) : undefined
  }
}
