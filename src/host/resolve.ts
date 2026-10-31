// Resolve the child command the way a Windows shell would, so `witty claude`
// finds `claude.exe` (or `claude.cmd`) on PATH, and build the command line
// node-pty needs for it.

import { statSync } from 'node:fs'
import path from 'node:path'

/** What to hand to node-pty: the executable and its arguments. */
export type ResolvedCommand = {
  /** Absolute path of the program to start (for batch files: `cmd.exe`). */
  file: string
  /**
   * The arguments as a pre-escaped command line string, which node-pty
   * appends to the quoted `file` and hands to CreateProcess as is: quoted per
   * the MSVC rules for programs, per cmd's rules for batch files. A program
   * with no arguments gets `[]`: node-pty takes an empty string as the whole
   * command line and leaves `file` unquoted, which CreateProcess would read as
   * `C:\Program.exe` for `C:\Program Files\...`.
   */
  args: string | []
  /** The file the user's command resolved to (the `.cmd` itself for batch files). */
  resolved: string
}

export type ResolveOptions = {
  /** Environment to read `PATH`, `PATHEXT` and `ComSpec` from (keys are matched case-insensitively). */
  env?: Record<string, string | undefined>
  /** Directory relative paths are resolved against. Default `process.cwd()`. */
  cwd?: string
  /** File existence check, for tests. Default: a regular file exists at the path. */
  isFile?: (file: string) => boolean
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/**
 * The only files witty can start: programs (CreateProcess) and batch files
 * (through cmd.exe). PATHEXT also lists .JS, .VBS, .MSC and the like, which a
 * shell opens through their file association; CreateProcess cannot, so a hit
 * on one would end in ERROR_BAD_EXE_FORMAT instead of the program further on.
 */
const LAUNCHABLE = new Set(['.com', '.exe', '.bat', '.cmd'])

/** Whether witty can start a file with this name: its extension is .com, .exe, .bat or .cmd. */
export function isLaunchable(file: string): boolean {
  return LAUNCHABLE.has(path.win32.extname(file).toLowerCase())
}

/** Reads an environment variable by case-insensitive name (Windows semantics). */
export function getEnv(env: Record<string, string | undefined>, name: string): string | undefined {
  const direct = env[name]
  if (direct !== undefined) return direct
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === lower) return value
  }
  return undefined
}

function defaultIsFile(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/** True when `name` names a path (has a separator or a drive) rather than a bare program name. */
function isPathLike(name: string): boolean {
  return /[\\/]/.test(name) || /^[A-Za-z]:/.test(name)
}

/** The directories a bare name is looked up in: the absolute `PATH` entries, quotes removed. */
function searchDirs(env: Record<string, string | undefined>): string[] {
  return (getEnv(env, 'PATH') ?? '')
    .split(';')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => path.win32.isAbsolute(d))
}

/** Looks `name` up as a path against `cwd`, or in each `PATH` directory, taking the first candidate that exists. */
function search(name: string, candidatesIn: (base: string) => string[], options: ResolveOptions): string | undefined {
  const env = options.env ?? process.env
  const isFile = options.isFile ?? defaultIsFile
  if (isPathLike(name)) return candidatesIn(path.win32.resolve(options.cwd ?? process.cwd(), name)).find(isFile)
  for (const dir of searchDirs(env)) {
    const hit = candidatesIn(path.win32.join(dir, name)).find(isFile)
    if (hit !== undefined) return hit
  }
  return undefined
}

/**
 * Finds the program `name` refers to: a path is taken relative to `cwd`;
 * a bare name is looked up in each absolute `PATH` directory in turn.
 * Relative entries (`.`, `bin`, `C:tools`) are skipped: they would search the
 * current directory, which a bare name never does here. Only files witty can
 * start count ({@link isLaunchable}): a name ending in .com, .exe, .bat or
 * .cmd is taken as is; any other name, dotted ones like `python3.12`
 * included, gets each launchable `PATHEXT` extension appended, in `PATHEXT`
 * order. An extensionless file (a POSIX shim next to npm's .cmd) or a .js on
 * PATH never shadows a program further on. Returns undefined when nothing
 * matches.
 */
export function findExecutable(name: string, options: ResolveOptions = {}): string | undefined {
  const env = options.env ?? process.env
  let exts = (getEnv(env, 'PATHEXT') ?? DEFAULT_PATHEXT)
    .split(';')
    .map((e) => e.trim().toLowerCase()) // the file system ignores case; lower case reads better
    .filter((e) => LAUNCHABLE.has(e))
  if (exts.length === 0) exts = DEFAULT_PATHEXT.toLowerCase().split(';')
  exts = [...new Set(exts)]
  const asIs = isLaunchable(name)
  return search(name, (base) => (asIs ? [base] : exts.map((e) => base + e)), options)
}

// What an argument may hold and still go to a batch file unquoted (Rust's set, ASCII only).
const BATCH_PLAIN = /^[A-Za-z0-9#$*+\-./:?@\\_]+$/

/**
 * `%` becomes `%%cd:~,%`: cmd keeps the first `%` and expands `%cd:~,%` (an
 * empty substring of the current directory) to nothing, so no `%name%` in the
 * argument can ever pair up and expand.
 */
function neutralizePercents(text: string): string {
  return text.replace(/%/g, '%%cd:~,%')
}

/**
 * Quotes one argument for a batch file run through `cmd.exe`, which parses it
 * twice: once on our command line and again where the batch file expands `%*`
 * (as npm's shims do). The Rust approach (CVE-2024-24576): quote anything not
 * plainly safe, per the MSVC rules but with `"` doubled to `""`, so cmd's
 * quote state never flips inside the argument and `&|<>^()` stay quoted on
 * both passes; MSVC programs (node.exe) read `""` inside quotes as one `"`.
 * Throws for CR, LF and NUL, which no quoting can carry through cmd.
 */
export function escapeBatchArgument(arg: string): string {
  if (/[\r\n\0]/.test(arg)) {
    throw new Error(`witty: cannot pass an argument with a line break or NUL to a batch file: ${JSON.stringify(arg)}`)
  }
  if (BATCH_PLAIN.test(arg)) return arg
  const quoted = arg.replace(/(\\*)"/g, '$1$1""').replace(/(\\*)$/, '$1$1')
  return `"${neutralizePercents(quoted)}"`
}

/**
 * Quotes one argument for a program that splits its command line by the
 * MSVC rules (CommandLineToArgvW, the C runtime, node.exe): left alone unless
 * it is empty or holds whitespace or `"`; otherwise wrapped in quotes, each
 * `"` escaped as `\"`, and the backslashes before a `"` or before the closing
 * quote doubled. node-pty's own quoting leaves `"a b"` unquoted (it looks
 * quoted already, so it arrives as `"a` and `b"`) and drops a lone space.
 */
export function quoteWindowsArgument(arg: string): string {
  if (arg !== '' && !/[ \t\n\v"]/.test(arg)) return arg
  let out = '"'
  let backslashes = 0
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++
    } else if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"'
      backslashes = 0
    } else {
      out += '\\'.repeat(backslashes) + ch
      backslashes = 0
    }
  }
  return `${out}${'\\'.repeat(backslashes * 2)}"`
}

/**
 * Resolves `command` with `args` for node-pty. `.cmd`/`.bat` files are run
 * as `cmd.exe /d /e:on /v:off /s /c ""<file>" <args>"` with batch-escaped
 * arguments (command extensions on for the `%` neutralizing, delayed
 * expansion off so `!` stays literal); programs are started directly, with
 * the command line quoted here ({@link quoteWindowsArgument}). Either way
 * node-pty gets a string, which it appends to the quoted file as is.
 * Throws when the command cannot be found, names a file witty cannot start,
 * or an argument cannot be passed.
 */
export function resolveCommand(command: string, args: string[], options: ResolveOptions = {}): ResolvedCommand {
  const env = options.env ?? process.env
  const found = findExecutable(command, options)
  if (found === undefined) {
    // Say so when the name itself is there but is no program (a .ps1, a .js, an extensionless shim).
    const other = isLaunchable(command) ? undefined : search(command, (base) => [base], options)
    if (other !== undefined) {
      throw new Error(`witty: cannot start ${other}: only .exe, .com, .cmd and .bat files can be run`)
    }
    throw new Error(`witty: command not found: ${command}`)
  }
  const ext = path.win32.extname(found).toLowerCase()
  if (ext === '.cmd' || ext === '.bat') {
    // Absolute, so a bare `cmd.exe` is never looked up in the current directory.
    const systemRoot = getEnv(env, 'SystemRoot') || getEnv(env, 'windir') || 'C:\\Windows'
    const comspec = getEnv(env, 'ComSpec') || path.win32.join(systemRoot, 'System32', 'cmd.exe')
    // File names cannot hold `"`, so quoting the path needs only the `%` treatment.
    const line = [`"${neutralizePercents(found)}"`, ...args.map(escapeBatchArgument)].join(' ')
    return { file: comspec, args: `/d /e:on /v:off /s /c "${line}"`, resolved: found }
  }
  if (args.some((arg) => arg.includes('\0'))) {
    // The command line is a NUL-terminated string: everything after one would vanish.
    throw new Error(`witty: cannot pass an argument with a NUL to ${found}`)
  }
  return { file: found, args: args.length === 0 ? [] : args.map(quoteWindowsArgument).join(' '), resolved: found }
}
