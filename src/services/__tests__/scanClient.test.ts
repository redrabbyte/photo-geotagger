// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ScanClient, type ScanCallbacks } from '../scanClient'
import type { ScanJob, ScanRequest } from '../../workers/scan.worker'

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  posted: ScanRequest[] = []
  terminated = false
  constructor() {
    FakeWorker.instances.push(this)
  }
  postMessage(request: ScanRequest): void {
    this.posted.push(request)
  }
  terminate(): void {
    this.terminated = true
  }
  finishBatch(makeResponse?: (job: ScanJob) => unknown): void {
    const request = this.posted[this.posted.length - 1]
    for (const job of request.jobs) {
      if (makeResponse) this.onmessage?.({ data: makeResponse(job) })
      else if (request.type === 'scan') {
        this.onmessage?.({
          data: { type: 'meta', id: job.id, meta: { captureLocalMs: 0 }, sizeBytes: 1, lastModified: 2 },
        })
      } else {
        this.onmessage?.({ data: { type: 'thumb-failed', id: job.id } })
      }
    }
    this.onmessage?.({ data: { type: 'batch-done' } })
  }
  crash(): void {
    this.onerror?.({})
  }
}

function job(id: string): ScanJob {
  return { id, handle: {} as FileSystemFileHandle, kind: 'jpeg' }
}

function makeCallbacks() {
  return {
    onMeta: vi.fn(),
    onThumb: vi.fn(),
    onThumbFailed: vi.fn(),
    onError: vi.fn(),
    onIdle: vi.fn(),
  } satisfies ScanCallbacks
}

beforeEach(() => {
  FakeWorker.instances = []
  vi.stubGlobal('Worker', FakeWorker)
})

describe('ScanClient', () => {
  it('serves priority meta before priority thumbs before bulk meta before thumbs', () => {
    const cb = makeCallbacks()
    const client = new ScanClient(cb, 1)
    const worker = FakeWorker.instances[0]

    client.enqueue(Array.from({ length: 10 }, (_, i) => job(`m${i}`)))
    expect(worker.posted[0]).toMatchObject({ type: 'scan' })
    expect(worker.posted[0].jobs).toHaveLength(8) // BATCH_SIZE

    // While busy, queue one of each kind.
    client.enqueueThumbs([job('t1')])
    client.enqueueThumbs([job('pt1')], true)
    client.enqueue([job('pm1')], true)

    worker.finishBatch()
    expect(worker.posted[1].type).toBe('scan')
    expect(worker.posted[1].jobs.map((j) => j.id)).toEqual(['pm1'])
    worker.finishBatch()
    expect(worker.posted[2].type).toBe('thumb')
    expect(worker.posted[2].jobs.map((j) => j.id)).toEqual(['pt1'])
    worker.finishBatch()
    expect(worker.posted[3].jobs.map((j) => j.id)).toEqual(['m8', 'm9'])
    worker.finishBatch()
    expect(worker.posted[4].jobs.map((j) => j.id)).toEqual(['t1'])
    expect(cb.onIdle).not.toHaveBeenCalled()
    worker.finishBatch()
    expect(cb.onIdle).toHaveBeenCalledTimes(1)
  })

  it('replaces a crashed worker, requeues its batch, and does not fire onIdle early', () => {
    const cb = makeCallbacks()
    const client = new ScanClient(cb, 1)
    const first = FakeWorker.instances[0]

    client.enqueue([job('a'), job('b')])
    expect(first.posted[0].jobs.map((j) => j.id)).toEqual(['a', 'b'])

    first.crash()
    expect(cb.onIdle).not.toHaveBeenCalled()
    expect(first.terminated).toBe(true)
    // A fresh worker took over the same jobs.
    const second = FakeWorker.instances[1]
    expect(second).toBeDefined()
    expect(second.posted[0].jobs.map((j) => j.id)).toEqual(['a', 'b'])

    second.finishBatch()
    expect(cb.onMeta).toHaveBeenCalledTimes(2)
    expect(cb.onIdle).toHaveBeenCalledTimes(1)
  })

  it('reports jobs that crash two workers instead of looping forever', () => {
    const cb = makeCallbacks()
    const client = new ScanClient(cb, 1)
    client.enqueue([job('poison')])

    FakeWorker.instances[0].crash()
    expect(cb.onError).not.toHaveBeenCalled()
    FakeWorker.instances[1].crash()
    expect(cb.onError).toHaveBeenCalledWith('poison', expect.stringContaining('crashed'))
    // Third worker exists but received nothing; the queue is drained.
    expect(FakeWorker.instances[2].posted).toHaveLength(0)
    expect(cb.onIdle).toHaveBeenCalled()
  })
})
