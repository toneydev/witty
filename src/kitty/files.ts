// The file transports (`t=f`, `t=t`) under a policy, because the path comes
// from the child's output and is untrusted.
//
// A path is read only when it is an absolute drive path (`C:\...`): never
// UNC (`\\server\share`), never the `\\.\` / `\\?\` device namespaces, never
// relative, never with NUL or an alternate data stream (`:` after the drive),
// never a DOS device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9). The resolved
// path must be a regular file (lstat: no directory, symlink or other reparse
// point, no device), opened and checked again by handle so it cannot be
// swapped in between, no larger than the image limit, with the `O`/`S` range
// inside it, all before a byte is read. The whole operation is bounded by a
// timeout so a stalled volume errors instead of freezing the pipeline. Every
// failure is the same error, with no detail: no existence, size or
// readability oracle.
//
// `t=t` files are deleted only when the resolved path lies inside the temp
// directory and its basename contains `tty-graphics-protocol`.

import { lstat, open, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { FileRange } from '../types.ts'

/** How long one file read may take, in ms. */
export const FILE_READ_TIMEOUT_MS = 2000

/** The one error every refused or failed file read becomes. */
export class FileAccessError extends Error {
  constructor() {
    super('Failed to read image file')
    this.name = 'FileAccessError'
  }
}

const DRIVE_PATH = /^[A-Za-z]:[\\/]/
/** DOS device names (with the superscript-digit COM/LPT forms Windows also treats as devices). */
const DOS_DEVICE = /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])$/i
/** The temp-file marker kitty and its clients put in `t=t` file names. */
export const TEMP_FILE_MARKER = 'tty-graphics-protocol'

/**
 * The resolved form of `p` when it passes the path rules (see the top of
 * this file), else undefined. Uses Windows path semantics.
 */
export function checkFilePath(p: string): string | undefined {
  if (p === '' || p.includes('\0')) return undefined
  // UNC and device namespaces, in any mix of separators.
  if (/^[\\/][\\/]/.test(p)) return undefined
  if (!DRIVE_PATH.test(p)) return undefined
  // A colon past the drive is an alternate data stream (or nonsense).
  if (p.indexOf(':', 2) !== -1) return undefined
  const resolved = path.win32.resolve(p)
  if (!DRIVE_PATH.test(resolved) || /^[\\/][\\/]/.test(resolved)) return undefined
  if (isDosDevice(path.win32.basename(resolved))) return undefined
  return resolved
}

/** Whether a file name is a DOS device: its stem (before the first dot, trailing spaces dropped) is one. */
export function isDosDevice(basename: string): boolean {
  const stem = basename.split('.')[0]!.replace(/[ ]+$/, '')
  return DOS_DEVICE.test(stem)
}

/**
 * Whether `p` is a `t=t` file witty may delete: it passes the path rules,
 * resolves to somewhere inside `tmpdir`, and its basename contains
 * `tty-graphics-protocol`.
 */
export function isDeletableTempFile(p: string, tmpdir: string = os.tmpdir()): boolean {
  const resolved = checkFilePath(p)
  if (resolved === undefined) return false
  const relative = path.win32.relative(path.win32.resolve(tmpdir), resolved)
  if (relative === '' || relative.startsWith('..') || path.win32.isAbsolute(relative)) return false
  return path.win32.basename(resolved).includes(TEMP_FILE_MARKER)
}

export type FileAccessOptions = {
  /** The directory `t=t` files must live in to be deleted. Default os.tmpdir(). */
  tmpdir?: string
  /** Bound on one read, in ms. Default 2000. */
  timeoutMs?: number
}

/** What the engine's `readFile` / `deleteFile` options take, with the policy applied. */
export type FileAccess = {
  readFile: (p: string, range: FileRange) => Promise<Uint8Array>
  deleteFile: (p: string) => Promise<void>
}

/** Rejects with FileAccessError after `ms`, unless `work` settles first. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FileAccessError()), ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

/** Reads the whole of a policy-checked regular file whose size and range fit `range`. */
async function readChecked(p: string, range: FileRange, signal: AbortSignal): Promise<Uint8Array> {
  const resolved = checkFilePath(p)
  if (resolved === undefined) throw new FileAccessError()
  const link = await lstat(resolved)
  if (!link.isFile() || link.isSymbolicLink()) throw new FileAccessError()
  const fits = (size: number): boolean =>
    size <= range.maxBytes && range.offset <= size && (range.size === 0 || range.offset + range.size <= size)
  if (!fits(link.size)) throw new FileAccessError()
  const handle = await open(resolved, 'r')
  try {
    // The file opened must be the one checked (not swapped for a link meanwhile).
    const opened = await handle.stat()
    if (!opened.isFile() || opened.ino !== link.ino || opened.dev !== link.dev || !fits(opened.size)) {
      throw new FileAccessError()
    }
    const data = await handle.readFile({ signal })
    if (!fits(data.length)) throw new FileAccessError()
    return new Uint8Array(data.buffer, data.byteOffset, data.length)
  } finally {
    void handle.close().catch(() => undefined)
  }
}

/**
 * Creates the file access the real wiring hands the engine: reads follow the
 * path and file rules and the timeout, every failure is one FileAccessError,
 * and deletes happen only for temp files (see `isDeletableTempFile`).
 */
export function createFileAccess(options: FileAccessOptions = {}): FileAccess {
  const timeoutMs = options.timeoutMs ?? FILE_READ_TIMEOUT_MS
  return {
    async readFile(p, range) {
      const signal = AbortSignal.timeout(timeoutMs)
      try {
        return await withTimeout(readChecked(p, range, signal), timeoutMs)
      } catch {
        throw new FileAccessError()
      }
    },
    async deleteFile(p) {
      if (!isDeletableTempFile(p, options.tmpdir ?? os.tmpdir())) return
      const resolved = checkFilePath(p)
      if (resolved === undefined) return
      await unlink(resolved).catch(() => undefined)
    },
  }
}
