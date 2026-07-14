import { describe, it, expect } from 'vitest'
import { directoryOfCached, type DirCache } from '../writePipeline'

/** Fake directory handle counting every getDirectoryHandle round trip. */
function makeFakeDir(name: string, counter: { n: number }, failOnce?: { armed: boolean }): FileSystemDirectoryHandle {
  return {
    name,
    getDirectoryHandle: async (part: string) => {
      if (failOnce?.armed) {
        failOnce.armed = false
        throw new DOMException('gone', 'NotFoundError')
      }
      counter.n++
      return makeFakeDir(part, counter, failOnce)
    },
  } as unknown as FileSystemDirectoryHandle
}

describe('directoryOfCached', () => {
  it('walks each folder only once per batch', async () => {
    const counter = { n: 0 }
    const root = makeFakeDir('root', counter)
    const cache: DirCache = new Map()

    const a = await directoryOfCached(root, 's1', 'trip/day1/one.arw', cache)
    expect(counter.n).toBe(2) // trip + day1
    const b = await directoryOfCached(root, 's1', 'trip/day1/two.arw', cache)
    expect(counter.n).toBe(2) // cache hit, no further lookups
    expect(b).toBe(a)

    await directoryOfCached(root, 's1', 'trip/day2/three.arw', cache)
    expect(counter.n).toBe(4) // different folder walks again
  })

  it('keeps sources apart and walks fresh without a cache', async () => {
    const counter = { n: 0 }
    const root = makeFakeDir('root', counter)
    const cache: DirCache = new Map()

    await directoryOfCached(root, 's1', 'a/x.arw', cache)
    await directoryOfCached(root, 's2', 'a/x.arw', cache)
    expect(counter.n).toBe(2) // same path, different source → separate entries

    await directoryOfCached(root, 's1', 'a/x.arw')
    expect(counter.n).toBe(3) // no cache passed → real walk
  })

  it('does not cache failed lookups', async () => {
    const counter = { n: 0 }
    const failOnce = { armed: true }
    const root = makeFakeDir('root', counter, failOnce)
    const cache: DirCache = new Map()

    await expect(directoryOfCached(root, 's1', 'a/x.arw', cache)).rejects.toThrow()
    await expect(directoryOfCached(root, 's1', 'a/x.arw', cache)).resolves.toBeDefined()
    expect(counter.n).toBe(1)
  })
})
