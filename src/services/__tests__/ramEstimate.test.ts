import { describe, it, expect } from 'vitest'
import { estimatePeakRam, formatBytes, type RamEstimateInput } from '../ramEstimate'

const MB = 1024 * 1024
const raws = (count: number, sizeMb = 20) =>
  Array.from({ length: count }, () => ({ sizeBytes: sizeMb * MB, kind: 'raw' as const }))

const base: Omit<RamEstimateInput, 'files' | 'limits'> = {
  mode: 'exiftool',
  fastRaw: false,
  fastMp4: false,
}

describe('estimatePeakRam', () => {
  it('counts only as many files as run at once', () => {
    const files = raws(50)
    const three = estimatePeakRam({ ...base, files, limits: { exiftoolWorkers: 1, writeConcurrency: 3 } })
    const six = estimatePeakRam({ ...base, files, limits: { exiftoolWorkers: 1, writeConcurrency: 6 } })
    // 3 vs 6 files at 3x 20 MB, plus one resident interpreter either way.
    expect(three.totalBytes).toBe(25 * MB + 3 * 3 * 20 * MB)
    expect(six.totalBytes - three.totalBytes).toBe(3 * 3 * 20 * MB)
  })

  it('charges each ExifTool worker for its resident interpreter', () => {
    const files = raws(4)
    const one = estimatePeakRam({ ...base, files, limits: { exiftoolWorkers: 1, writeConcurrency: 2 } })
    const four = estimatePeakRam({ ...base, files, limits: { exiftoolWorkers: 4, writeConcurrency: 2 } })
    expect(four.totalBytes - one.totalBytes).toBe(3 * 25 * MB)
    expect(four.workerBytes).toBe(4 * 25 * MB)
  })

  it('drops the interpreter cost when the fast paths cover everything', () => {
    const files = [...raws(4), { sizeBytes: 500 * MB, kind: 'video' as const }]
    const wasm = estimatePeakRam({ ...base, files, limits: { exiftoolWorkers: 3, writeConcurrency: 2 } })
    const fast = estimatePeakRam({
      ...base,
      files,
      fastRaw: true,
      fastMp4: true,
      limits: { exiftoolWorkers: 3, writeConcurrency: 2 },
    })
    expect(wasm.wasmUnused).toBe(false)
    expect(fast.wasmUnused).toBe(true)
    expect(fast.workerBytes).toBe(0)
    // Fast RAW holds 2x instead of 3x, and a huge clip streams instead of
    // being buffered whole — so the estimate drops a lot.
    expect(fast.totalBytes).toBeLessThan(wasm.totalBytes / 4)
  })

  it('takes the largest files, since those drive the peak', () => {
    const files = [
      { sizeBytes: 60 * MB, kind: 'raw' as const },
      { sizeBytes: 20 * MB, kind: 'raw' as const },
      { sizeBytes: 2 * MB, kind: 'jpeg' as const },
    ]
    const one = estimatePeakRam({ ...base, files, limits: { exiftoolWorkers: 1, writeConcurrency: 1 } })
    expect(one.totalBytes).toBe(25 * MB + 3 * 60 * MB)
  })

  it('safe mode only buffers JPEGs — everything else gets a sidecar', () => {
    const files = [...raws(4), { sizeBytes: 8 * MB, kind: 'jpeg' as const }]
    const safe = estimatePeakRam({
      ...base,
      mode: 'safe',
      files,
      limits: { exiftoolWorkers: 4, writeConcurrency: 6 },
    })
    expect(safe.workerBytes).toBe(0)
    expect(safe.totalBytes).toBe(2 * 8 * MB)
  })

  it('counts only one WASM video rewrite, since those take turns', () => {
    const clips = Array.from({ length: 3 }, () => ({ sizeBytes: 400 * MB, kind: 'video' as const }))
    const serial = estimatePeakRam({ ...base, files: clips, limits: { exiftoolWorkers: 1, writeConcurrency: 6 } })
    // One clip at 3x 400 MB plus the interpreter — not three clips.
    expect(serial.totalBytes).toBe(25 * MB + 3 * 400 * MB)
    // With fast MP4 they stream and run in parallel, which is far cheaper.
    const fast = estimatePeakRam({
      ...base,
      files: clips,
      fastMp4: true,
      limits: { exiftoolWorkers: 1, writeConcurrency: 6 },
    })
    expect(fast.totalBytes).toBeLessThan(20 * MB)
  })

  it('a serialized clip takes one of the slots, not an extra one', () => {
    const files = [{ sizeBytes: 400 * MB, kind: 'video' as const }, ...raws(10)]
    const two = estimatePeakRam({ ...base, files, limits: { exiftoolWorkers: 1, writeConcurrency: 2 } })
    // The clip plus ONE raw, not the clip plus two.
    expect(two.totalBytes).toBe(25 * MB + 3 * 400 * MB + 3 * 20 * MB)
  })

  it('never reports zero files as free-for-all', () => {
    const empty = estimatePeakRam({ ...base, files: [], limits: { exiftoolWorkers: 2, writeConcurrency: 8 } })
    expect(empty.totalBytes).toBe(0)
    expect(empty.wasmUnused).toBe(true)
  })
})

describe('formatBytes', () => {
  it('scales the unit to the magnitude', () => {
    expect(formatBytes(240 * 1e6)).toBe('240 MB')
    expect(formatBytes(1.25 * 1e9)).toBe('1.3 GB')
    expect(formatBytes(4096)).toBe('4 kB')
  })
})
