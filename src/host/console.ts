// The outer console: raw VT input in, VT output out.
//
// Findings (Windows 11 26300, Node 24.20 / libuv 1.52.1, measured inside
// node-pty's bundled ConPTY 1.25 with the host-console/host-e2e harnesses and
// a PowerShell GetConsoleMode probe):
//
// - Before `setRawMode(true)` the input mode is 0x1f7 (processed, line,
//   echo, window, mouse, insert, quick-edit, extended flags).
// - After `setRawMode(true)` it is 0x208: ENABLE_VIRTUAL_TERMINAL_INPUT
//   (0x200) | ENABLE_WINDOW_INPUT (0x8). libuv's raw mode on this version is
//   its RAW_VT mode: it reads the console's VT byte stream verbatim, so SGR
//   mouse reports (`ESC [ < 0 ; 5 ; 6 M`), kitty-keyboard sequences
//   (`ESC [ 97 ; 5 u`), focus reports, bracketed paste and win32-input-mode
//   sequences all reach us byte for byte. Nothing extra is needed.
// - If VT input is cleared again (what an older libuv's plain raw mode looks
//   like), the conhost turns SGR mouse input into MOUSE_EVENT records, which
//   libuv drops: the mouse report vanishes, while `ESC [ 97 ; 5 u` still
//   arrives (as key records carrying characters). Setting 0x200 back from a
//   helper process that shares the console restores the pass-through: the
//   console input mode belongs to the console, not to the process, so it
//   persists after the helper exits. `setConsoleModes` below does that with
//   powershell.exe and a P/Invoke of GetConsoleMode/SetConsoleMode on
//   CONIN$/CONOUT$; `ensureVtInput` runs it only on Node versions where raw
//   mode is not known to be RAW_VT (it costs a PowerShell start, ~0.5 s).
// - The output mode Node leaves on CONOUT$ is 0x7: processed output, wrap at
//   EOL and ENABLE_VIRTUAL_TERMINAL_PROCESSING (0x4), so CSI and DCS (sixel)
//   we write pass through to the outer terminal; the e2e harness checks that
//   a DCS written by the pipeline arrives intact.
// - `setRawMode(false)` restores the mode libuv saved at startup, which also
//   undoes anything the helper set.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * Where the helper's powershell.exe lives: always the system copy by
 * absolute path, never a PATH lookup (a powershell.exe in the working
 * directory or earlier on PATH must not run).
 */
export function powershellPath(env: Record<string, string | undefined> = process.env): string {
  return path.win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** Console input mode bit: deliver input as VT sequences. */
export const ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200
/** Console output mode bit: interpret VT sequences written to the screen buffer. */
export const ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004

/** The console modes before and after `setConsoleModes`. */
export type ConsoleModes = {
  inputBefore: number
  outputBefore: number
  inputAfter: number
  outputAfter: number
}

export type SetConsoleModesOptions = {
  /** Bits to OR into the CONIN$ mode. */
  inputSet?: number
  /** Bits to clear from the CONIN$ mode (applied before `inputSet`). */
  inputClear?: number
  /** Bits to OR into the CONOUT$ mode. */
  outputSet?: number
  /** Give up after this many ms. Default {@link helperTimeoutMs}: 30 s, or WITTY_CONSOLE_HELPER_TIMEOUT_MS. */
  timeoutMs?: number
}

/** How long the helper may take by default: a cold PowerShell start on a CI runner can take many seconds. */
export const CONSOLE_HELPER_TIMEOUT_MS = 30_000

/** The helper timeout: `WITTY_CONSOLE_HELPER_TIMEOUT_MS` when it is a positive integer, else 30 s. */
export function helperTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.WITTY_CONSOLE_HELPER_TIMEOUT_MS
  const value = raw !== undefined && /^\d{1,7}$/.test(raw.trim()) ? Number(raw.trim()) : 0
  return value > 0 ? value : CONSOLE_HELPER_TIMEOUT_MS
}

/** One line of helper output for an error message: whitespace collapsed, cut to `max` characters. */
function oneLine(text: string, max = 2000): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max)}...` : line
}

// powershell.exe retitles whatever console it starts in, and in a
// pseudo-console that becomes an OSC 0 sent to the outer terminal (and the
// title cannot be restored: the helper only ever sees its own). So the
// helper is started with a hidden console of its own (windowsHide and no
// inherited stdio give CREATE_NO_WINDOW), then FreeConsole + AttachConsole
// moves it onto ours, where it opens CONIN$/CONOUT$ (its std handles are
// pipes) and changes the modes. Nothing is ever written to our screen.
//
// The P/Invoke declarations are built with Reflection.Emit (DefineMethod with
// PinvokeImpl plus a DllImport attribute), not Add-Type: Add-Type runs the C#
// compiler (csc.exe, writing and loading temp .cs/.dll files), which on a
// cold CI runner took longer than the old 10 s timeout. Emit needs no
// compiler and no files; measured warm locally it is ~50 ms against ~83 ms
// for Add-Type, and it does not depend on csc or the temp directory at all.
const HELPER_SCRIPT = String.raw`
param([uint32]$InSet, [uint32]$InClear, [uint32]$OutSet, [uint32]$AttachPid)
$ErrorActionPreference = 'Stop'
$asm = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName 'WittyConsole'), [Reflection.Emit.AssemblyBuilderAccess]::Run)
$tb = $asm.DefineDynamicModule('WittyConsole').DefineType('WittyConsole.Native', 'Public, Class, Sealed')
$di = [Runtime.InteropServices.DllImportAttribute]
$ctor = $di.GetConstructor([Type[]]@([string]))
$fields = [Reflection.FieldInfo[]]@($di.GetField('SetLastError'), $di.GetField('CharSet'))
$values = [object[]]@($true, [Runtime.InteropServices.CharSet]::Unicode)
function Native([string]$Name, [Type]$Ret, [Type[]]$Params) {
  $m = $tb.DefineMethod($Name, 'Public, Static, PinvokeImpl, HideBySig', $Ret, $Params)
  $m.SetCustomAttribute((New-Object Reflection.Emit.CustomAttributeBuilder($ctor, [object[]]@('kernel32.dll'), $fields, $values)))
}
Native 'CreateFileW' ([IntPtr]) @([string], [uint32], [uint32], [IntPtr], [uint32], [uint32], [IntPtr])
Native 'GetConsoleMode' ([bool]) @([IntPtr], [uint32].MakeByRefType())
Native 'SetConsoleMode' ([bool]) @([IntPtr], [uint32])
Native 'CloseHandle' ([bool]) @([IntPtr])
Native 'FreeConsole' ([bool]) $null
Native 'AttachConsole' ([bool]) @([uint32])
$N = $tb.CreateType()
function LastError { [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
if ($AttachPid -ne 0) {
  [void]$N::FreeConsole()
  if (-not $N::AttachConsole($AttachPid)) { throw "AttachConsole($AttachPid) failed: error $(LastError)" }
}
function Open($name) {
  $h = $N::CreateFileW($name, [uint32]3221225472, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
  if ($h -eq [IntPtr]::Zero -or $h -eq [IntPtr]::new(-1)) { throw "CreateFile($name) failed: error $(LastError)" }
  $h
}
$in = Open 'CONIN$'; $out = Open 'CONOUT$'
$ib = [uint32]0; $ob = [uint32]0
if (-not $N::GetConsoleMode($in, [ref]$ib)) { throw "GetConsoleMode(CONIN) failed: error $(LastError)" }
if (-not $N::GetConsoleMode($out, [ref]$ob)) { throw "GetConsoleMode(CONOUT) failed: error $(LastError)" }
$im = [uint32](($ib -band (-bnot $InClear)) -bor $InSet)
$om = [uint32]($ob -bor $OutSet)
if ($im -ne $ib -and -not $N::SetConsoleMode($in, $im)) { throw "SetConsoleMode(CONIN) failed: error $(LastError)" }
if ($om -ne $ob -and -not $N::SetConsoleMode($out, $om)) { throw "SetConsoleMode(CONOUT) failed: error $(LastError)" }
$ia = [uint32]0; $oa = [uint32]0
[void]$N::GetConsoleMode($in, [ref]$ia)
[void]$N::GetConsoleMode($out, [ref]$oa)
[void]$N::CloseHandle($in); [void]$N::CloseHandle($out)
"WITTY-MODES $ib $ob $ia $oa"
`

/**
 * Changes the attached console's input/output modes from a powershell.exe
 * helper (no native addon needed) and reports them. Rejects if PowerShell
 * is unavailable or fails.
 */
export function setConsoleModes(options: SetConsoleModesOptions = {}): Promise<ConsoleModes> {
  const inSet = options.inputSet ?? 0
  const inClear = options.inputClear ?? 0
  const outSet = options.outputSet ?? 0
  const command = `& { ${HELPER_SCRIPT} } ${inSet} ${inClear} ${outSet} ${process.pid}`
  const encoded = Buffer.from(command, 'utf16le').toString('base64')
  const exe = powershellPath()
  if (!existsSync(exe)) return Promise.reject(new Error(`${exe} not found`))
  return new Promise((resolve, reject) => {
    const child = spawn(
      exe,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (s: string) => (stdout += s))
    child.stderr.setEncoding('utf8').on('data', (s: string) => (stderr += s))
    const timeoutMs = options.timeoutMs ?? helperTimeoutMs()
    const started = Date.now()
    let settled = false
    const fail = (message: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(message))
    }
    const timer = setTimeout(() => {
      child.kill()
      fail(
        `console mode helper timed out after ${timeoutMs} ms; stderr: ${oneLine(stderr) || '(none)'}; stdout: ${oneLine(stdout) || '(none)'}`,
      )
    }, timeoutMs)
    child.on('error', (error) => fail(`console mode helper could not start: ${error.message}`))
    child.on('close', (code) => {
      if (settled) return
      const m = /WITTY-MODES (\d+) (\d+) (\d+) (\d+)/.exec(stdout)
      if (code !== 0 || m === null) {
        fail(
          `console mode helper failed (exit ${code}, ${Date.now() - started} ms); stderr: ${oneLine(stderr) || '(none)'}; stdout: ${oneLine(stdout) || '(none)'}`,
        )
        return
      }
      settled = true
      clearTimeout(timer)
      resolve({
        inputBefore: Number(m[1]),
        outputBefore: Number(m[2]),
        inputAfter: Number(m[3]),
        outputAfter: Number(m[4]),
      })
    })
  })
}

/**
 * Whether this Node's `setRawMode(true)` already puts the console input in
 * VT mode (libuv RAW_VT). Verified on Node 24.20; older lines are assumed
 * not to and get the helper.
 */
export function rawModeIsVt(nodeVersion: string = process.versions.node): boolean {
  const major = Number(nodeVersion.split('.')[0])
  return Number.isFinite(major) && major >= 24
}

/** `auto`: run the helper only when raw mode is not known to be VT; `always`/`never` force it. */
export type VtInputPolicy = 'auto' | 'always' | 'never'

/**
 * Makes sure the console input delivers VT sequences. Call AFTER
 * `setRawMode(true)` (raw mode rewrites the mode). Never throws: the result
 * is a line for the log, since the host still works without mouse input.
 */
export async function ensureVtInput(policy: VtInputPolicy = 'auto'): Promise<string> {
  if (process.platform !== 'win32') return 'vt input: not Windows, nothing to do'
  if (policy === 'never' || (policy === 'auto' && rawModeIsVt())) {
    return `vt input: raw mode on Node ${process.versions.node} is RAW_VT, no helper run`
  }
  try {
    const exe = powershellPath()
    if (!existsSync(exe)) return `vt input: helper skipped, ${exe} not found`
    const modes = await setConsoleModes({
      inputSet: ENABLE_VIRTUAL_TERMINAL_INPUT,
      outputSet: ENABLE_VIRTUAL_TERMINAL_PROCESSING,
    })
    return (
      `vt input: helper set modes in 0x${modes.inputBefore.toString(16)} -> 0x${modes.inputAfter.toString(16)}, ` +
      `out 0x${modes.outputBefore.toString(16)} -> 0x${modes.outputAfter.toString(16)}`
    )
  } catch (error) {
    // Non-fatal: witty runs on without VT input (mouse reports may be lost). The message carries the helper's stderr.
    return `vt input: helper failed, continuing without it: ${error instanceof Error ? error.message : String(error)}`
  }
}

/** The stdin `setRawMode` lives on (a tty.ReadStream). */
type RawCapable = { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown }

/** Puts stdin into raw mode. Returns false if stdin is not a TTY. */
export function enterRawMode(stdin: RawCapable = process.stdin): boolean {
  if (stdin.isTTY !== true || typeof stdin.setRawMode !== 'function') return false
  stdin.setRawMode(true)
  return true
}

/** Leaves raw mode (restoring the console modes libuv saved); safe to call twice or on a non-TTY. */
export function leaveRawMode(stdin: RawCapable = process.stdin): void {
  if (stdin.isTTY !== true || typeof stdin.setRawMode !== 'function') return
  try {
    stdin.setRawMode(false)
  } catch {
    // The console is already gone.
  }
}
