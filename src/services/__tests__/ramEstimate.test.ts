import { describe, it, expect } from 'vitest'
import {
  LIMIT_RANGES,
  estimatePeakRam,
  fitLimits,
  formatBytes,
  limitCeilings,
  ramBudgetBytes,
  type RamEstimateInput,
} from '../ramEstimate'

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

describe('why the WASM setting is moot', () => {
  const limits = { exiftoolWorkers: 2, writeConcurrency: 4 }

  it('names the reason, so the UI can explain instead of just greying out', () => {
    const raws4 = raws(4)
    // Nothing loaded at all.
    expect(estimatePeakRam({ ...base, files: [], limits }).wasmUnusedReason).toBe('no-files')
    // Safe mode never runs the interpreter.
    expect(estimatePeakRam({ ...base, mode: 'safe', files: raws4, limits }).wasmUnusedReason).toBe('safe-mode')
    // The fast path took the files over — the reason the user needs to hear.
    expect(estimatePeakRam({ ...base, fastRaw: true, files: raws4, limits }).wasmUnusedReason).toBe('fast-paths')
    // JPEGs have their own pure-JS writer either way.
    const jpegs = [{ sizeBytes: 4 * MB, kind: 'jpeg' as const }]
    expect(estimatePeakRam({ ...base, files: jpegs, limits }).wasmUnusedReason).toBe('no-such-files')
    // And no reason at all while it IS being used.
    expect(estimatePeakRam({ ...base, files: raws4, limits }).wasmUnusedReason).toBeUndefined()
  })
})

describe('limitCeilings', () => {
  it('never offers more parallel work than the device has cores', () => {
    expect(limitCeilings(4)).toEqual({ writeConcurrency: 4, exiftoolWorkers: 3 })
    // A single-core device still gets a usable minimum.
    expect(limitCeilings(1)).toEqual({ writeConcurrency: 1, exiftoolWorkers: 1 })
    // Plenty of cores: the hard ranges take over.
    expect(limitCeilings(32)).toEqual({
      writeConcurrency: LIMIT_RANGES.writeConcurrency.max,
      exiftoolWorkers: LIMIT_RANGES.exiftoolWorkers.max,
    })
  })
})

describe('ramBudgetBytes', () => {
  it('plans for 2 GB on phones and 8 GB elsewhere', () => {
    expect(ramBudgetBytes(true)).toBe(2 * 1024 * MB)
    expect(ramBudgetBytes(false)).toBe(8 * 1024 * MB)
  })
})

describe('fitLimits', () => {
  const desktop = { ceilings: limitCeilings(8), budgetBytes: ramBudgetBytes(false), workersWhenIdle: 2 }

  it('uses the whole device once ordinary files leave room for it', () => {
    // 20 MB ARWs through ExifTool: 8 x 60 MB plus 6 interpreters is well under 8 GB.
    const fitted = fitLimits({ ...base, ...desktop, files: raws(200) })
    expect(fitted).toEqual({ writeConcurrency: 8, exiftoolWorkers: 6 })
    expect(estimatePeakRam({ ...base, files: raws(200), limits: fitted }).totalBytes).toBeLessThanOrEqual(
      desktop.budgetBytes
    )
  })

  it('narrows for files too big to run that wide', () => {
    const files = raws(40, 700)
    const fitted = fitLimits({ ...base, ...desktop, files })
    // 4 x 2.1 GB would blow the budget; 3 fits with room for the interpreters.
    expect(fitted).toEqual({ writeConcurrency: 3, exiftoolWorkers: 3 })
    const peak = estimatePeakRam({ ...base, files, limits: fitted }).totalBytes
    expect(peak).toBeLessThanOrEqual(desktop.budgetBytes)
    const wider = estimatePeakRam({
      ...base,
      files,
      limits: { writeConcurrency: 4, exiftoolWorkers: 4 },
    }).totalBytes
    expect(wider).toBeGreaterThan(desktop.budgetBytes)
  })

  it('still writes a file that cannot possibly fit, at the narrowest setting', () => {
    const files = [{ sizeBytes: 4096 * MB, kind: 'video' as const }]
    expect(fitLimits({ ...base, ...desktop, files })).toEqual({ writeConcurrency: 1, exiftoolWorkers: 1 })
  })

  it('gives a phone less than the same files get on a desktop', () => {
    const files = raws(50, 120)
    const phone = fitLimits({
      ...base,
      files,
      ceilings: limitCeilings(8),
      budgetBytes: ramBudgetBytes(true),
      workersWhenIdle: 2,
    })
    const pc = fitLimits({ ...base, ...desktop, files })
    expect(phone.writeConcurrency).toBeLessThan(pc.writeConcurrency)
  })

  it('never keeps more workers than files in flight — an idle worker is dead memory', () => {
    const fitted = fitLimits({ ...base, ...desktop, files: raws(40, 900) })
    expect(fitted.exiftoolWorkers).toBeLessThanOrEqual(fitted.writeConcurrency)
  })

  it('leaves the worker count alone when the fast paths do all the writing', () => {
    const files = [...raws(20), { sizeBytes: 800 * MB, kind: 'video' as const }]
    const fitted = fitLimits({ ...base, ...desktop, files, fastRaw: true, fastMp4: true })
    // Nothing reaches the interpreter, so widening the pool would only cost
    // memory — the device default stays.
    expect(fitted.exiftoolWorkers).toBe(desktop.workersWhenIdle)
    expect(fitted.writeConcurrency).toBe(8)
  })

  it('respects a ceiling below the hard range', () => {
    const fitted = fitLimits({ ...base, ...desktop, ceilings: limitCeilings(2), files: raws(30) })
    expect(fitted).toEqual({ writeConcurrency: 2, exiftoolWorkers: 1 })
  })
})

describe('formatBytes', () => {
  it('scales the unit to the magnitude', () => {
    expect(formatBytes(240 * MB)).toBe('240 MB')
    expect(formatBytes(1.25 * 1024 * MB)).toBe('1.3 GB')
    expect(formatBytes(4096)).toBe('4 kB')
  })

  it('uses the same units as the file sizes it describes', () => {
    // A 20 MiB ARW must not read as "21 MB", and a 8 GiB budget not as "8.6 GB".
    expect(formatBytes(20 * MB)).toBe('20 MB')
    expect(formatBytes(ramBudgetBytes(false))).toBe('8 GB')
    expect(formatBytes(ramBudgetBytes(true))).toBe('2 GB')
  })
})
