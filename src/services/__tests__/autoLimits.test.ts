// The automatic write limits: they must hold still while an import is loading
// (sizes arrive one scan at a time, so the estimate only grows) and settle on a
// fit as soon as it is done — unless the user has picked values by hand.
import { describe, it, expect, beforeEach } from 'vitest'
import type { Photo, PhotoKind } from '../../domain/types'
import { useStore } from '../../state/store'
import { autoTuneLimits, limitsLoadState } from '../appActions'
import { defaultLimits, fitLimits, limitCeilings, ramBudgetBytes } from '../ramEstimate'

const MB = 1024 * 1024

const photo = (id: string, kind: PhotoKind, sizeBytes: number, scanned: boolean): Photo =>
  ({
    id,
    sourceId: 'src1',
    fileName: `${id}.arw`,
    relativePath: `${id}.arw`,
    kind,
    sizeBytes: scanned ? sizeBytes : 0,
    lastModified: 0,
    scanState: scanned ? 'done' : 'pending',
    writeState: 'clean',
  }) as Photo

const seed = (photos: Photo[], scanning = false) => {
  useStore.setState({
    photos: Object.fromEntries(photos.map((p) => [p.id, p])),
    scanning,
  })
}

const loadState = () =>
  limitsLoadState(Object.values(useStore.getState().photos), useStore.getState().scanning)

const expectedFit = (files: Array<{ sizeBytes: number; kind: PhotoKind }>) =>
  fitLimits({
    files,
    mode: useStore.getState().settings.writeMode,
    fastRaw: false,
    fastMp4: false,
    budgetBytes: ramBudgetBytes(),
    ceilings: limitCeilings(),
    workersWhenIdle: defaultLimits().exiftoolWorkers,
  })

describe('autoTuneLimits', () => {
  const start = { exiftoolWorkers: 2, writeConcurrency: 4 }

  beforeEach(() => {
    useStore.setState({ photos: {}, scanning: false })
    useStore.getState().setSettings({ writeMode: 'exiftool', limits: start, limitsAuto: true })
  })

  it('leaves the limits alone while files are still being measured', () => {
    seed([photo('a', 'raw', 20 * MB, true), photo('b', 'raw', 20 * MB, false)])
    expect(loadState()).toEqual({ total: 2, measured: 1, settled: false })
    autoTuneLimits()
    expect(useStore.getState().settings.limits).toEqual(start)
  })

  it('waits for the scan to report itself finished, not just for the last size', () => {
    seed([photo('a', 'raw', 20 * MB, true)], true)
    expect(loadState().settled).toBe(false)
    autoTuneLimits()
    expect(useStore.getState().settings.limits).toEqual(start)
  })

  it('fits the loaded files once the import has settled', () => {
    const files = Array.from({ length: 30 }, (_, i) => photo(`p${i}`, 'raw', 20 * MB, true))
    seed(files)
    expect(loadState().settled).toBe(true)
    autoTuneLimits()
    const fitted = expectedFit(files.map((f) => ({ sizeBytes: f.sizeBytes, kind: f.kind })))
    expect(useStore.getState().settings.limits).toEqual(fitted)
    // 20 MB RAWs leave room for more than the cautious starting width.
    expect(fitted.writeConcurrency).toBeGreaterThanOrEqual(start.writeConcurrency)
  })

  it('narrows again for an import of very large files', () => {
    const big = Array.from({ length: 20 }, (_, i) => photo(`p${i}`, 'raw', 900 * MB, true))
    seed(big)
    useStore.getState().setSettings({ limits: { exiftoolWorkers: 6, writeConcurrency: 12 } })
    autoTuneLimits()
    const after = useStore.getState().settings.limits
    expect(after.writeConcurrency).toBeLessThan(12)
    expect(after).toEqual(expectedFit(big.map((f) => ({ sizeBytes: f.sizeBytes, kind: f.kind }))))
  })

  it('never touches limits the user picked by hand', () => {
    seed(Array.from({ length: 30 }, (_, i) => photo(`p${i}`, 'raw', 20 * MB, true)))
    useStore.getState().setSettings({ limits: { exiftoolWorkers: 1, writeConcurrency: 2 }, limitsAuto: false })
    autoTuneLimits()
    expect(useStore.getState().settings.limits).toEqual({ exiftoolWorkers: 1, writeConcurrency: 2 })
  })

  it('does nothing at all without files', () => {
    seed([])
    autoTuneLimits()
    expect(useStore.getState().settings.limits).toEqual(start)
  })
})
