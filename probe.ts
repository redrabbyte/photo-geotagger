import { recommendedExiftoolPool } from './src/services/writePipeline'

// Mirror of writeConcurrency in appActions (kept in sync by this probe).
function writeConcurrency(s: { writeMode: string; parallelExiftool: boolean; fastRaw: boolean; fastMp4: boolean }, mobile: boolean) {
  if (s.writeMode !== 'exiftool') return 6
  const pooled = recommendedExiftoolPool(s.parallelExiftool) * 3
  const fastPath = s.fastRaw || s.fastMp4
  return Math.min(8, Math.max(pooled, fastPath ? (mobile ? 4 : 6) : 0))
}

;(window as unknown as Record<string, unknown>).__probe = async () => {
  const rows = []
  for (const mobile of [false, true]) {
    for (const parallel of [false, true]) {
      for (const fast of [false, true]) {
        rows.push({
          device: mobile ? 'mobile' : 'desktop',
          'Parallel (RAW)': parallel ? 'on' : 'off',
          'fast RAW/MP4': fast ? 'on' : 'off',
          jobs: writeConcurrency(
            { writeMode: 'exiftool', parallelExiftool: parallel, fastRaw: fast, fastMp4: fast },
            mobile
          ),
        })
      }
    }
  }
  return rows
}
