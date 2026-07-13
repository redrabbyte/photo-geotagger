/**
 * Write bytes to a file handle. FSA's createWritable stages into a temp file
 * and commits atomically on close(), so a crash mid-write never corrupts the
 * original. Optionally copies the original to "<name>.orig" first.
 */
export async function writeFileBytes(handle: FileSystemFileHandle, bytes: Uint8Array | string): Promise<void> {
  const writable = await handle.createWritable()
  try {
    await writable.write(bytes as FileSystemWriteChunkType)
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
  const writable = await dstHandle.createWritable()
  try {
    await writable.write(srcFile)
    await writable.close()
  } catch (err) {
    try {
      await writable.abort()
    } catch {
      // ignore
    }
    throw err
  }
  return 'created'
}
