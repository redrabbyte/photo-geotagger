import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileBytes, backupOriginal } from '../fs/safeWrite'

const BYTES = new Uint8Array([1, 2, 3, 4, 5])

function notReadable(): DOMException {
  return new DOMException('locked', 'NotReadableError')
}

/** File-like whose monolithic read fails `failures` times before succeeding. */
function fileHandle(failures: number, opts: { chunkedWorks?: boolean } = {}) {
  let attempts = 0
  const file = {
    size: BYTES.length,
    arrayBuffer: async () => {
      attempts++
      if (attempts <= failures) throw notReadable()
      return BYTES.slice().buffer
    },
    slice: (start: number, end: number) => ({
      arrayBuffer: async () => {
        if (!opts.chunkedWorks) throw notReadable()
        return BYTES.slice(start, end).buffer
      },
    }),
  }
  return {
    handle: { getFile: async () => file } as unknown as FileSystemFileHandle,
    attempts: () => attempts,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('readFileBytes ladder', () => {
  it('returns the plain read when it works', async () => {
    const { handle, attempts } = fileHandle(0)
    expect(new Uint8Array(await readFileBytes(handle))).toEqual(BYTES)
    expect(attempts()).toBe(1)
  })

  it('waits and retries once on NotReadableError', async () => {
    vi.useFakeTimers()
    const { handle, attempts } = fileHandle(1)
    const promise = readFileBytes(handle)
    await vi.advanceTimersByTimeAsync(1000)
    expect(new Uint8Array(await promise)).toEqual(BYTES)
    expect(attempts()).toBe(2)
  })

  it('falls back to chunked reads when both monolithic reads fail', async () => {
    vi.useFakeTimers()
    const { handle, attempts } = fileHandle(Infinity, { chunkedWorks: true })
    const promise = readFileBytes(handle)
    await vi.advanceTimersByTimeAsync(1000)
    expect(new Uint8Array(await promise)).toEqual(BYTES)
    expect(attempts()).toBe(2)
  })

  it('rethrows non-NotReadable errors immediately', async () => {
    const handle = {
      getFile: async () => ({
        arrayBuffer: async () => {
          throw new DOMException('gone', 'NotFoundError')
        },
      }),
    } as unknown as FileSystemFileHandle
    await expect(readFileBytes(handle)).rejects.toMatchObject({ name: 'NotFoundError' })
  })
})

describe('backupOriginal', () => {
  function makeDir() {
    const files = new Map<string, { written: unknown[] }>()
    files.set('a.jpg', { written: [] })
    const dir = {
      getFileHandle: async (name: string, opts?: { create?: boolean }) => {
        if (!files.has(name)) {
          if (!opts?.create) throw new DOMException('nope', 'NotFoundError')
          files.set(name, { written: [] })
        }
        const entry = files.get(name)!
        return {
          getFile: async () => ({ name }),
          createWritable: async () => ({
            write: async (chunk: unknown) => void entry.written.push(chunk),
            close: async () => {},
            abort: async () => {},
          }),
        }
      },
    } as unknown as FileSystemDirectoryHandle
    return { dir, files }
  }

  it('copies the original once and skips when the backup already exists', async () => {
    const { dir, files } = makeDir()
    expect(await backupOriginal(dir, 'a.jpg')).toBe('created')
    expect(files.get('a.jpg.orig')?.written).toEqual([{ name: 'a.jpg' }])
    // Second run must not touch the existing backup.
    expect(await backupOriginal(dir, 'a.jpg')).toBe('exists')
    expect(files.get('a.jpg.orig')?.written).toHaveLength(1)
  })
})
