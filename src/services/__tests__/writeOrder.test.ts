import { describe, it, expect } from 'vitest'
import type { Photo } from '../../domain/types'
import { photoKindFromName } from '../../domain/types'
import { writeBatch } from '../writePipeline'

function makePhoto(id: string, kind: Photo['kind']): Photo {
  return {
    id,
    sourceId: 'missing',
    fileName: `${id}.${kind === 'jpeg' ? 'jpg' : kind === 'video' ? 'mp4' : 'arw'}`,
    relativePath: `${id}`,
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
})
