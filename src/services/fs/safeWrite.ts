/**
 * Read a file's bytes robustly. A monolithic File.arrayBuffer() fails with
 * NotReadableError on some filesystems (network shares, cloud-backed virtual
 * drives) and when the File snapshot was invalidated by a concurrent change —
 * even though small sliced reads work fine (the import scan proves that).
 * Strategy: plain read → wait 1s, fresh File, read again → chunked read.
 */
export async function readFileBytes(handle: FileSystemFileHandle): Promise<ArrayBuffer> {
  const notReadable = (err: unknown) => err instanceof DOMException && err.name === 'NotReadableError'
  try {
    return await (await handle.getFile()).arrayBuffer()
  } catch (err) {
    if (!notReadable(err)) throw err
  }
  // Transient lock or invalidated snapshot — give it a moment, then retry.
  await new Promise((resolve) => setTimeout(resolve, 1000))
  try {
    return await (await handle.getFile()).arrayBuffer()
  } catch (err) {
    if (!notReadable(err)) throw err
  }
  // Virtual/network drives often serve sliced reads while one big read fails.
  const file = await handle.getFile()
  const CHUNK = 32 * 1024 * 1024
  const out = new Uint8Array(file.size)
  for (let offset = 0; offset < file.size; offset += CHUNK) {
    const part = await file.slice(offset, Math.min(file.size, offset + CHUNK)).arrayBuffer()
    out.set(new Uint8Array(part), offset)
  }
  return out.buffer
}

/** Stage one chunk via createWritable and commit; abort (discard) on failure. */
async function writeThroughWritable(handle: FileSystemFileHandle, chunk: FileSystemWriteChunkType): Promise<void> {
  const writable = await handle.createWritable()
  try {
    await writable.write(chunk)
    await writable.close()
  } catch (err) {
    try {
      await writable.abort()
    } catch {
      // already closed/aborted
    }
    throw err
  }
}

/**
 * Write bytes to a file handle. FSA's createWritable stages into a temp file
 * and commits atomically on close(), so a crash mid-write never corrupts the
 * original.
 */
export async function writeFileBytes(handle: FileSystemFileHandle, bytes: Uint8Array | string): Promise<void> {
  await writeThroughWritable(handle, bytes as FileSystemWriteChunkType)
}

/** Copy the original file to "<name>.orig" in the same directory (skip if it exists). */
export async function backupOriginal(
  dir: FileSystemDirectoryHandle,
  fileName: string
): Promise<'created' | 'exists'> {
  const backupName = `${fileName}.orig`
  try {
    await dir.getFileHandle(backupName)
    return 'exists'
  } catch {
    // does not exist — create it
  }
  const srcHandle = await dir.getFileHandle(fileName)
  const srcFile = await srcHandle.getFile()
  const dstHandle = await dir.getFileHandle(backupName, { create: true })
  await writeThroughWritable(dstHandle, srcFile)
  return 'created'
}
