// Command resolution: PATH/PATHEXT search and batch files through cmd.exe.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { escapeBatchArgument, findExecutable, getEnv, resolveCommand } from '../src/host/resolve.ts'

const dir = mkdtempSync(path.join(os.tmpdir(), 'witty resolve '))
const bin1 = path.join(dir, 'bin1')
const bin2 = path.join(dir, 'bin 2')
mkdirSync(bin1)
mkdirSync(bin2)
writeFileSync(path.join(bin1, 'tool'), '') // bare file, found only after PATHEXT candidates
writeFileSync(path.join(bin2, 'tool.cmd'), '@echo off\r\n')
writeFileSync(path.join(bin2, 'other.exe'), '')
writeFileSync(path.join(bin1, 'other.exe'), '')
writeFileSync(path.join(bin2, 'script.ps1'), '')
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

  it('searches PATH in order, extensions before the bare name in each directory', () => {
    assert.equal(findExecutable('other', { env }), path.join(bin1, 'other.exe'))
    // bin1 has only a bare `tool`; it still wins over bin2's tool.cmd, since directories come first.
    assert.equal(findExecutable('tool', { env }), path.join(bin1, 'tool'))
    assert.equal(findExecutable('tool', { env: { ...env, Path: `"${bin2}";${bin1}` } }), path.join(bin2, 'tool.cmd'))
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

  it('takes a name with an extension as is', () => {
    assert.equal(findExecutable('script.ps1', { env }), path.join(bin2, 'script.ps1'))
    assert.equal(findExecutable('tool.exe', { env }), undefined)
  })

  it('resolves absolute and relative paths against cwd, trying PATHEXT when extensionless', () => {
    assert.equal(findExecutable(path.join(bin2, 'tool'), { env }), path.join(bin2, 'tool.cmd'))
    assert.equal(findExecutable('.\\bin 2\\other', { env, cwd: dir }), path.join(bin2, 'other.exe'))
    assert.equal(findExecutable('bin1/other.exe', { env, cwd: dir }), path.join(bin1, 'other.exe'))
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

  it('starts executables directly with an argv array', () => {
    const r = resolveCommand('other', ['a b', 'c'], { env })
    assert.deepEqual(r, { file: path.join(bin1, 'other.exe'), args: ['a b', 'c'], resolved: path.join(bin1, 'other.exe') })
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
