#!/usr/bin/env node
// witty: host a program in node-pty's bundled ConPTY, turn its kitty graphics
// into sixel on the way out, forward the outer terminal's input to it.
//
// Startup order matters: raw mode and VT input first (so nothing typed is
// echoed or cooked), then the cell-size queries (their replies arrive on stdin
// and must not reach the child), then the child, then the byte streams.

import { appendFileSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CellSize } from './types.ts'
import { parseArgs, USAGE, UsageError, type CliOptions } from './host/args.ts'
import { ensureVtInput, enterRawMode, leaveRawMode } from './host/console.ts'
import { spawnChild, type ChildPty } from './host/pty.ts'
import { resolveCommand, type ResolvedCommand } from './host/resolve.ts'
import { createPipeline, type WireFactory } from './pipeline.ts'
import { describeReport, formatCell, learnCellSize, ReplyFilter, trackCellSize, type CellSource } from './term/metrics.ts'

type Log = (line: string) => void

/**
 * What a child killed under us cannot undo itself, written on the ways out
 * that skip its own cleanup (a crash, a signal that outlasts the child):
 * back from the alternate screen, cursor shown, mouse reporting
 * (1000/1002/1003/1006), focus reporting (1004) and bracketed paste (2004)
 * off, one kitty keyboard level popped. `ESC 7` comes first because leaving
 * the alternate screen also restores the main screen's saved cursor, and when
 * the main screen is already showing that is wherever the last `ESC 7` (an
 * image placement, say) left it; saving the cursor first makes it stay put.
 */
const TERMINAL_RESET =
  '\x1b7\x1b[?1049l\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?2004l\x1b[<u'

/** After SIGINT, SIGBREAK or SIGHUP, how long the child's exit may take before witty leaves without it. */
const SIGNAL_EXIT_MS = 1500

/**
 * How long a chunk ending in the start of an awaited size report is held for
 * the rest of it, before it goes to the child after all.
 */
const REPLY_HOLD_MS = 100

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Appends timestamped lines to a file; logging failures are ignored (the terminal is not ours to write to). */
function createLogger(options: CliOptions): Log {
  if (!options.debug) return () => {}
  const file = options.logFile ?? path.join(os.tmpdir(), 'witty.log')
  return (line) => {
    try {
      appendFileSync(file, `${new Date().toISOString()} [${process.pid}] ${line}\n`)
    } catch {
      // Nowhere to report it.
    }
  }
}

/** Loads `createWire` from the default wiring or from `--wire <module>`. */
async function loadWire(modulePath: string | undefined): Promise<WireFactory> {
  const mod = (modulePath === undefined
    ? await import('./wire.ts')
    : await import(pathToFileURL(path.resolve(modulePath)).href)) as { createWire?: WireFactory }
  if (typeof mod.createWire !== 'function') {
    throw new Error(`${modulePath ?? 'wire.ts'} does not export createWire`)
  }
  return mod.createWire
}

function fail(message: string, code: number): never {
  process.stderr.write(`witty: ${message}\n`)
  process.exit(code)
}

async function main(argv: readonly string[]): Promise<void> {
  let options: CliOptions
  try {
    options = parseArgs(argv)
  } catch (error) {
    if (error instanceof UsageError) fail(`${error.message}\n\n${USAGE}`, 2)
    throw error
  }
  if (options.help) {
    process.stdout.write(USAGE)
    process.exit(0)
  }
  if (options.version) {
    process.stdout.write(`witty ${readVersion()}\n`)
    process.exit(0)
  }
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    fail('stdin and stdout must be a terminal (run witty directly in Windows Terminal or Tabby)', 2)
  }

  const log = createLogger(options)
  log(`witty ${readVersion()} on Node ${process.versions.node}, argv ${JSON.stringify(argv)}`)

  let resolved: ResolvedCommand
  try {
    resolved = resolveCommand(options.command, options.args)
  } catch (error) {
    fail((error as Error).message.replace(/^witty: /, ''), 127)
  }
  log(`command ${resolved.resolved} -> ${resolved.file} ${JSON.stringify(resolved.args)}`)
  const createWire = await loadWire(options.wire)

  // From here on the console is ours: restore it on every way out.
  let child: ChildPty | undefined
  /**
   * The way out that does not wait for the child: raw mode off and, once a
   * child has run (it is being killed and cannot clean up after itself), the
   * terminal modes it may have left on reset; then `message`, then exit.
   */
  const leaveNow = (code: number, message?: string): never => {
    leaveRawMode()
    if (child !== undefined) {
      try {
        process.stdout.write(TERMINAL_RESET)
      } catch {
        // The terminal is gone.
      }
    }
    if (message !== undefined) process.stderr.write(message)
    process.exit(code)
  }
  const crash = (error: unknown) => {
    log(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    child?.kill()
    leaveNow(1, `\nwitty: ${error instanceof Error ? error.message : String(error)}\n`)
  }
  process.on('uncaughtException', crash)
  process.on('unhandledRejection', crash)

  // Raw mode turns Ctrl+C into a byte for the child, but Ctrl+Break still
  // raises CTRL_BREAK_EVENT (SIGBREAK), another process can send CTRL_C_EVENT
  // (SIGINT), and closing the window sends SIGHUP. Node's default for each is
  // to end the process on the spot, raw mode and all. Instead the child is
  // killed and its exit takes the normal way out (exit code included); if it
  // has not come after SIGNAL_EXIT_MS, or a second signal arrives, witty
  // leaves without it.
  let stopping = false
  const onSignal = (signal: NodeJS.Signals) => {
    const code = 128 + (os.constants.signals[signal] ?? 0)
    if (child === undefined || stopping) {
      log(`${signal}, leaving now`)
      return leaveNow(code)
    }
    stopping = true
    log(`${signal}, killing the child`)
    child.kill()
    setTimeout(() => {
      log(`${signal}: the child has not exited after ${SIGNAL_EXIT_MS} ms, leaving`)
      leaveNow(code)
    }, SIGNAL_EXIT_MS)
  }
  for (const signal of ['SIGINT', 'SIGBREAK', 'SIGHUP'] as const) process.on(signal, onSignal)

  enterRawMode()
  log(await ensureVtInput(options.vtInput))

  const learned = await learnCellSize({ fallback: options.cell })
  for (const report of learned.reports) log(`reply ${describeReport(report)}`)
  let cell: CellSize = learned.cell
  let cellSource: CellSource = learned.source
  log(`cell size ${formatCell(cell)} (${cellSource}), ${learned.leftover.length} leftover input bytes`)

  log(`scale ${options.scale}`)
  log(`file transports ${options.files ? 'on (policy-checked)' : 'off (--no-files)'}`)
  const wire = await createWire({ cellSize: () => cell, log, scale: options.scale, files: options.files })

  const env: Record<string, string | undefined> = { ...process.env, WITTY: '1' }
  if (options.force) env.CLAUDE_CODE_FORCE_TERMINAL_IMAGES = '1'
  const cols = process.stdout.columns || 80
  const rows = process.stdout.rows || 24
  // With inheritCursor the child's ConPTY asks the terminal where its cursor
  // is (CSI 6 n, forwarded like any output) and starts its console there, so
  // a program that draws from its console cursor row draws below what the
  // shell left on screen instead of over it. The report comes back on stdin
  // and is forwarded like any input.
  const spawned = spawnChild({
    file: resolved.file,
    args: resolved.args,
    cwd: process.cwd(),
    env,
    cols,
    rows,
    inheritCursor: options.inheritCursor,
  })
  child = spawned
  log(`spawned at ${cols}x${rows}, bundled conpty ${spawned.bundledConpty}, inherit cursor ${options.inheritCursor}`)

  // Input for the child. Answers to the startup queries that missed the
  // window are still witty's (the terminal answers in order) and are taken
  // out; later ones went to whoever asked (the child) and pass on. Either
  // way they keep the cell size current.
  const replies = new ReplyFilter(learned.missing)
  let replyTimer: ReturnType<typeof setTimeout> | undefined
  const forwardInput = (bytes: Uint8Array): void => {
    clearTimeout(replyTimer)
    const { forward, reports, consumed } = replies.push(bytes)
    if (reports.length > 0) {
      for (const report of reports) {
        log(`reply ${describeReport(report)} (${consumed.includes(report) ? 'late answer to witty, consumed' : 'seen on input'})`)
      }
      const screen = { columns: process.stdout.columns || 0, rows: process.stdout.rows || 0 }
      const next = trackCellSize({ cell, source: cellSource }, reports, screen)
      if (next.cell.width !== cell.width || next.cell.height !== cell.height) {
        cell = next.cell
        cellSource = next.source
        log(`cell size ${formatCell(cell)} (${cellSource}, seen on input)`)
      }
    }
    if (forward.length > 0) spawned.write(forward)
    if (replies.holding) {
      // The start of an awaited report; if the rest does not follow, it was input after all.
      replyTimer = setTimeout(() => {
        const held = replies.flush()
        if (held.length > 0) spawned.write(held)
      }, REPLY_HOLD_MS)
    }
  }
  if (learned.leftover.length > 0) forwardInput(learned.leftover)

  // Flow control: stop reading the child while stdout is full or while a
  // kitty command is being handled; the child blocks on its full pipe.
  let holds = 0
  const hold = () => {
    if (holds++ === 0) spawned.pause()
  }
  const release = () => {
    if (--holds === 0) spawned.resume()
  }

  const writeOut = (bytes: Uint8Array): void | Promise<void> => {
    if (process.stdout.write(bytes)) return
    hold()
    return new Promise<void>((resolve) =>
      process.stdout.once('drain', () => {
        release()
        resolve()
      }),
    )
  }

  const pipeline = createPipeline({
    splitter: wire.splitter,
    engine: wire.engine,
    emitter: wire.emitter,
    cellSize: () => cell,
    screen: () => ({ columns: process.stdout.columns || 0, rows: process.stdout.rows || 0 }),
    writeOut,
    writeChild: (data) => spawned.write(data),
    log,
    scale: options.scale,
  })

  spawned.onData((bytes) => {
    const done = pipeline.feed(bytes)
    if (pipeline.pending > 0) {
      hold()
      void done.finally(release)
    }
  })

  process.stdin.on('data', (chunk: Buffer | string) => {
    forwardInput(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk)
  })
  process.stdin.on('end', () => {
    log('stdin ended, killing the child')
    spawned.kill()
  })
  process.stdin.resume()

  process.stdout.on('resize', () => {
    const c = process.stdout.columns
    const r = process.stdout.rows
    log(`resize ${c}x${r}`)
    if (c > 0 && r > 0) spawned.resize(c, r)
  })

  spawned.onExit((code) => {
    log(`child exited with ${code}`)
    // node-pty reports a failed CreateProcess as an exit with the Win32 error code, and nothing else.
    const notStarted = spawned.started ? undefined : `witty: could not start ${resolved.resolved} (error ${code})\n`
    if (notStarted !== undefined) log(notStarted.trimEnd())
    const leave = (): void => {
      leaveRawMode()
      if (notStarted !== undefined) process.stderr.write(notStarted)
    }
    // Never wait forever on a stuck engine or a terminal that stopped reading.
    const deadline = setTimeout(() => {
      leave()
      process.exit(code)
    }, 3000)
    deadline.unref()
    void pipeline
      .end()
      .catch((error: unknown) => log(`pipeline end: ${String(error)}`))
      .then(() => {
        leave()
        // The empty write's callback runs once everything before it is flushed.
        process.stdout.write('', () => process.exit(code))
      })
  })
}

main(process.argv.slice(2)).catch((error: unknown) => {
  leaveRawMode()
  process.stderr.write(`witty: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
