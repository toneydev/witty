// The portable release's witty.cmd: runs the Node on PATH, never one planted in the current directory.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'
import { findExecutable, getEnv } from '../src/host/resolve.ts'

const source = fileURLToPath(new URL('../tools/portable/witty.cmd', import.meta.url))

describe('portable launcher', { skip: process.platform !== 'win32' && 'witty.cmd needs cmd.exe' }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'witty launcher '))
  after(() => rmSync(dir, { recursive: true, force: true }))

  // The release layout: witty.cmd next to dist\cli.js, here a stub that reports how it ran.
  const pkg = path.join(dir, 'witty pkg')
  mkdirSync(path.join(pkg, 'dist'), { recursive: true })
  const launcher = path.join(pkg, 'witty.cmd')
  writeFileSync(launcher, readFileSync(source, 'utf8').replace(/\r?\n/g, '\r\n'))
  writeFileSync(
    path.join(pkg, 'dist', 'cli.js'),
    [
      'const env = (name) => Object.keys(process.env).find((k) => k.toLowerCase() === name.toLowerCase()) ?? null',
      'const argv = process.argv.slice(2)',
      'process.stdout.write(JSON.stringify({ execPath: process.execPath, argv, leaked: [env("NoDefaultCurrentDirectoryInExePath"), env("WITTY_NODE")] }))',
      'process.exitCode = Number(argv[0])',
      '',
    ].join('\n'),
  )

  // Directories the user might stand in (a cloned repo) with programs planted. The
  // batch files log to `hijacked` when run, since the old launcher hid `where`'s
  // output; the node.exe is not a program at all, so running it fails loudly.
  const hijacked = path.join(dir, 'hijacked')
  const plant = (name: string, files: string[]) => {
    const cwd = path.join(dir, name)
    mkdirSync(cwd)
    for (const file of files) {
      const body = file.endsWith('.exe')
        ? 'not a program'
        : `@echo HIJACKED ${file} %*\r\n@echo ${file}>>"${hijacked}"\r\n@exit /b 66\r\n`
      writeFileSync(path.join(cwd, file), body)
    }
    return cwd
  }
  const planted = plant('batch repo', ['node.cmd', 'node.bat'])
  const cwds = [planted, plant('exe repo', ['node.exe']), plant('where repo', ['where.cmd', 'where.bat', 'node.cmd'])]

  // Claude Code's shell sets NoDefaultCurrentDirectoryInExePath, which hides the
  // current-directory search; an ordinary shell does not.
  const baseEnv: Record<string, string | undefined> = { ...process.env }
  for (const key of Object.keys(baseEnv)) {
    if (key.toLowerCase() === 'nodefaultcurrentdirectoryinexepath') delete baseEnv[key]
  }
  const comspec = getEnv(baseEnv, 'ComSpec') ?? 'C:\\Windows\\System32\\cmd.exe'

  /** Runs the launcher as PowerShell would: `cmd.exe /c` with the batch file and its arguments. */
  function launch(cwd: string, args: string, env = baseEnv) {
    rmSync(hijacked, { force: true })
    const r = spawnSync(comspec, [`/d /s /c ""${launcher}" ${args}"`], {
      cwd,
      env,
      windowsVerbatimArguments: true,
      windowsHide: true,
      encoding: 'utf8',
    })
    assert.equal(existsSync(hijacked) ? readFileSync(hijacked, 'utf8') : '', '', 'a planted program ran')
    assert.doesNotMatch(r.stdout + r.stderr, /HIJACKED|not a valid|not compatible/)
    return r
  }

  const realNode = findExecutable('node.exe', { env: baseEnv })

  for (const cwd of cwds) {
    it(`runs the node.exe on PATH, not one in the current directory (${path.basename(cwd)})`, () => {
      assert.ok(realNode, 'node.exe is on PATH')
      const r = launch(cwd, '7 "two words" plain --flag=x')
      const report = JSON.parse(r.stdout)
      assert.equal(report.execPath.toLowerCase(), realNode.toLowerCase())
      assert.deepEqual(report.argv, ['7', 'two words', 'plain', '--flag=x'])
      assert.equal(r.status, 7)
    })
  }

  it('starts node with the caller environment, leaking nothing of its own', () => {
    const r = launch(planted, '0')
    assert.deepEqual(JSON.parse(r.stdout).leaked, [null, null])
    assert.equal(r.status, 0)
  })

  it('exits 127 with a hint when PATH has no node.exe, running nothing from the current directory', () => {
    const system32 = path.dirname(comspec)
    for (const cwd of cwds) {
      const r = launch(cwd, '0', { ...baseEnv, PATH: system32, Path: undefined })
      assert.match(r.stderr, /witty: Node\.js 22\.18 or later is needed on PATH \(winget install OpenJS\.NodeJS\.LTS\)/)
      assert.equal(r.stdout, '')
      assert.equal(r.status, 127)
    }
  })
})
