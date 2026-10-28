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
   * The arguments: an argv array (node-pty quotes it per the MSVC rules), or,
   * for batch files run through `cmd.exe`, a pre-escaped command line string
   * (node-pty appends it to the quoted `file` and hands it to CreateProcess as is).
   */
  args: string[] | string
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

/**
 * Finds the file `name` refers to: a path is taken relative to `cwd`;
 * a bare name is looked up in each absolute `PATH` directory, first with each
 * `PATHEXT` extension (unless it already has an extension), then bare.
 * Relative entries (`.`, `bin`, `C:tools`) are skipped: they would search the
 * current directory, which a bare name never does here. A path without an
 * extension also gets the `PATHEXT` treatment. Returns undefined when nothing
 * matches.
 */
export function findExecutable(name: string, options: ResolveOptions = {}): string | undefined {
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const isFile = options.isFile ?? defaultIsFile
  const exts = (getEnv(env, 'PATHEXT') ?? DEFAULT_PATHEXT)
    .split(';')
    .map((e) => e.trim().toLowerCase()) // the file system ignores case; lower case reads better
    .filter((e) => e.length > 0)
  const hasExt = path.win32.extname(name) !== ''

  const candidatesIn = (base: string): string[] =>
    hasExt ? [base] : [...exts.map((e) => base + e), base]

  if (isPathLike(name)) {
    const base = path.win32.resolve(cwd, name)
    return candidatesIn(base).find(isFile)
  }
  const dirs = (getEnv(env, 'PATH') ?? '')
    .split(';')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => path.win32.isAbsolute(d))
  for (const dir of dirs) {
    const hit = candidatesIn(path.win32.join(dir, name)).find(isFile)
    if (hit !== undefined) return hit
  }
  return undefined
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
 * Resolves `command` with `args` for node-pty. `.cmd`/`.bat` files are run
 * as `cmd.exe /d /e:on /v:off /s /c ""<file>" <args>"` with batch-escaped
 * arguments (command extensions on for the `%` neutralizing, delayed
 * expansion off so `!` stays literal); anything else is started directly.
 * Throws when the command cannot be found or an argument cannot be passed.
 */
export function resolveCommand(command: string, args: string[], options: ResolveOptions = {}): ResolvedCommand {
  const env = options.env ?? process.env
  const found = findExecutable(command, options)
  if (found === undefined) {
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
  return { file: found, args, resolved: found }
}
