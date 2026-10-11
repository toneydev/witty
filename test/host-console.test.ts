// What Node's raw mode delivers under ConPTY, and whether the console-mode
// helper can fix it when it does not. Runs test/fixtures/raw-probe.ts inside
// an outer bundled ConPTY and types mouse and kitty-keyboard sequences.

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { CONSOLE_HELPER_TIMEOUT_MS, helperTimeoutMs, powershellPath, rawModeIsVt } from '../src/host/console.ts'
import { hex, inputLines, startOuter, withTimeout, type Outer } from './fixtures/harness.ts'

const MOUSE = '\x1b[<0;5;6M'
const KITTY_KEY = '\x1b[97;5u'
const probe = fileURLToPath(new URL('./fixtures/raw-probe.ts', import.meta.url))

const outers: Outer[] = []
after(() => {
  for (const o of outers) o.dispose()
})

/** Each helper call in the probe may take this long (a cold CI runner is slow); the probe makes up to three. */
const HELPER_TIMEOUT_MS = 20000

/** Runs the probe in `phase`, types the sequences, returns the MODES line and the bytes it read. */
async function run(
  phase: string,
  helperTimeoutMs = HELPER_TIMEOUT_MS,
): Promise<{ modes: string; input: string; output: string; helperFailures: string[] }> {
  const outer = startOuter(process.execPath, [probe, phase], {
    env: { ...process.env, WITTY_CONSOLE_HELPER_TIMEOUT_MS: String(helperTimeoutMs) },
  })
  outers.push(outer)
  await outer.waitFor('READY', 3 * helperTimeoutMs + 15000)
  let seen = outer.output().length
  outer.write(MOUSE)
  // The mouse report may legitimately vanish (see 'clear'), so pace by time, not by echo.
  await new Promise((r) => setTimeout(r, 300))
  outer.write(KITTY_KEY)
  await outer.waitFor('IN:', 10000, seen)
  outer.write('QUIT')
  assert.equal(await withTimeout(outer.exited, 10000, 'probe exit'), 0)
  const output = outer.output()
  const modes = /MODES ([0-9a-f]+) ([0-9a-f]+)/.exec(output)
  const helperFailures = [...output.matchAll(/HELPER:failed ([^\r\n]*)/g)].map((m) => m[1]!)
  return { modes: modes?.[0] ?? '', input: inputLines(output).join(''), output, helperFailures }
}

/** Fails with the helper's own words (its stderr is in the message) if any helper call in the probe failed. */
function assertHelperOk(r: { helperFailures: string[]; output: string }): void {
  if (r.helperFailures.length > 0) {
    assert.fail(`the console mode helper failed in the probe:\n${r.helperFailures.join('\n')}\nprobe output: ${JSON.stringify(r.output)}`)
  }
}

describe('the PowerShell helper path', () => {
  it('is the system powershell.exe by absolute path, from SystemRoot', () => {
    assert.equal(
      powershellPath({ SystemRoot: 'D:\\Win' }),
      'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    )
    assert.equal(powershellPath({}), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    // Not a bare name: a powershell.exe on PATH or in the working directory is never used.
    assert.ok(path.win32.isAbsolute(powershellPath()))
    if (process.platform === 'win32') assert.ok(existsSync(powershellPath()), powershellPath())
  })

  it('times out after 30 s by default; WITTY_CONSOLE_HELPER_TIMEOUT_MS overrides it', () => {
    assert.equal(CONSOLE_HELPER_TIMEOUT_MS, 30000)
    assert.equal(helperTimeoutMs({}), 30000)
    assert.equal(helperTimeoutMs({ WITTY_CONSOLE_HELPER_TIMEOUT_MS: '2500' }), 2500)
    for (const bad of ['', '0', '-5', 'soon', '1e9', '12345678']) {
      assert.equal(helperTimeoutMs({ WITTY_CONSOLE_HELPER_TIMEOUT_MS: bad }), 30000, JSON.stringify(bad))
    }
  })
})

// Concurrent: each probe runs in its own outer pty, so it has its own ConPTY
// and console, and the PowerShell helper attaches to the probe's console (by
// the probe's pid), never to this test process's. No test changes the
// console mode of the process running the tests, so none needs to be serial.
describe('raw-mode VT input on this Node', { concurrency: true }, () => {
  it('reports raw mode as RAW_VT on Node >= 24', () => {
    assert.equal(rawModeIsVt('24.20.0'), true)
    assert.equal(rawModeIsVt('22.18.0'), false)
  })

  it('setRawMode(true) alone delivers SGR mouse and kitty keys byte for byte', async () => {
    const r = await run('raw')
    assertHelperOk(r)
    // 0x208 = ENABLE_VIRTUAL_TERMINAL_INPUT | ENABLE_WINDOW_INPUT; 0x7 includes VT processing.
    assert.match(r.modes, /^MODES 2[0-9a-f]{2} [0-9a-f]*[4-7]$/)
    assert.ok(r.input.includes(hex(MOUSE)), `mouse missing: ${r.input}`)
    assert.ok(r.input.includes(hex(KITTY_KEY)), `kitty key missing: ${r.input}`)
  })

  it('without VT input the mouse report is lost (why the helper exists)', async () => {
    const r = await run('clear')
    assertHelperOk(r)
    assert.equal(Number.parseInt(r.modes.split(' ')[1] ?? '0', 16) & 0x200, 0, r.modes)
    assert.ok(!r.input.includes(hex(MOUSE)), `mouse unexpectedly arrived: ${r.input}`)
  })

  it('a failing helper is not fatal: the probe reports it with the reason and keeps working', async () => {
    // 1 ms: every helper call times out (PowerShell cannot even start that fast).
    const r = await run('restore', 1)
    assert.deepEqual(
      r.helperFailures.map((f) => f.split(' ')[0]),
      ['clear', 'restore', 'modes'],
      r.output,
    )
    for (const f of r.helperFailures) assert.match(f, /timed out after 1 ms; stderr: /)
    assert.match(r.output, /HELPER vt input: helper failed, continuing without it: console mode helper timed out/)
    assert.match(r.output, /MODES unknown/)
    assert.ok(r.input.includes(hex(KITTY_KEY)), 'input still flows after the failures')
  })

  it('the PowerShell helper restores VT input, and prints nothing to the console', async () => {
    const r = await run('restore')
    assertHelperOk(r)
    assert.match(r.output, /HELPER vt input: helper set modes in 0x[0-9a-f]+ -> 0x2[0-9a-f]{2}/)
    assert.ok(!r.output.includes('\x1b]0;'), 'the helper leaked a title change')
    assert.ok(r.input.includes(hex(MOUSE)), `mouse missing: ${r.input}`)
    assert.ok(r.input.includes(hex(KITTY_KEY)), `kitty key missing: ${r.input}`)
  })
})
