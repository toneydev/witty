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
   * for batch files run through `cmd.exe`, a pre-escaped command line string.
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
 * a bare name is looked up in each `PATH` directory, first with each `PATHEXT`
 * extension (unless it already has an extension), then bare. A path without
 * an extension also gets the `PATHEXT` treatment. Returns undefined when
 * nothing matches.
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
    .filter((d) => d.length > 0)
  for (const dir of dirs) {
    const hit = candidatesIn(path.win32.join(dir, name)).find(isFile)
    if (hit !== undefined) return hit
  }
  return undefined
}

// cmd.exe metacharacters, escaped with `^` (the cross-spawn rules).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g

/** Quotes one argument per the MSVC rules, then `^`-escapes it for cmd.exe. */
export function escapeCmdArgument(arg: string): string {
  let quoted = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')
  quoted = `"${quoted}"`
  return quoted.replace(CMD_META, '^$1')
}

/**
 * Resolves `command` with `args` for node-pty. `.cmd`/`.bat` files are run
 * as `cmd.exe /d /s /c "<file> <args>"` with cmd-escaped arguments; anything
 * else is started directly. Throws when the command cannot be found.
 */
export function resolveCommand(command: string, args: string[], options: ResolveOptions = {}): ResolvedCommand {
  const env = options.env ?? process.env
  const found = findExecutable(command, options)
  if (found === undefined) {
    throw new Error(`witty: command not found: ${command}`)
  }
  const ext = path.win32.extname(found).toLowerCase()
  if (ext === '.cmd' || ext === '.bat') {
    const comspec = getEnv(env, 'ComSpec') ?? 'cmd.exe'
    const line = [escapeCmdArgument(found), ...args.map(escapeCmdArgument)].join(' ')
    return { file: comspec, args: `/d /s /c "${line}"`, resolved: found }
  }
  return { file: found, args, resolved: found }
}
