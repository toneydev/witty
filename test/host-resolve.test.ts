// Command resolution: PATH/PATHEXT search and batch files through cmd.exe.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { escapeBatchArgument, findExecutable, getEnv, isLaunchable, quoteWindowsArgument, resolveCommand } from '../src/host/resolve.ts'

const dir = mkdtempSync(path.join(os.tmpdir(), 'witty resolve '))
const bin1 = path.join(dir, 'bin1')
const bin2 = path.join(dir, 'bin 2')
mkdirSync(bin1)
mkdirSync(bin2)
writeFileSync(path.join(bin1, 'tool'), '') // an extensionless shim (npm writes one next to each .cmd): never a hit
writeFileSync(path.join(bin2, 'tool.cmd'), '@echo off\r\n')
writeFileSync(path.join(bin2, 'other.exe'), '')
writeFileSync(path.join(bin1, 'other.exe'), '')
writeFileSync(path.join(bin2, 'script.ps1'), '')
writeFileSync(path.join(bin1, 'jsonly.js'), '') // PATHEXT lists .JS, but CreateProcess cannot run it
writeFileSync(path.join(bin2, 'jsonly.exe'), '')
writeFileSync(path.join(bin2, 'python3.12.exe'), '')
after(() => rmSync(dir, { recursive: true, force: true }))

const env = { Path: `${bin1};"${bin2}"`, PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe' }

/** Runs a resolved command the way node-pty does: the args string goes to CreateProcess verbatim. */
function run(r: { file: string; args: string[] | string }) {
  assert.equal(typeof r.args, 'string')
  return spawnSync(r.file, [r.args as string], { windowsVerbatimArguments: true, windowsHide: true, encoding: 'utf8' })
}

// Arguments that broke out of (or were mangled by) the old single `^`-escaping.
const NASTY = [
  '5" screen & echo INJECTED',
  '"',
  '""',
  '"""',
  'a"b"c',
  '"&echo INJECTED&"',
  '\\"&echo INJECTED',
  '\\\\"&echo INJECTED&\\\\"',
  '&|<>^!()',
  'a^&b',
  '^',
  '^^"^',
  '%PATH%',
  '%cd%',
  '%',
  '%%',
  '100%',
  '%~1',
  '%*',
  '%0',
  '%cd:~,%',
  '%PATH:~0,3%',
  '!PATH!',
  '!',
  'trailing\\',
  'trailing\\\\',
  'C:\\Program Files\\x\\',
  'with space',
  '',
  ' ',
  '\tTab',
  ',;=',
  'a,b;c=d',
  '--flag=value',
  '/?',
  '-p',
  '$(whoami) `id`',
  'héllo wörld 日本語 🎉',
  '＂＆fullwidth',
  'esc\x1b[31m',
  'ctrl-z\x1a',
  'plain',
]

describe('resolve', () => {
  it('reads environment variables case-insensitively', () => {
    assert.equal(getEnv({ Path: 'x' }, 'PATH'), 'x')
    assert.equal(getEnv({ PATH: 'y' }, 'Path'), 'y')
    assert.equal(getEnv({}, 'PATH'), undefined)
  })

  it('searches PATH in order, taking only files witty can start', () => {
    assert.equal(findExecutable('other', { env }), path.join(bin1, 'other.exe'))
    // bin1 has only an extensionless `tool`, which CreateProcess cannot run: bin2's tool.cmd is found.
    assert.equal(findExecutable('tool', { env }), path.join(bin2, 'tool.cmd'))
    assert.equal(findExecutable('tool', { env: { ...env, Path: `"${bin2}";${bin1}` } }), path.join(bin2, 'tool.cmd'))
    // PATHEXT's .JS (or .VBS, .MSC ...) in an earlier directory does not shadow a program further on.
    const withJs = { ...env, PATHEXT: '.JS;.COM;.EXE;.VBS;.BAT;.CMD' }
    assert.equal(findExecutable('jsonly', { env: withJs }), path.join(bin2, 'jsonly.exe'))
  })

  it('appends extensions to dotted names, as cmd and PowerShell do', () => {
    assert.equal(findExecutable('python3.12', { env }), path.join(bin2, 'python3.12.exe'))
    assert.equal(findExecutable('python3.12.exe', { env }), path.join(bin2, 'python3.12.exe'))
  })

  it('knows which files it can start', () => {
    for (const yes of ['a.exe', 'A.EXE', 'b.com', 'c.cmd', 'd.Bat', 'C:\\x y\\claude.exe']) assert.equal(isLaunchable(yes), true, yes)
    for (const no of ['a', 'a.js', 'a.ps1', 'a.exe.txt', 'python3.12', 'a.vbs', 'a.msc']) assert.equal(isLaunchable(no), false, no)
  })

  it('skips relative PATH entries, which would search the current directory', () => {
    const checked: string[] = []
    const isFile = (file: string): boolean => {
      checked.push(file)
      return path.win32.basename(file).toLowerCase() === 'other.exe'
    }
    const found = findExecutable('other', { env: { ...env, Path: `.;bin;..\\up;C:drive-relative;"";${bin1}` }, isFile })
    assert.equal(found, path.join(bin1, 'other.exe'))
    assert.ok(checked.every((file) => path.win32.isAbsolute(file)), checked.join(' | '))
  })

  it('takes a launchable name as is, and says so when a name is there but is no program', () => {
    assert.equal(findExecutable('tool.exe', { env }), undefined)
    assert.equal(findExecutable('script.ps1', { env }), undefined)
    assert.throws(
      () => resolveCommand('script.ps1', [], { env }),
      (e: Error) => e.message === `witty: cannot start ${path.join(bin2, 'script.ps1')}: only .exe, .com, .cmd and .bat files can be run`,
    )
    assert.throws(() => resolveCommand(path.join(bin1, 'tool'), [], { env }), /witty: cannot start .*bin1\\tool: only \.exe/)
    assert.throws(() => resolveCommand('nothing.ps1', [], { env }), /witty: command not found: nothing\.ps1/)
  })

  it('resolves absolute and relative paths against cwd, trying PATHEXT when the name has no launchable extension', () => {
    assert.equal(findExecutable(path.join(bin2, 'tool'), { env }), path.join(bin2, 'tool.cmd'))
    assert.equal(findExecutable(path.join(bin1, 'tool'), { env }), undefined, 'the extensionless file itself is no program')
    assert.equal(findExecutable('.\\bin 2\\other', { env, cwd: dir }), path.join(bin2, 'other.exe'))
    assert.equal(findExecutable('bin1/other.exe', { env, cwd: dir }), path.join(bin1, 'other.exe'))
    assert.equal(findExecutable('.\\bin 2\\python3.12', { env, cwd: dir }), path.join(bin2, 'python3.12.exe'))
    assert.equal(findExecutable('.\\nope', { env, cwd: dir }), undefined)
  })

  it('finds cmd and node on the real PATH', () => {
    assert.match(findExecutable('cmd') ?? '', /\\cmd\.exe$/i)
    assert.match(findExecutable('node') ?? '', /\\node\.exe$/i)
  })

  it('finds claude.exe in ~/.local/bin when it is installed there', (t) => {
    const expected = path.join(os.homedir(), '.local', 'bin', 'claude.exe')
    if (!existsSync(expected)) return t.skip('claude.exe is not installed in ~/.local/bin')
    assert.equal(findExecutable('claude')?.toLowerCase(), expected.toLowerCase())
  })

  it('starts programs directly, with the command line quoted per the MSVC rules', () => {
    const r = resolveCommand('other', ['a b', 'c'], { env })
    assert.deepEqual(r, { file: path.join(bin1, 'other.exe'), args: '"a b" c', resolved: path.join(bin1, 'other.exe') })
    // Not '': node-pty would take that as the whole command line and leave the path unquoted.
    assert.deepEqual(resolveCommand('other', [], { env }).args, [])
    assert.throws(() => resolveCommand('other', ['a\0b'], { env }), /cannot pass an argument with a NUL/)
  })

  it('quotes program arguments so CommandLineToArgvW gives them back', () => {
    assert.equal(quoteWindowsArgument('plain'), 'plain')
    assert.equal(quoteWindowsArgument('C:\\dir\\'), 'C:\\dir\\', 'no quotes, so trailing backslashes stay single')
    assert.equal(quoteWindowsArgument(''), '""')
    assert.equal(quoteWindowsArgument(' '), '" "')
    assert.equal(quoteWindowsArgument('\t'), '"\t"')
    assert.equal(quoteWindowsArgument('"a b"'), '"\\"a b\\""')
    assert.equal(quoteWindowsArgument('a"b'), '"a\\"b"')
    assert.equal(quoteWindowsArgument('a\\"b'), '"a\\\\\\"b"')
    assert.equal(quoteWindowsArgument('C:\\Program Files\\x\\'), '"C:\\Program Files\\x\\\\"')
    assert.equal(quoteWindowsArgument('a b\\\\'), '"a b\\\\\\\\"')
    assert.equal(quoteWindowsArgument('a\\b c'), '"a\\b c"', 'backslashes not before a quote stay single')
  })

  it('passes every argument intact to a real program (node.exe)', () => {
    // node-pty hands `<quoted file> <args>` to CreateProcess; spawnSync's verbatim mode does the same.
    const script = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))'
    const args = [...NASTY, '"a b"', ' ', '\t', 'x\\', 'x\\\\', 'a b\\', '\\"', '\\\\"x', '"', '\\']
    const r = resolveCommand(process.execPath, ['-e', script, ...args], { env: process.env })
    const out = spawnSync(r.file, [r.args], {
      argv0: `"${r.file}"`,
      windowsVerbatimArguments: true,
      windowsHide: true,
      encoding: 'utf8',
    })
    assert.equal(out.stderr, '')
    assert.deepEqual(JSON.parse(out.stdout), args)
  })

  it('runs batch files through cmd.exe with extensions on, delayed expansion off and escaped arguments', () => {
    const r = resolveCommand('tool', ['x', 'a&b'], { env: { ...env, Path: `"${bin2}"` } })
    assert.equal(r.file, 'C:\\Windows\\system32\\cmd.exe')
    assert.equal(r.resolved, path.join(bin2, 'tool.cmd'))
    assert.equal(r.args, `/d /e:on /v:off /s /c ""${r.resolved}" x "a&b""`)
  })

  it('runs cmd.exe from the Windows directory, never a bare name, when ComSpec is unset', () => {
    const noComSpec = { Path: `"${bin2}"`, PATHEXT: env.PATHEXT }
    assert.equal(resolveCommand('tool', [], { env: noComSpec }).file, 'C:\\Windows\\System32\\cmd.exe')
    assert.equal(resolveCommand('tool', [], { env: { ...noComSpec, SystemRoot: 'D:\\Win' } }).file, 'D:\\Win\\System32\\cmd.exe')
    assert.equal(resolveCommand('tool', [], { env: { ...noComSpec, windir: 'E:\\W' } }).file, 'E:\\W\\System32\\cmd.exe')
    assert.equal(resolveCommand('tool', [], { env: { ...noComSpec, ComSpec: '' } }).file, 'C:\\Windows\\System32\\cmd.exe')
  })

  it('quotes batch arguments with doubled quotes and neutralized percents', () => {
    assert.equal(escapeBatchArgument('plain-1.0/x:y@z\\'), 'plain-1.0/x:y@z\\')
    assert.equal(escapeBatchArgument(''), '""')
    assert.equal(escapeBatchArgument('a b'), '"a b"')
    assert.equal(escapeBatchArgument('5" x & y'), '"5"" x & y"')
    assert.equal(escapeBatchArgument('a\\"b\\'), '"a\\\\""b\\\\"')
    assert.equal(escapeBatchArgument('a\\b c'), '"a\\b c"')
    assert.equal(escapeBatchArgument('100%'), '"100%%cd:~,%"')
    assert.equal(escapeBatchArgument('é'), '"é"')
  })

  it('refuses batch arguments with CR, LF or NUL', () => {
    for (const bad of ['a\rb', 'a\nb', 'a\r\nb', 'a\0b']) {
      assert.throws(() => escapeBatchArgument(bad), /witty: cannot pass an argument with a line break or NUL/)
      assert.throws(() => resolveCommand('tool', ['ok', bad], { env: { ...env, Path: `"${bin2}"` } }), /line break or NUL/)
    }
  })

  it('throws for an unknown command', () => {
    assert.throws(() => resolveCommand('no-such-program-witty', [], { env }), /command not found/)
  })

  describe('batch files on the real cmd.exe', { skip: process.platform !== 'win32' && 'needs cmd.exe' }, () => {
    // An argv printer, reached through the shim shapes in use: npm's cmd-shim
    // (as for claude.cmd) and a plain `node script %*`, from a directory whose
    // name holds cmd metacharacters itself.
    const odd = path.join(dir, 'odd & 50% (dir) ^!')
    mkdirSync(odd)
    writeFileSync(path.join(odd, 'argv.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n')
    const cmdShim = path.join(bin2, 'cmd-shim.cmd')
    const argvJs = path.join(bin2, 'argv.js')
    writeFileSync(argvJs, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n')
    writeFileSync(
      cmdShim,
      [
        '@ECHO off',
        'GOTO start',
        ':find_dp0',
        'SET dp0=%~dp0',
        'EXIT /b',
        ':start',
        'SETLOCAL',
        'CALL :find_dp0',
        '',
        'IF EXIST "%dp0%\\node.exe" (',
        '  SET "_prog=%dp0%\\node.exe"',
        ') ELSE (',
        '  SET "_prog=node"',
        '  SET PATHEXT=%PATHEXT:;.JS;=;%',
        ')',
        '',
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\argv.js" %*',
        '',
      ].join('\r\n'),
    )
    const plainShim = path.join(odd, 'plain shim.bat')
    writeFileSync(plainShim, '@echo off\r\nnode "%~dp0argv.js" %*\r\n')

    // Raw stdout is compared, so an injected `echo INJECTED` shows up in the diff.
    for (const shim of [cmdShim, plainShim]) {
      it(`passes nasty arguments through ${path.basename(shim)} intact, injecting nothing`, () => {
        const r = run(resolveCommand(shim, NASTY))
        assert.equal(r.stderr, '')
        assert.equal(r.stdout, JSON.stringify(NASTY))
      })
    }

    it('passes each nasty argument alone through the cmd-shim', () => {
      for (const arg of NASTY) {
        const r = run(resolveCommand(cmdShim, ['-p', arg]))
        assert.equal(r.stderr, '', JSON.stringify(arg))
        assert.equal(r.stdout, JSON.stringify(['-p', arg]), JSON.stringify(arg))
      }
    })

    it('keeps percents literal when the environment defines CD', () => {
      const r = resolveCommand(cmdShim, ['%PATH%', '50%'])
      const out = spawnSync(r.file, [r.args as string], {
        windowsVerbatimArguments: true,
        windowsHide: true,
        encoding: 'utf8',
        env: { ...process.env, CD: 'C:\\planted' },
      })
      assert.equal(out.stdout, JSON.stringify(['%PATH%', '50%']))
    })
  })
})
