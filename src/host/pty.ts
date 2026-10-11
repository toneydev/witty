// The child side: the program runs inside node-pty's bundled ConPTY
// (`useConptyDll: true`), whose passthrough mode forwards the kitty APC
// sequences instead of swallowing them like the inbox conhost does.

import * as nodePty from 'node-pty'

export type SpawnChildOptions = {
  file: string
  /** argv, or a pre-escaped Windows command line (see host/resolve.ts). */
  args: string[] | string
  cwd: string
  env: Record<string, string | undefined>
  cols: number
  rows: number
  /** Where the fallback warning goes. Default: process.stderr. */
  warn?: (message: string) => void
  /** node-pty's spawn, injectable for tests. */
  spawn?: typeof nodePty.spawn
}

/** A running child in a pseudo-console. */
export interface ChildPty {
  readonly pid: number
  /** Whether the bundled conpty.dll is in use (false after the fallback). */
  readonly bundledConpty: boolean
  /** Writes input to the child (strings are sent as UTF-8). */
  write(data: string | Uint8Array): void
  resize(cols: number, rows: number): void
  /** Child output as UTF-8 bytes, in order. */
  onData(cb: (bytes: Uint8Array) => void): void
  /** Fires once with the exit code when the child is gone and its output drained. */
  onExit(cb: (exitCode: number) => void): void
  /** Stops reading child output (flow control); the child blocks when the pipe fills. */
  pause(): void
  resume(): void
  kill(): void
}

/**
 * Spawns the child with node-pty's bundled ConPTY. If that throws (the DLL
 * is missing or refuses to start), retries with the system ConPTY and warns,
 * as Tabby does: the program then runs, but kitty images will not survive
 * the inbox conhost.
 */
export function spawnChild(options: SpawnChildOptions): ChildPty {
  const spawn = options.spawn ?? nodePty.spawn
  const warn = options.warn ?? ((m: string) => process.stderr.write(m + '\n'))
  const base = {
    name: 'xterm-256color',
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: options.env,
  }
  let pty: nodePty.IPty
  let bundled = true
  try {
    pty = spawn(options.file, options.args, { ...base, useConptyDll: true })
  } catch (error) {
    warn(
      `witty: the bundled ConPTY failed to start (${(error as Error).message}); ` +
        'falling back to the system ConPTY, kitty images may not pass through.',
    )
    bundled = false
    pty = spawn(options.file, options.args, { ...base, useConptyDll: false })
  }
  return wrap(pty, bundled)
}

/**
 * Lets the event loop end after a node-pty child has exited. With
 * `useConptyDll: true` node-pty keeps its conout worker thread (a
 * MessagePort) alive after exit, so a process that hosted a pty never exits
 * on its own; disposing the worker fixes that. Reaches into node-pty
 * internals (1.2.0-beta), hence the defensive optional chaining.
 */
export function releaseNodePty(pty: nodePty.IPty): void {
  const agent = (pty as unknown as { _agent?: { _conoutSocketWorker?: { dispose?: () => void } } })._agent
  try {
    agent?._conoutSocketWorker?.dispose?.()
  } catch {
    // Already disposed.
  }
}

function wrap(pty: nodePty.IPty, bundled: boolean): ChildPty {
  // node-pty decodes the output pipe with a streaming UTF-8 decoder
  // (socket.setEncoding('utf8')), so a character split across reads arrives
  // whole in one string; re-encoding each string is therefore lossless for
  // valid UTF-8 (invalid bytes have already become U+FFFD).
  const encoder = new TextEncoder()
  let exited = false
  let exitCode = 0
  const exitListeners: Array<(code: number) => void> = []
  pty.onExit(({ exitCode: code }) => {
    if (exited) return
    exited = true
    exitCode = code
    for (const cb of exitListeners) cb(code)
    releaseNodePty(pty)
  })
  return {
    get pid() {
      return pty.pid
    },
    bundledConpty: bundled,
    write(data) {
      if (exited) return
      pty.write(typeof data === 'string' ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength))
    },
    resize(cols, rows) {
      if (exited || cols <= 0 || rows <= 0) return
      try {
        pty.resize(cols, rows)
      } catch {
        // The child exited between our check and the call.
      }
    },
    onData(cb) {
      pty.onData((text) => cb(encoder.encode(text)))
    },
    onExit(cb) {
      if (exited) queueMicrotask(() => cb(exitCode))
      else exitListeners.push(cb)
    },
    pause() {
      pty.pause()
    },
    resume() {
      pty.resume()
    },
    kill() {
      if (exited) return
      try {
        pty.kill()
      } catch {
        // Already gone.
      }
    },
  }
}
