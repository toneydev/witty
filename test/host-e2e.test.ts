// End to end: `node src/cli.ts` with the stub wire, hosting the fake child,
// inside an outer bundled ConPTY that plays Windows Terminal.
//
// The tests run concurrently: each has its own outer pty (its own ConPTY,
// so its own console), its own witty and child processes and its own log
// file (numbered by `startWitty`); the shared temp directory only holds
// those per-run files and is removed after all of them. Nothing here blocks
// the event loop (no spawnSync), so the harnesses keep reading their ptys
// while another test waits.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { STUB_DCS } from './fixtures/stub-wire.ts'
import { hex, inputLines, startOuter, withTimeout, type Outer, type OuterOptions } from './fixtures/harness.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const cli = path.join(root, 'src', 'cli.ts')
const stubWire = path.join(root, 'test', 'fixtures', 'stub-wire.ts')
const fakeChild = path.join(root, 'test', 'fixtures', 'fake-child.ts')
const exitChild = path.join(root, 'test', 'fixtures', 'exit-child.ts')
const hooksWire = path.join(root, 'test', 'fixtures', 'hooks-wire.ts')
const tmp = mkdtempSync(path.join(os.tmpdir(), 'witty-e2e-'))

const outers: Outer[] = []
after(() => {
  for (const o of outers) o.dispose()
  rmSync(tmp, { recursive: true, force: true })
})

let runs = 0
/** Starts witty hosting the fake child (exit code 42) inside an outer pty. */
function startWitty(options: OuterOptions = {}, extra: string[] = []) {
  return startWittyWith(['--wire', stubWire, ...extra, '--', process.execPath, fakeChild, '42'], options)
}

/** Starts witty (logging, cell 8x16) with these further arguments inside an outer pty. */
function startWittyWith(rest: string[], options: OuterOptions = {}) {
  const log = path.join(tmp, `witty-${++runs}.log`)
  const args = [cli, '--cell', '8x16', '--log', log, ...rest]
  const outer = startOuter(process.execPath, args, { cwd: root, ...options })
  outers.push(outer)
  const readLog = () => {
    try {
      return readFileSync(log, 'utf8')
    } catch {
      return ''
    }
  }
  return { outer, readLog }
}

const childInput = (outer: Outer) => inputLines(outer.output()).join('')

/** Polls until the child has reported reading `bytes`. */
async function waitForInput(outer: Outer, bytes: string, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!childInput(outer).includes(hex(bytes))) {
    if (Date.now() > deadline) {
      throw new Error(`child never read ${JSON.stringify(bytes)}; it read ${childInput(outer)}; output ${JSON.stringify(outer.output())}`)
    }
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** Runs `node <args>` without a terminal, asynchronously; resolves with its exit status and output. */
function runNode(args: string[], timeoutMs = 15000): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (s: string) => (stdout += s))
    child.stderr.setEncoding('utf8').on('data', (s: string) => (stderr += s))
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`node ${args.join(' ')} timed out; stdout ${JSON.stringify(stdout)} stderr ${JSON.stringify(stderr)}`))
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (status) => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
  })
}

describe('witty end to end', { concurrency: true }, () => {
  it('translates the APC in place, answers the child, forwards input and resizes, exits with the child code', async () => {
    const { outer, readLog } = startWitty({ cellSize: { width: 9, height: 17 } })
    await outer.waitFor('READY', 30000)

    // Text in order, the APC removed and the emitter's DCS exactly where it was.
    assert.ok(outer.output().includes(`BEFORE<${STUB_DCS}>AFTER`), JSON.stringify(outer.output()))
    assert.ok(!outer.output().includes('\x1b_G'), 'the kitty APC leaked to the outer terminal')

    // The engine's OK response reached the child's stdin.
    await waitForInput(outer, '\x1b_Gi=7;OK\x1b\\')

    // Mouse and kitty-keyboard bytes from the outer terminal reach the child verbatim.
    outer.write('\x1b[<0;5;6M')
    await waitForInput(outer, '\x1b[<0;5;6M')
    outer.write('\x1b[97;5u')
    await waitForInput(outer, '\x1b[97;5u')

    // Resizing the outer terminal resizes the child's pty.
    const before = outer.output().length
    outer.resize(100, 30)
    await outer.waitFor('COLS:100', 10000, before)

    outer.write('QUIT')
    assert.equal(await withTimeout(outer.exited, 15000, 'witty exit'), 42)

    const log = readLog()
    assert.match(log, /cell size 9\.000x17\.000 \(terminal reply\)/)
    assert.match(log, /apc a=T,f=100,i=7 \(payload 4 bytes\)/)
    assert.match(log, /resize 100x30/)
    assert.match(log, /child exited with 42/)
  })

  it('falls back to --cell when the terminal is silent, and forwards input typed meanwhile', async () => {
    const { outer, readLog } = startWitty()
    await outer.waitFor('\x1b[16t', 30000)
    outer.write('EARLY')
    await outer.waitFor('READY', 30000)
    await waitForInput(outer, 'EARLY')
    outer.write('QUIT')
    assert.equal(await withTimeout(outer.exited, 15000, 'witty exit'), 42)
    assert.match(readLog(), /cell size 8\.000x16\.000 \(fallback\), 5 leftover input bytes/)
  })

  it('consumes a late-split cell reply and keeps the bytes around it', async () => {
    const { outer, readLog } = startWitty()
    await outer.waitFor('\x1b[16t', 30000)
    outer.write('ab\x1b[6;18;')
    await new Promise((r) => setTimeout(r, 30))
    outer.write('11tcd')
    await outer.waitFor('READY', 30000)
    await waitForInput(outer, 'cd')
    outer.write('QUIT')
    assert.equal(await withTimeout(outer.exited, 15000, 'witty exit'), 42)
    assert.match(readLog(), /cell size 11\.000x18\.000 \(terminal reply\), 4 leftover input bytes/)
    assert.ok(!childInput(outer).includes(hex('\x1b[6;18;11t')), 'the reply reached the child')
  })

  it('derives a fractional cell from CSI 14 t / 18 t and prefers it over CSI 16 t', async () => {
    // xterm.js-like: 1481 px over 158 columns is 9.373 px per cell; its 16 t reply is rounded.
    const { outer, readLog } = startWitty({
      cols: 158,
      rows: 38,
      textArea: { width: 1481, height: 760 },
      textCells: { columns: 158, rows: 38 },
      cellSize: { width: 9, height: 20 },
    })
    await outer.waitFor('READY', 30000)
    outer.write('QUIT')
    assert.equal(await withTimeout(outer.exited, 15000, 'witty exit'), 42)
    const log = readLog()
    assert.match(log, /reply text area 1481x760 px \(CSI 14 t\)/)
    assert.match(log, /reply text area 158x38 cells \(CSI 18 t\)/)
    assert.match(log, /reply cell 9x20 px \(CSI 16 t\)/)
    assert.match(log, /cell size 9\.373x20\.000 \(text area\), 0 leftover input bytes/)
    for (const reply of ['\x1b[4;760;1481t', '\x1b[8;38;158t', '\x1b[6;20;9t']) {
      assert.ok(!childInput(outer).includes(hex(reply)), `${JSON.stringify(reply)} reached the child`)
    }
  })

  it('asks the terminal for its cursor position so the child console starts there, unless --no-inherit-cursor', async () => {
    const { outer, readLog } = startWitty()
    await outer.waitFor('READY', 30000)
    assert.ok(outer.output().includes('\x1b[6n'), `no CSI 6 n in ${JSON.stringify(outer.output())}`)
    outer.write('QUIT')
    assert.equal(await withTimeout(outer.exited, 15000, 'witty exit'), 42)
    // The harness answered CSI 1;1 R; the ConPTY consumed it, the child never saw it.
    assert.ok(!childInput(outer).includes(hex('\x1b[1;1R')), 'the cursor report reached the child')
    assert.match(readLog(), /inherit cursor true/)

    const off = startWitty({}, ['--no-inherit-cursor'])
    await off.outer.waitFor('READY', 30000)
    assert.ok(!off.outer.output().includes('\x1b[6n'), `CSI 6 n in ${JSON.stringify(off.outer.output())}`)
    off.outer.write('QUIT')
    assert.equal(await withTimeout(off.outer.exited, 15000, 'witty exit'), 42)
    assert.match(off.readLog(), /inherit cursor false/)
  })

  it('divides the text area by the console size when CSI 18 t is not answered', async () => {
    const { outer, readLog } = startWitty({ cols: 158, rows: 38, textArea: { width: 1481, height: 760 } })
    await outer.waitFor('READY', 30000)
    outer.write('QUIT')
    assert.equal(await withTimeout(outer.exited, 15000, 'witty exit'), 42)
    assert.match(readLog(), /cell size 9\.373x20\.000 \(text area\)/)
  })

  it('keeps the child exit code when input arrives after the child has exited', async () => {
    // The hooks wire holds the child's last kitty command for 2 s, and with it
    // node-pty's 'exit' (witty stops reading output meanwhile). The child is
    // long gone by then, so the keys typed meanwhile, and the command's OK
    // response, land on a closed input pipe: that used to crash witty with
    // `write EAGAIN` and exit 1.
    const { outer, readLog } = startWittyWith(['--wire', hooksWire, '--', process.execPath, exitChild, '42', 'slow=2000'], {
      cellSize: { width: 8, height: 16 },
    })
    await outer.waitFor('READY', 30000)
    outer.write('QUIT')
    let done = false
    void outer.exited.then(() => (done = true))
    for (let i = 0; i < 36 && !done; i++) {
      await new Promise((r) => setTimeout(r, 50))
      outer.write('x')
    }
    assert.equal(await withTimeout(outer.exited, 15000, 'witty exit'), 42)
    assert.ok(outer.output().includes('BYE'), 'the output after the held command was lost')
    const log = readLog()
    assert.doesNotMatch(log, /fatal/)
    assert.match(log, /child exited with 42/)
  })

  it('says why when the program cannot be started', async () => {
    const bad = path.join(tmp, 'not a program.exe')
    writeFileSync(bad, 'not a program')
    const { outer, readLog } = startWittyWith(['--wire', stubWire, '--', bad], { cellSize: { width: 8, height: 16 } })
    // CreateProcess's error (216, ERROR_EXE_MACHINE_TYPE_MISMATCH, for text in a .exe) is the exit code.
    const code = await withTimeout(outer.exited, 30000, 'witty exit')
    assert.notEqual(code, 0)
    assert.ok(outer.output().includes(`witty: could not start ${bad} (error ${code})`), JSON.stringify(outer.output()))
    assert.match(readLog(), /could not start/)
  })

  it('takes answers to its own queries that miss the window out of the input, and forwards later ones', async () => {
    // A slow terminal: nothing within the window, then all three answers at once.
    const { outer, readLog } = startWitty({ cols: 158, rows: 38 })
    await outer.waitFor('READY', 30000)
    outer.write('\x1b[4;760;1481t\x1b[8;38;158t\x1b[6;20;9tlate')
    await waitForInput(outer, 'late')
    // A second answer is someone else's (the child asked): it passes.
    outer.write('\x1b[6;20;9tnext')
    await waitForInput(outer, 'next')
    outer.write('QUIT')
    assert.equal(await withTimeout(outer.exited, 15000, 'witty exit'), 42)
    assert.ok(!childInput(outer).includes(hex('\x1b[4;760;1481t')), 'a late answer reached the child')
    assert.ok(!childInput(outer).includes(hex('\x1b[8;38;158t')), 'a late answer reached the child')
    assert.equal(childInput(outer).split(hex('\x1b[6;20;9t')).length - 1, 1, 'exactly the second CSI 6 t reaches the child')
    const log = readLog()
    assert.match(log, /cell size 8\.000x16\.000 \(fallback\)/)
    assert.match(log, /reply cell 9x20 px \(CSI 16 t\) \(late answer to witty, consumed\)/)
    assert.match(log, /cell size 9\.373x20\.000 \(text area, seen on input\)/)
  })

  it('on Ctrl+Break kills the child and leaves the normal way, with its exit code', async () => {
    const { outer, readLog } = startWitty({ cellSize: { width: 8, height: 16 } })
    await outer.waitFor('READY', 30000)
    // Ctrl+Break as Windows Terminal sends it (win32-input-mode): VK_CANCEL, key down, left Ctrl.
    // It raises CTRL_BREAK_EVENT whatever the input mode; Node's default ended witty on the spot.
    outer.write('\x1b[3;70;0;1;8;1_')
    const code = await withTimeout(outer.exited, 15000, 'witty exit')
    const log = readLog()
    assert.match(log, /SIGBREAK, killing the child/)
    const child = /child exited with (-?\d+)/.exec(log)
    if (child !== null) assert.equal(code, Number(child[1]))
    else assert.equal(code, 128 + 21, 'neither the child exit nor the SIGBREAK fallback')
  })

  it('resets the terminal modes and reports the error when witty itself crashes', async () => {
    const { outer, readLog } = startWittyWith(['--wire', hooksWire, '--', process.execPath, exitChild, '0', 'crash=1', 'stay'], {
      cellSize: { width: 8, height: 16 },
    })
    await outer.waitFor('READY', 30000)
    outer.write('QUIT')
    assert.equal(await withTimeout(outer.exited, 15000, 'witty exit'), 1)
    const out = outer.output()
    assert.ok(out.includes('\x1b7\x1b[?1049l\x1b[?25h'), `no terminal reset in ${JSON.stringify(out.slice(-300))}`)
    assert.ok(out.includes('witty: boom from the hooks wire'), JSON.stringify(out.slice(-300)))
    assert.match(readLog(), /fatal: Error: boom from the hooks wire/)
  })

  it('exits 127 when the command does not exist', async () => {
    const outer = startOuter(process.execPath, [cli, '--', 'no-such-program-witty'], { cwd: root })
    outers.push(outer)
    assert.equal(await withTimeout(outer.exited, 15000, 'witty exit'), 127)
    assert.match(outer.output(), /command not found: no-such-program-witty/)
  })

  it('refuses to run without a terminal', async () => {
    const r = await runNode([cli, '--', 'cmd'])
    assert.equal(r.status, 2)
    assert.match(r.stderr, /must be a terminal/)
  })

  it('prints help and version', async () => {
    const [help, version] = await Promise.all([runNode([cli, '--help']), runNode([cli, '--version'])])
    assert.equal(help.status, 0)
    assert.match(help.stdout, /Usage: witty/)
    assert.equal(version.status, 0)
    assert.match(version.stdout, /^witty \d+\.\d+\.\d+/)
  })
})
