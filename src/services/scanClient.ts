import type { PhotoMeta } from '../domain/types'
import type { ScanJob, ScanRequest, ScanResponse } from '../workers/scan.worker'

export interface ScanCallbacks {
  onMeta(id: string, meta: PhotoMeta, sizeBytes: number, lastModified: number): void
  onThumb(id: string, url: string): void
  onThumbFailed(id: string): void
  onError(id: string, message: string): void
  onIdle(): void
}

const BATCH_SIZE = 24

/**
 * Manages a pool of scan workers, distributing metadata/thumbnail extraction
 * jobs and streaming results back as store updates.
 */
export class ScanClient {
  private workers: Worker[] = []
  private queue: ScanJob[] = []
  private busy: Set<Worker> = new Set()
  private callbacks: ScanCallbacks

  constructor(callbacks: ScanCallbacks, poolSize = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1))) {
    this.callbacks = callbacks
    for (let i = 0; i < poolSize; i++) {
      const worker = new Worker(new URL('../workers/scan.worker.ts', import.meta.url), {
        type: 'module',
      })
      worker.onmessage = (event: MessageEvent<ScanResponse>) => this.handleMessage(worker, event.data)
      worker.onerror = () => {
        this.busy.delete(worker)
        this.pump()
      }
      this.workers.push(worker)
    }
  }

  enqueue(jobs: ScanJob[]): void {
    this.queue.push(...jobs)
    this.pump()
  }

  get pending(): number {
    return this.queue.length
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
        this.pump()
        break
    }
  }

  private pump(): void {
    for (const worker of this.workers) {
      if (this.queue.length === 0) break
      if (this.busy.has(worker)) continue
      const jobs = this.queue.splice(0, BATCH_SIZE)
      this.busy.add(worker)
      worker.postMessage({ type: 'scan', jobs } satisfies ScanRequest)
    }
    if (this.queue.length === 0 && this.busy.size === 0) {
      this.callbacks.onIdle()
    }
  }

  dispose(): void {
    for (const w of this.workers) w.terminate()
    this.workers = []
    this.queue = []
    this.busy.clear()
  }
}
