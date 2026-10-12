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
import { describeReport, formatCell, learnCellSize, parseWindowReports, trackCellSize, type CellSource } from './term/metrics.ts'

type Log = (line: string) => void

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
  const crash = (error: unknown) => {
    leaveRawMode()
    log(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    process.stderr.write(`\nwitty: ${error instanceof Error ? error.message : String(error)}\n`)
    child?.kill()
    process.exit(1)
  }
  process.on('uncaughtException', crash)
  process.on('unhandledRejection', crash)

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
  if (learned.leftover.length > 0) spawned.write(learned.leftover)

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
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    // Passively track the cell size when anyone (the child, usually) asks for it.
    const reports = parseWindowReports(bytes)
    if (reports.length > 0) {
      for (const report of reports) log(`reply ${describeReport(report)} (seen on input)`)
      const screen = { columns: process.stdout.columns || 0, rows: process.stdout.rows || 0 }
      const next = trackCellSize({ cell, source: cellSource }, reports, screen)
      if (next.cell.width !== cell.width || next.cell.height !== cell.height) {
        cell = next.cell
        cellSource = next.source
        log(`cell size ${formatCell(cell)} (${cellSource}, seen on input)`)
      }
    }
    spawned.write(bytes)
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

  process.on('SIGHUP', () => {
    log('SIGHUP, killing the child')
    spawned.kill()
    leaveRawMode()
    process.exit(129)
  })

  spawned.onExit((code) => {
    log(`child exited with ${code}`)
    // Never wait forever on a stuck engine or a terminal that stopped reading.
    const deadline = setTimeout(() => {
      leaveRawMode()
      process.exit(code)
    }, 3000)
    deadline.unref()
    void pipeline
      .end()
      .catch((error: unknown) => log(`pipeline end: ${String(error)}`))
      .then(() => {
        leaveRawMode()
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
