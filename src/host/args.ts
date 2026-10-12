// Command-line parsing for `witty [witty options] [--] [command [args...]]`.

import type { CellSize, ScaleMode } from '../types.ts'
import { DEFAULT_CELL_SIZE, parseCellOption } from '../term/metrics.ts'
import type { VtInputPolicy } from './console.ts'

export type CliOptions = {
  /** Fallback cell size when the terminal does not answer `CSI 16 t`. */
  cell: CellSize
  /** Logging on (to `logFile`, or `%TEMP%\witty.log`). */
  debug: boolean
  /** Append log lines here; implies logging. */
  logFile: string | undefined
  /** How images are scaled to their cell box. */
  scale: ScaleMode
  /** Allow the kitty file transports (t=f, t=t) under the file policy. */
  files: boolean
  /** Set `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1` in the child. */
  force: boolean
  /** Start the child's console at the terminal's cursor position (ConPTY inherit-cursor). */
  inheritCursor: boolean
  help: boolean
  version: boolean
  /** Hidden: module exporting `createWire` (tests). */
  wire: string | undefined
  /** Hidden: whether to run the console VT-input helper. */
  vtInput: VtInputPolicy
  /** The child command; `claude` by default. */
  command: string
  args: string[]
}

export class UsageError extends Error {}

export const USAGE = `Usage: witty [options] [--] [command [args...]]

Runs command (default: claude) in a pseudo-console and turns its kitty
graphics into sixel for Windows Terminal and Tabby.

Options:
  --cell WxH     cell size in pixels if the terminal does not report it
                 (default 10x20; decimals allowed, e.g. 9.375x20)
  --debug        log to --log <file>, or to %TEMP%\\witty.log
  --log <file>   append log lines to <file> (implies --debug)
  --no-files     refuse kitty file transmissions (t=f, t=t); by default they
                 read only regular files on local drive paths
  --no-force     do not set CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1 for the command
  --no-inherit-cursor
                 start the command's console with its cursor at the top-left
                 instead of where the terminal's cursor is (witty asks with
                 CSI 6 n); programs that draw from their console cursor row
                 then paint over what the shell left on screen
  --scale MODE   how images are scaled to their cells: auto (default; sharp
                 nearest-neighbour when enlarged 2x or more, as for pixel art
                 and icons, smooth otherwise), nearest, or smooth
  --help         show this help
  --version      show the version
`

/** Parses witty's argv (without `node` and the script). Throws UsageError on bad input. */
export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    cell: DEFAULT_CELL_SIZE,
    debug: false,
    logFile: undefined,
    scale: 'auto',
    files: true,
    force: true,
    inheritCursor: true,
    help: false,
    version: false,
    wire: undefined,
    vtInput: 'auto',
    command: 'claude',
    args: [],
  }
  let i = 0
  const value = (name: string, inline: string | undefined): string => {
    if (inline !== undefined) return inline
    const next = argv[++i]
    if (next === undefined) throw new UsageError(`${name} needs a value`)
    return next
  }
  for (; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--') {
      i++
      break
    }
    if (!arg.startsWith('-') || arg === '-') break
    const eq = arg.indexOf('=')
    const name = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg
    const inline = arg.startsWith('--') && eq > 0 ? arg.slice(eq + 1) : undefined
    switch (name) {
      case '--cell': {
        const raw = value(name, inline)
        const cell = parseCellOption(raw)
        if (cell === undefined) throw new UsageError(`--cell expects WxH, e.g. 10x20, got "${raw}"`)
        options.cell = cell
        break
      }
      case '--debug':
        options.debug = true
        break
      case '--log':
        options.logFile = value(name, inline)
        options.debug = true
        break
      case '--scale': {
        const raw = value(name, inline)
        if (raw !== 'auto' && raw !== 'nearest' && raw !== 'smooth') {
          throw new UsageError(`--scale expects auto, nearest or smooth, got "${raw}"`)
        }
        options.scale = raw
        break
      }
      case '--no-files':
        options.files = false
        break
      case '--no-force':
        options.force = false
        break
      case '--no-inherit-cursor':
        options.inheritCursor = false
        break
      case '--help':
      case '-h':
        options.help = true
        break
      case '--version':
      case '-V':
        options.version = true
        break
      case '--wire':
        options.wire = value(name, inline)
        break
      case '--vt-input': {
        const raw = value(name, inline)
        if (raw !== 'auto' && raw !== 'always' && raw !== 'never') {
          throw new UsageError(`--vt-input expects auto, always or never, got "${raw}"`)
        }
        options.vtInput = raw
        break
      }
      default:
        throw new UsageError(`unknown option ${arg}`)
    }
  }
  const rest = argv.slice(i)
  if (rest.length > 0) {
    options.command = rest[0] as string
    options.args = rest.slice(1)
  }
  return options
}
