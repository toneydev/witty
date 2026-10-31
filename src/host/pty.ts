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
  /**
   * Start the child's console with the outer terminal's cursor position
   * (ConPTY's inherit-cursor flag: it asks the terminal with `CSI 6 n` and
   * waits for the report). Default true. Without it the child's console starts
   * with its cursor at the top-left while the terminal's is wherever the shell
   * left it, and a program that draws from its console cursor row (Claude
   * Code) overwrites what was on screen.
   */
  inheritCursor?: boolean
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
  /**
   * Whether the process was ever created. False when CreateProcess failed
   * (node-pty then reports the Win32 error code as the exit code).
   */
  readonly started: boolean
  /** Whether the input pipe has closed (the pseudo-console is gone); writes are dropped from then on. */
  readonly inputClosed: boolean
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
  const inheritCursor = options.inheritCursor ?? true
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
    pty = spawn(options.file, options.args, { ...base, useConptyDll: true, conptyInheritCursor: inheritCursor })
  } catch (error) {
    warn(
      `witty: the bundled ConPTY failed to start (${(error as Error).message}); ` +
        'falling back to the system ConPTY, kitty images may not pass through.',
    )
    bundled = false
    pty = spawn(options.file, options.args, { ...base, useConptyDll: false, conptyInheritCursor: inheritCursor })
  }
  return wrap(pty, bundled)
}

/** How long {@link settleExitCode} waits for node-pty's native exit callback. */
export const EXIT_CODE_SETTLE_MS = 2000

/**
 * The exit code of a node-pty child whose 'exit' event just fired. On
 * Windows node-pty emits 'exit' when the conout pipe closes, with whatever
 * exit code the native side has reported so far; when the pipe closes first
 * that is `undefined` (seen in CI as a flaky `undefined !== 42`), and a
 * caller taking it at face value would turn a failed child into exit 0.
 * The code arrives on the agent moments later, so this polls for it, for
 * at most {@link EXIT_CODE_SETTLE_MS}, looks once more after that (a busy
 * event loop can overrun the deadline while the code is already there), and
 * only then gives up with 1: an exit code nobody reported is not a success.
 * Reaches into node-pty internals (1.2.0-beta), hence the optional chaining.
 */
export async function settleExitCode(pty: nodePty.IPty, reported: number | undefined, settleMs = EXIT_CODE_SETTLE_MS): Promise<number> {
  if (typeof reported === 'number') return reported
  const agent = (pty as unknown as { _agent?: { exitCode?: number } })._agent
  const deadline = Date.now() + settleMs
  while (Date.now() < deadline) {
    const code = agent?.exitCode
    if (typeof code === 'number') return code
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const code = agent?.exitCode
  return typeof code === 'number' ? code : 1
}

/** A stream node-pty writes the child's input to, as far as {@link watchInput} needs it. */
type ErrorSource = { on?: (event: 'error', listener: (error: Error) => void) => unknown }

/**
 * Listens for errors on node-pty's input pipe (`_agent.inSocket`), calling
 * `onClosed` on the first. Once the child has exited its pseudo-console goes
 * away, and a write that lands before node-pty's 'exit' event (which waits
 * for the output pipe to drain, tens of milliseconds later) fails
 * asynchronously with EAGAIN (libuv's name for ERROR_NO_DATA). node-pty puts
 * no 'error' listener on that socket, so without this one a keystroke typed
 * as the child exits crashes the host. Returns false when the socket is not
 * where this node-pty version keeps it.
 */
export function watchInput(pty: nodePty.IPty, onClosed: (error: Error) => void): boolean {
  try {
    const socket = (pty as unknown as { _agent?: { inSocket?: ErrorSource } })._agent?.inSocket
    if (typeof socket?.on !== 'function') return false
    let closed = false
    socket.on('error', (error) => {
      if (closed) return
      closed = true
      onClosed(error)
    })
    return true
  } catch {
    return false
  }
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
  let inputClosed = false
  watchInput(pty, () => {
    inputClosed = true
  })
  const exitListeners: Array<(code: number) => void> = []
  pty.onExit(({ exitCode: code }) => {
    if (exited) return
    exited = true
    void settleExitCode(pty, code).then((settled) => {
      exitCode = settled
      for (const cb of exitListeners) cb(settled)
      releaseNodePty(pty)
    })
  })
  return {
    get pid() {
      return pty.pid
    },
    bundledConpty: bundled,
    get started() {
      // node-pty learns the pid once CreateProcess succeeded; after a failure it stays 0.
      return pty.pid > 0
    },
    get inputClosed() {
      return inputClosed
    },
    write(data) {
      if (exited || inputClosed) return
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
