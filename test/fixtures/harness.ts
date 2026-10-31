// Test harness: runs a command inside an outer node-pty (bundled ConPTY, as
// Windows Terminal hosts witty) and plays the outer terminal: it records
// everything written, answers the queries a real terminal would answer, and
// lets the test type and resize.

import * as nodePty from 'node-pty'
import { releaseNodePty, settleExitCode, watchInput } from '../../src/host/pty.ts'
import { quoteWindowsArgument } from '../../src/host/resolve.ts'

export type OuterOptions = {
  cwd?: string
  cols?: number
  rows?: number
  env?: Record<string, string | undefined>
  /** Reply to `CSI 16 t` with this cell size; undefined: stay silent. */
  cellSize?: { width: number; height: number }
  /** Reply to `CSI 14 t` with this text area size in pixels; undefined: stay silent. */
  textArea?: { width: number; height: number }
  /** Reply to `CSI 18 t` with this text area size in cells; undefined: stay silent. */
  textCells?: { columns: number; rows: number }
}

export type Outer = {
  /** Everything the program wrote so far. */
  output(): string
  /** Waits until `test` matches the output (from `from` on); rejects with the output after `timeoutMs`. */
  waitFor(test: string | RegExp, timeoutMs?: number, from?: number): Promise<void>
  write(data: string): void
  resize(cols: number, rows: number): void
  /** Resolves with the exit code. */
  exited: Promise<number>
  /** Kills the program if it is still running and releases node-pty. */
  dispose(): void
}

const ANSWERS: Array<[RegExp, (o: OuterOptions) => string | undefined]> = [
  // DA1: ConPTY asks at startup and waits for the answer.
  [/\x1b\[0?c/g, () => '\x1b[?61;4c'],
  // DSR 6: the child's ConPTY asks at startup to inherit the cursor position.
  [/\x1b\[6n/g, () => '\x1b[1;1R'],
  [/\x1b\[16t/g, (o) => (o.cellSize ? `\x1b[6;${o.cellSize.height};${o.cellSize.width}t` : undefined)],
  [/\x1b\[14t/g, (o) => (o.textArea ? `\x1b[4;${o.textArea.height};${o.textArea.width}t` : undefined)],
  [/\x1b\[18t/g, (o) => (o.textCells ? `\x1b[8;${o.textCells.rows};${o.textCells.columns}t` : undefined)],
]

export function startOuter(file: string, args: string[], options: OuterOptions = {}): Outer {
  // Quoted here, as witty does: node-pty's own quoting splits `"a b"` and drops a lone space.
  // No arguments must be [] rather than '', which node-pty would take as the command line, file unquoted.
  const pty = nodePty.spawn(file, args.length === 0 ? [] : args.map(quoteWindowsArgument).join(' '), {
    name: 'xterm-256color',
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    useConptyDll: true,
  })
  let out = ''
  let scanned = 0
  let done = false
  // Typing at a program that has just exited fails asynchronously on node-pty's
  // input pipe (EAGAIN); without a listener that would crash the test run.
  let inputClosed = false
  watchInput(pty, () => {
    inputClosed = true
  })
  const send = (data: string): void => {
    if (!done && !inputClosed) pty.write(data)
  }
  const waiters = new Set<() => void>()
  pty.onData((data) => {
    out += data
    // Answer queries; rescan a short overlap so a query split across chunks is seen once.
    const start = Math.max(0, scanned - 8)
    const region = out.slice(start)
    for (const [re, answer] of ANSWERS) {
      re.lastIndex = 0
      for (let m = re.exec(region); m !== null; m = re.exec(region)) {
        if (start + m.index + m[0].length <= scanned) continue
        const reply = answer(options)
        if (reply !== undefined) send(reply)
      }
    }
    scanned = out.length
    for (const w of waiters) w()
  })
  const exited = new Promise<number>((resolve) => {
    pty.onExit(({ exitCode }) => {
      done = true
      // node-pty can fire 'exit' before the native exit code arrives (see settleExitCode).
      void settleExitCode(pty, exitCode).then((code) => {
        releaseNodePty(pty)
        resolve(code)
        for (const w of waiters) w()
      })
    })
  })
  return {
    output: () => out,
    waitFor(test, timeoutMs = 15000, from = 0) {
      const matches = () => {
        const s = out.slice(from)
        return typeof test === 'string' ? s.includes(test) : test.test(s)
      }
      return new Promise((resolve, reject) => {
        if (matches()) return resolve()
        const check = () => {
          if (matches()) {
            cleanup()
            resolve()
          } else if (done) {
            cleanup()
            reject(new Error(`exited before ${String(test)} appeared; output: ${JSON.stringify(out)}`))
          }
        }
        const timer = setTimeout(() => {
          cleanup()
          reject(new Error(`timed out waiting for ${String(test)}; output: ${JSON.stringify(out)}`))
        }, timeoutMs)
        const cleanup = () => {
          clearTimeout(timer)
          waiters.delete(check)
        }
        waiters.add(check)
      })
    },
    write: send,
    resize: (cols, rows) => {
      if (done) return
      try {
        pty.resize(cols, rows)
      } catch {
        // The program exited between the check and the call.
      }
    },
    exited,
    dispose() {
      if (!done) {
        try {
          pty.kill()
        } catch {
          // Already gone.
        }
      }
      releaseNodePty(pty)
    },
  }
}

/** Child lines `IN:<hex>` in the output, decoded to hex strings. */
export function inputLines(output: string): string[] {
  return [...output.matchAll(/IN:([0-9a-f]+)/g)].map((m) => m[1] as string)
}

/** Rejects if `promise` does not settle within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** Hex of a latin1 string, as the fake child prints its input. */
export function hex(s: string): string {
  return Buffer.from(s, 'latin1').toString('hex')
}
