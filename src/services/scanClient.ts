import type { PhotoMeta } from '../domain/types'
import type { ScanJob, ScanRequest, ScanResponse } from '../workers/scan.worker'

export interface ScanCallbacks {
  onMeta(id: string, meta: PhotoMeta, sizeBytes: number, lastModified: number): void
  onThumb(id: string, url: string): void
  onThumbFailed(id: string): void
  onError(id: string, message: string): void
  onIdle(): void
}

// Small batches keep the wait short before a priority job can jump in
// (a worker must finish its current batch first) — with 24 the thumbnail of
// a clicked photo could sit behind two dozen RAW meta reads.
const BATCH_SIZE = 8
const THUMB_BATCH_SIZE = 4
const PRIORITY_BATCH_SIZE = 4

/**
 * Manages a pool of scan workers. Metadata jobs always run before thumbnail
 * jobs — a folder becomes fully matchable in seconds while thumbnails are
 * generated lazily for what is actually visible.
 */
export class ScanClient {
  private workers: Worker[] = []
  private metaQueue: ScanJob[] = []
  private thumbQueue: ScanJob[] = []
  /** Metadata for the photo the user just clicked — served first of all. */
  private priorityMetaQueue: ScanJob[] = []
  /** User-facing thumbnails (selected photo) — served before bulk work. */
  private priorityThumbQueue: ScanJob[] = []
  private busy: Set<Worker> = new Set()
  /** The batch each busy worker is processing — requeued if it crashes. */
  private inFlight = new Map<Worker, ScanRequest>()
  /** Per-photo crash count: a job that kills two workers is poison. */
  private crashCounts = new Map<string, number>()
  private callbacks: ScanCallbacks

  constructor(callbacks: ScanCallbacks, poolSize = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1))) {
    this.callbacks = callbacks
    for (let i = 0; i < poolSize; i++) {
      this.workers.push(this.makeWorker())
    }
  }

  private makeWorker(): Worker {
    const worker = new Worker(new URL('../workers/scan.worker.ts', import.meta.url), {
      type: 'module',
    })
    worker.onmessage = (event: MessageEvent<ScanResponse>) => this.handleMessage(worker, event.data)
    worker.onerror = () => this.handleWorkerCrash(worker)
    return worker
  }

  /**
   * A hard-crashed worker (e.g. OOM on a huge file) is unusable: replace it
   * and put its batch back so no photo silently stays 'pending' and onIdle
   * cannot fire while work is actually lost. Jobs that crash a second
   * worker are reported as errors instead of looping forever.
   */
  private handleWorkerCrash(worker: Worker): void {
    const request = this.inFlight.get(worker)
    this.inFlight.delete(worker)
    this.busy.delete(worker)
    worker.terminate()
    const idx = this.workers.indexOf(worker)
    const fresh = this.makeWorker()
    if (idx >= 0) this.workers[idx] = fresh
    else this.workers.push(fresh)

    if (request) {
      const retry: ScanJob[] = []
      for (const job of request.jobs) {
        const crashes = (this.crashCounts.get(job.id) ?? 0) + 1
        this.crashCounts.set(job.id, crashes)
        if (crashes >= 2) {
          if (request.type === 'scan') this.callbacks.onError(job.id, 'Scan worker crashed on this file')
          else this.callbacks.onThumbFailed(job.id)
        } else {
          retry.push(job)
        }
      }
      if (request.type === 'scan') this.metaQueue.unshift(...retry)
      else this.thumbQueue.unshift(...retry)
    }
    this.pump()
  }

  /**
   * Queue metadata extraction. Priority jobs (a clicked, not-yet-scanned
   * photo) are pulled out of the bulk queue and served before everything.
   */
  enqueue(jobs: ScanJob[], priority = false): void {
    if (priority) {
      const ids = new Set(jobs.map((j) => j.id))
      this.metaQueue = this.metaQueue.filter((j) => !ids.has(j.id))
      this.priorityMetaQueue.push(...jobs)
    } else {
      this.metaQueue.push(...jobs)
    }
    this.pump()
  }

  /**
   * Queue thumbnail generation. Normal jobs run when no metadata is pending;
   * priority jobs (the photo the user just selected) jump ahead of everything.
   */
  enqueueThumbs(jobs: ScanJob[], priority = false): void {
    if (priority) this.priorityThumbQueue.push(...jobs)
    else this.thumbQueue.push(...jobs)
    this.pump()
  }

  get pending(): number {
    return (
      this.metaQueue.length +
      this.thumbQueue.length +
      this.priorityMetaQueue.length +
      this.priorityThumbQueue.length
    )
  }

  private handleMessage(worker: Worker, msg: ScanResponse): void {
    switch (msg.type) {
      case 'meta':
        this.callbacks.onMeta(msg.id, msg.meta, msg.sizeBytes, msg.lastModified)
        break
      case 'thumb':
        this.callbacks.onThumb(msg.id, URL.createObjectURL(msg.blob))
        break
      case 'thumb-failed':
        this.callbacks.onThumbFailed(msg.id)
        break
      case 'error':
        this.callbacks.onError(msg.id, msg.message)
        break
      case 'batch-done':
        this.busy.delete(worker)
        this.inFlight.delete(worker)
        this.pump()
        break
    }
  }

  private pump(): void {
    for (const worker of this.workers) {
      if (this.busy.has(worker)) continue
      let request: ScanRequest | undefined
      if (this.priorityMetaQueue.length > 0) {
        request = { type: 'scan', jobs: this.priorityMetaQueue.splice(0, PRIORITY_BATCH_SIZE) }
      } else if (this.priorityThumbQueue.length > 0) {
        request = { type: 'thumb', jobs: this.priorityThumbQueue.splice(0, THUMB_BATCH_SIZE) }
      } else if (this.metaQueue.length > 0) {
        request = { type: 'scan', jobs: this.metaQueue.splice(0, BATCH_SIZE) }
      } else if (this.thumbQueue.length > 0) {
        request = { type: 'thumb', jobs: this.thumbQueue.splice(0, THUMB_BATCH_SIZE) }
      } else {
        break
      }
      this.busy.add(worker)
      this.inFlight.set(worker, request)
      worker.postMessage(request)
    }
    if (this.pending === 0 && this.busy.size === 0) {
      this.callbacks.onIdle()
    }
  }

}
