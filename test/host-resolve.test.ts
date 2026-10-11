// Command resolution: PATH/PATHEXT search and batch files through cmd.exe.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { escapeCmdArgument, findExecutable, getEnv, resolveCommand } from '../src/host/resolve.ts'

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

  it('runs batch files through cmd.exe /d /s /c with escaped arguments', () => {
    const r = resolveCommand('tool', ['x', 'a&b'], { env: { ...env, Path: `"${bin2}"` } })
    assert.equal(r.file, 'C:\\Windows\\system32\\cmd.exe')
    assert.equal(r.resolved, path.join(bin2, 'tool.cmd'))
    assert.equal(r.args, `/d /s /c "${escapeCmdArgument(r.resolved)} ^"x^" ^"a^&b^""`)
  })

  it('quotes per the MSVC rules before cmd-escaping', () => {
    assert.equal(escapeCmdArgument('a"b\\'), '^"a\\^"b\\\\^"')
    assert.equal(escapeCmdArgument(''), '^"^"')
  })

  it('throws for an unknown command', () => {
    assert.throws(() => resolveCommand('no-such-program-witty', [], { env }), /command not found/)
  })

  it('escapes cmd arguments so they round-trip through a real batch file', () => {
    const echo = path.join(bin2, 'echo args.cmd')
    // Prints each argument on its own line, still quoted (so echo is safe).
    writeFileSync(echo, '@echo off\r\n:loop\r\nif "%~1"=="" goto :eof\r\necho [%1]\r\nshift\r\ngoto loop\r\n')
    const args = ['plain', 'with space', 'a&b|c', '(paren)', '100%', 'semi;colon', 'caret^x']
    const r = resolveCommand(echo, args, { env })
    assert.equal(typeof r.args, 'string')
    const out = spawnSync(r.file, [r.args as string], { windowsVerbatimArguments: true, encoding: 'utf8' }).stdout
    assert.deepEqual(
      out.trim().split(/\r?\n/),
      args.map((a) => `["${a}"]`),
    )
  })
})
