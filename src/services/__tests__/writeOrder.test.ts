import { describe, it, expect } from 'vitest'
import type { Photo, Source } from '../../domain/types'
import { photoKindFromName } from '../../domain/types'
import { writeBatch } from '../writePipeline'

function makePhoto(id: string, kind: Photo['kind']): Photo {
  const fileName = `${id}.${kind === 'jpeg' ? 'jpg' : kind === 'video' ? 'mp4' : 'arw'}`
  return {
    id,
    sourceId: 'missing',
    fileName,
    relativePath: fileName,
    kind,
    sizeBytes: 1,
    lastModified: 0,
    scanState: 'done',
    writeState: 'dirty',
    assignment: { method: 'manual', point: { lat: 1, lon: 2 }, effectiveUtcMs: 0 },
  }
}

describe('video handling', () => {
  it('recognizes video extensions', () => {
    expect(photoKindFromName('clip.mp4')).toBe('video')
    expect(photoKindFromName('CLIP.MOV')).toBe('video')
    expect(photoKindFromName('clip.m4v')).toBe('video')
  })

  it('writes videos after all photos regardless of input order', async () => {
    const order: string[] = []
    // Unknown source → every job fails fast without touching any file APIs,
    // which exposes the processing order.
    await writeBatch(
      [makePhoto('v1', 'video'), makePhoto('a', 'jpeg'), makePhoto('v2', 'video'), makePhoto('b', 'raw')],
      new Map(),
      { mode: 'safe', backupOriginals: false, concurrency: 1 },
      (r) => order.push(r.photoId)
    )
    expect(order).toEqual(['a', 'b', 'v1', 'v2'])
  })

  /** Folder handle whose sidecar write dawdles, counting simultaneous writes. */
  function gaugedSidecarSource(gauge: { active: number; max: number }): Source {
    const dirHandle = {
      getFileHandle: async (_name: string, opts?: { create?: boolean }) => {
        if (!opts?.create) throw new DOMException('no sidecar yet', 'NotFoundError')
        return {
          createWritable: async () => {
            gauge.active++
            gauge.max = Math.max(gauge.max, gauge.active)
            await new Promise((resolve) => setTimeout(resolve, 20))
            return {
              write: async () => {},
              close: async () => void gauge.active--,
              abort: async () => void gauge.active--,
            }
          },
        }
      },
    } as unknown as FileSystemDirectoryHandle
    return { id: 'src', name: 'cam', color: '#000', clockOffsetMs: 0, assumedTzOffsetMin: 0, dirHandle }
  }

  function gaugedVideos(gauge: { active: number; max: number }): Photo[] {
    // In ExifTool mode the first thing a video write does is stat the file
    // (the size limit check), so the gauge sits in getFile.
    const fileHandle = {
      getFile: async () => {
        gauge.active++
        gauge.max = Math.max(gauge.max, gauge.active)
        await new Promise((resolve) => setTimeout(resolve, 20))
        gauge.active--
        return { size: 1000, arrayBuffer: async () => new ArrayBuffer(1000) }
      },
    } as unknown as FileSystemFileHandle
    return ['v1', 'v2', 'v3'].map((id) => ({ ...makePhoto(id, 'video'), sourceId: 'src', fileHandle }))
  }

  it('runs at most one video write at a time in ExifTool mode', async () => {
    const gauge = { active: 0, max: 0 }
    const source = gaugedSidecarSource(gauge)
    // The ExifTool run itself cannot work in this environment — the jobs fail
    // after the stat, which is exactly where the gauge measures overlap.
    await writeBatch(
      gaugedVideos(gauge),
      new Map([['src', source]]),
      { mode: 'exiftool', backupOriginals: false, concurrency: 3 },
      () => {}
    )
    expect(gauge.max).toBe(1)
  })

  it('writes sidecar videos in parallel in safe mode', async () => {
    // Safe mode only drops an .xmp next to the video — no WASM memory is held,
    // so throttling to one at a time would waste the other workers.
    const gauge = { active: 0, max: 0 }
    const source = gaugedSidecarSource(gauge)
    const videos = ['v1', 'v2', 'v3'].map((id) => ({ ...makePhoto(id, 'video'), sourceId: 'src' }))
    const results = await writeBatch(
      videos,
      new Map([['src', source]]),
      { mode: 'safe', backupOriginals: false, concurrency: 3 },
      () => {}
    )
    expect(results.every((r) => r.ok)).toBe(true)
    expect(gauge.max).toBeGreaterThan(1)
  })
})
