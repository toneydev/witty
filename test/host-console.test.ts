// What Node's raw mode delivers under ConPTY, and whether the console-mode
// helper can fix it when it does not. Runs test/fixtures/raw-probe.ts inside
// an outer bundled ConPTY and types mouse and kitty-keyboard sequences.

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { rawModeIsVt } from '../src/host/console.ts'
import { hex, inputLines, startOuter, withTimeout, type Outer } from './fixtures/harness.ts'

const MOUSE = '\x1b[<0;5;6M'
const KITTY_KEY = '\x1b[97;5u'
const probe = fileURLToPath(new URL('./fixtures/raw-probe.ts', import.meta.url))

const outers: Outer[] = []
after(() => {
  for (const o of outers) o.dispose()
})

/** Runs the probe in `phase`, types the sequences, returns the MODES line and the bytes it read. */
async function run(phase: string): Promise<{ modes: string; input: string; output: string }> {
  const outer = startOuter(process.execPath, [probe, phase])
  outers.push(outer)
  await outer.waitFor('READY', 30000)
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
  return { modes: modes?.[0] ?? '', input: inputLines(output).join(''), output }
}

describe('raw-mode VT input on this Node', () => {
  it('reports raw mode as RAW_VT on Node >= 24', () => {
    assert.equal(rawModeIsVt('24.20.0'), true)
    assert.equal(rawModeIsVt('22.18.0'), false)
  })

  it('setRawMode(true) alone delivers SGR mouse and kitty keys byte for byte', async () => {
    const r = await run('raw')
    // 0x208 = ENABLE_VIRTUAL_TERMINAL_INPUT | ENABLE_WINDOW_INPUT; 0x7 includes VT processing.
    assert.match(r.modes, /^MODES 2[0-9a-f]{2} [0-9a-f]*[4-7]$/)
    assert.ok(r.input.includes(hex(MOUSE)), `mouse missing: ${r.input}`)
    assert.ok(r.input.includes(hex(KITTY_KEY)), `kitty key missing: ${r.input}`)
  })

  it('without VT input the mouse report is lost (why the helper exists)', async () => {
    const r = await run('clear')
    assert.equal(Number.parseInt(r.modes.split(' ')[1] ?? '0', 16) & 0x200, 0, r.modes)
    assert.ok(!r.input.includes(hex(MOUSE)), `mouse unexpectedly arrived: ${r.input}`)
  })

  it('the PowerShell helper restores VT input, and prints nothing to the console', async () => {
    const r = await run('restore')
    assert.match(r.output, /HELPER vt input: helper set modes in 0x[0-9a-f]+ -> 0x2[0-9a-f]{2}/)
    assert.ok(!r.output.includes('\x1b]0;'), 'the helper leaked a title change')
    assert.ok(r.input.includes(hex(MOUSE)), `mouse missing: ${r.input}`)
    assert.ok(r.input.includes(hex(KITTY_KEY)), `kitty key missing: ${r.input}`)
  })
})
