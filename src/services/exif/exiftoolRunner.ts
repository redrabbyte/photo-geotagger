/**
 * Direct zeroperl driver for ExifTool — replaces @uswriting/exiftool's
 * per-call API so that MANY files can be processed in ONE Perl execution.
 *
 * The wrapper boots the full ExifTool Perl script for every single call,
 * which dominates the ~2s per-RAW write cost. ExifTool's own `-@ argfile`
 * with `-execute` separators runs any number of independent commands in one
 * script execution, amortizing the boot across a whole batch.
 *
 * The ExifTool script itself is not shipped separately by the wrapper — it
 * is embedded as a template literal in its bundle, so we extract it from the
 * bundle text at runtime (the package version is pinned; extraction fails
 * loudly if a future version changes the bundle shape).
 */
import { MemoryFileSystem, ZeroPerl } from '@6over3/zeroperl-ts'
// Relative path because the package's `exports` field forbids deep imports.
import wrapperBundleSource from '../../../node_modules/@uswriting/exiftool/dist/esm/index.js?raw'

type FetchLike = (...args: unknown[]) => Promise<Response>

let scriptCache: string | undefined

/** Index of the closing backtick of a template literal, skipping escaped ones. */
function closingBacktick(source: string, openIdx: number): number {
  let i = openIdx + 1
  for (;;) {
    i = source.indexOf('`', i)
    if (i < 0) return -1
    let backslashes = 0
    for (let j = i - 1; j >= 0 && source[j] === '\\'; j--) backslashes++
    if (backslashes % 2 === 0) return i
    i++
  }
}

/** Extract the embedded ExifTool Perl script from the wrapper bundle. */
export function extractExiftoolScript(bundleSource: string = wrapperBundleSource): string {
  if (bundleSource === wrapperBundleSource && scriptCache) return scriptCache
  // The minified variable name changes between versions — match the script's
  // unmistakable opening instead.
  const m = /=`use strict;use warnings;/.exec(bundleSource)
  const open = m ? m.index + 1 : -1
  const close = open >= 0 ? closingBacktick(bundleSource, open) : -1
  if (open < 0 || close < 0) {
    throw new Error(
      'Could not locate the embedded ExifTool script in @uswriting/exiftool — the package layout changed'
    )
  }
  // The script is stored as a template literal; evaluate it to undo the
  // bundler's escaping exactly (\` \$ \\ …).
  const literal = bundleSource.slice(open, close + 1)
  const script = new Function(`return ${literal}`)() as string
  if (!script.startsWith('use strict') || !script.includes('Image::ExifTool')) {
    throw new Error('Extracted ExifTool script looks wrong — refusing to run it')
  }
  if (bundleSource === wrapperBundleSource) scriptCache = script
  return script
}

export interface RunResult {
  success: boolean
  exitCode: number
  stdout: string
  stderr: string
  lastError: string
}

/**
 * A booted ExifTool interpreter. One instance per worker; runs are strictly
 * sequential (the caller must not overlap run() calls).
 */
export class ExiftoolRunner {
  private perl: ZeroPerl | undefined
  private fs: MemoryFileSystem | undefined
  private out: string[] = []
  private err: string[] = []
  private decoder = new TextDecoder()
  private fetchImpl?: FetchLike

  constructor(fetchImpl?: FetchLike) {
    this.fetchImpl = fetchImpl
  }

  /** Instantiate the WASM interpreter (the one-time ~25 MB cost). */
  async boot(): Promise<void> {
    if (this.perl) return
    const fs = new MemoryFileSystem({ '/': '' })
    fs.addFile('/exiftool', extractExiftoolScript())
    this.perl = await ZeroPerl.create({
      fileSystem: fs,
      stdout: (d) => this.out.push(typeof d === 'string' ? d : this.decoder.decode(d)),
      stderr: (d) => this.err.push(typeof d === 'string' ? d : this.decoder.decode(d)),
      fetch: this.fetchImpl,
    })
    this.fs = fs
  }

  /**
   * Run ExifTool once. Input files are placed into the virtual FS first and
   * removed afterwards together with the given output paths — read outputs
   * via the callback before they are cleaned up.
   */
  async run(
    args: string[],
    inputs: Array<{ path: string; data: Uint8Array | string }>,
    outputPaths: string[] = [],
    readOutputs?: (read: (path: string) => Promise<Uint8Array | undefined>) => Promise<void>
  ): Promise<RunResult> {
    await this.boot()
    const perl = this.perl!
    const fs = this.fs!
    this.out = []
    this.err = []
    await perl.reset()
    const cleanup = [...inputs.map((f) => f.path), ...outputPaths]
    try {
      for (const f of inputs) fs.addFile(f.path, f.data)
      const result = await perl.runFile('/exiftool', args)
      perl.flush()
      if (readOutputs) {
        await readOutputs(async (path) => {
          const node = fs.lookup(path)
          if (!node || node.type !== 'file') return undefined
          const content = (node as { content: Uint8Array | Blob }).content
          return content instanceof Blob ? new Uint8Array(await content.arrayBuffer()) : content
        })
      }
      return {
        success: result.success,
        exitCode: result.exitCode,
        stdout: this.out.join(''),
        stderr: this.err.join(''),
        lastError: perl.getLastError(),
      }
    } finally {
      for (const path of cleanup) {
        try {
          fs.removeFile(path)
        } catch {
          // never created — fine
        }
      }
    }
  }
}

export interface BatchWriteItem {
  /** Original file name — only the extension matters for format detection. */
  name: string
  bytes: Uint8Array
  /** ExifTool tag assignments, e.g. { GPSLatitude: 48.85, GPSLatitudeRef: 'N' }. */
  tags: Record<string, string | number>
}

export type BatchWriteResult = { ok: true; bytes: Uint8Array } | { ok: false; error: string }

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1) : 'bin'
}

/** stderr lines mentioning this virtual path (for per-file error reporting). */
function errorsFor(stderr: string, path: string): string {
  const lines = stderr
    .split('\n')
    .filter((l) => l.includes(path))
    .map((l) => l.trim())
    .filter(Boolean)
  return lines.join('; ')
}

/**
 * Write metadata into many files with ONE ExifTool execution.
 * Each item becomes its own `-execute` command in an argfile, so one bad
 * file fails alone while the others still get written.
 */
export async function writeBatchViaExiftool(
  runner: ExiftoolRunner,
  items: BatchWriteItem[]
): Promise<BatchWriteResult[]> {
  if (items.length === 0) return []
  const inputs: Array<{ path: string; data: Uint8Array | string }> = []
  const outputPaths: string[] = []
  const commands: string[][] = items.map((item, i) => {
    const ext = extensionOf(item.name)
    const inPath = `/in${i}.${ext}`
    const outPath = `/out${i}.${ext}`
    inputs.push({ path: inPath, data: item.bytes })
    outputPaths.push(outPath)
    const lines = Object.entries(item.tags).map(([k, v]) => `-${k}=${v}`)
    lines.push('-o', outPath, inPath)
    return lines
  })
  // Argfile format: one argument per line, commands separated by -execute
  // (the last command runs at EOF without a trailing -execute).
  const argfile = commands.map((c) => c.join('\n')).join('\n-execute\n') + '\n'
  inputs.push({ path: '/args.txt', data: argfile })

  const results: BatchWriteResult[] = new Array(items.length)
  const run = await runner.run(['-@', '/args.txt'], inputs, outputPaths, async (read) => {
    for (let i = 0; i < items.length; i++) {
      const bytes = await read(outputPaths[i])
      if (bytes && bytes.length > 0) results[i] = { ok: true, bytes }
    }
  })

  for (let i = 0; i < items.length; i++) {
    if (results[i]) continue
    const detail = errorsFor(run.stderr, `/in${i}.`) || errorsFor(run.stderr, outputPaths[i])
    results[i] = {
      ok: false,
      error:
        detail ||
        run.lastError ||
        run.stderr.trim() ||
        `exiftool produced no output (exit code ${run.exitCode})`,
    }
  }
  return results
}

/** Read metadata (single file) — used for verification fallback and inspect. */
export async function parseViaExiftool(
  runner: ExiftoolRunner,
  name: string,
  bytes: Uint8Array,
  args: string[]
): Promise<{ success: boolean; output: string; error?: string }> {
  const path = `/read.${extensionOf(name)}`
  const run = await runner.run([...args, path], [{ path, data: bytes }])
  if (!run.success || run.exitCode !== 0) {
    return { success: false, output: '', error: run.lastError || run.stderr || 'exiftool failed' }
  }
  if (!run.stdout.trim()) {
    return { success: false, output: '', error: run.stderr.trim() || 'no output from exiftool' }
  }
  return { success: true, output: run.stdout }
}
