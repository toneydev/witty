// Cell-size reply parsing, `--cell` parsing, and learnCellSize's handling of
// input that arrives around the reply.

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import {
  CELL_SIZE_QUERY,
  STARTUP_QUERIES,
  TEXT_AREA_QUERY,
  TEXT_CELLS_QUERY,
  chooseCellSize,
  deriveCellSize,
  formatCell,
  learnCellSize,
  parseCellOption,
  parseCellSizeReply,
  parseWindowReports,
  trackCellSize,
  type ByteSource,
} from '../src/term/metrics.ts'

const bytes = (s: string) => Buffer.from(s, 'latin1')

/** A fake stdin: emit chunks with `send`; records pause(). */
class FakeInput extends EventEmitter implements ByteSource {
  paused = false
  pause() {
    this.paused = true
    return this
  }
  send(s: string) {
    this.emit('data', bytes(s))
  }
}

describe('parseCellSizeReply', () => {
  it('parses CSI 6 ; height ; width t', () => {
    assert.deepEqual(parseCellSizeReply(bytes('\x1b[6;20;10t')), { cell: { width: 10, height: 20 }, start: 0, end: 10 })
  })

  it('finds the reply amid other input and reports its span', () => {
    const r = parseCellSizeReply(bytes('ab\x1b[A\x1b[6;17;9tcd'))
    assert.deepEqual(r, { cell: { width: 9, height: 17 }, start: 5, end: 14 })
  })

  it('accepts the 8-bit CSI introducer', () => {
    assert.deepEqual(parseCellSizeReply(Uint8Array.of(0x9b, ...bytes('6;16;8t')))?.cell, { width: 8, height: 16 })
  })

  it('rejects partial, malformed and zero-sized replies', () => {
    assert.equal(parseCellSizeReply(bytes('\x1b[6;20;10')), undefined)
    assert.equal(parseCellSizeReply(bytes('\x1b[4;600;800t')), undefined)
    assert.equal(parseCellSizeReply(bytes('\x1b[6;0;10t')), undefined)
    assert.equal(parseCellSizeReply(bytes('\x1b[6;20t')), undefined)
    assert.equal(parseCellSizeReply(bytes('')), undefined)
  })

  it('skips a zero-sized reply and takes a later valid one', () => {
    assert.deepEqual(parseCellSizeReply(bytes('\x1b[6;0;0t\x1b[6;18;9t'))?.cell, { width: 9, height: 18 })
  })
})

describe('parseCellOption', () => {
  it('parses WxH', () => {
    assert.deepEqual(parseCellOption('10x20'), { width: 10, height: 20 })
    assert.deepEqual(parseCellOption('8X16'), { width: 8, height: 16 })
  })
  it('accepts decimals', () => {
    assert.deepEqual(parseCellOption('9.375x20'), { width: 9.375, height: 20 })
    assert.deepEqual(parseCellOption('9.5x18.25'), { width: 9.5, height: 18.25 })
  })
  it('rejects junk', () => {
    for (const s of ['', '10', 'x20', '10x', '0x20', '10x0', 'axb', '10x20x30', '.5x20', '9.x20', '0.0x20', '9,5x20']) {
      assert.equal(parseCellOption(s), undefined, s)
    }
  })
})

describe('size reports', () => {
  it('parses CSI 4, 6 and 8 t reports in order', () => {
    const reports = parseWindowReports(bytes('x\x1b[4;760;1481ty\x1b[8;38;158t\x1b[6;20;9t\x1b[5;1;1t'))
    assert.deepEqual(
      reports.map((r) => [r.kind, r.width, r.height]),
      [
        ['text-area', 1481, 760],
        ['cells', 158, 38],
        ['cell', 9, 20],
      ],
    )
    assert.deepEqual([reports[0]!.start, reports[0]!.end], [1, 14])
  })

  it('derives the cell from the text area, preferring it over CSI 16 t', () => {
    const reports = parseWindowReports(bytes('\x1b[6;20;9t\x1b[4;760;1481t\x1b[8;38;158t'))
    const chosen = chooseCellSize(reports, { columns: 80, rows: 24 })
    assert.equal(chosen?.source, 'text area')
    assert.equal(chosen?.cell.width, 1481 / 158)
    assert.equal(chosen?.cell.height, 20)
    assert.equal(formatCell(chosen!.cell), '9.373x20.000')
    // Without CSI 18 t the console's own size divides the text area.
    const noCells = chooseCellSize(parseWindowReports(bytes('\x1b[4;760;1481t\x1b[6;20;9t')), { columns: 158, rows: 38 })
    assert.deepEqual(noCells, { cell: { width: 1481 / 158, height: 20 }, source: 'text area' })
    // Only CSI 16 t, or a text area with no known cell count: the 16 t reply.
    assert.deepEqual(chooseCellSize(parseWindowReports(bytes('\x1b[6;20;9t')), undefined), { cell: { width: 9, height: 20 }, source: 'terminal reply' })
    assert.equal(chooseCellSize(parseWindowReports(bytes('\x1b[4;760;1481t\x1b[6;20;9t')), { columns: 0, rows: 0 })?.source, 'terminal reply')
    assert.equal(chooseCellSize([], undefined), undefined)
    assert.equal(deriveCellSize({ width: 100, height: 100 }, { columns: 0, rows: 5 }), undefined)
  })

  it('tracks reports seen later: keeps an exact size against its rounding, follows real changes', () => {
    const exact = { cell: { width: 1481 / 158, height: 20 }, source: 'text area' as const }
    const screen = { columns: 158, rows: 38 }
    assert.deepEqual(trackCellSize(exact, parseWindowReports(bytes('\x1b[6;20;9t')), screen), exact)
    assert.deepEqual(trackCellSize(exact, parseWindowReports(bytes('\x1b[6;24;12t')), screen), {
      cell: { width: 12, height: 24 },
      source: 'terminal reply',
    })
    const rederived = trackCellSize(exact, parseWindowReports(bytes('\x1b[8;40;100t\x1b[4;800;950t')), screen)
    assert.deepEqual(rederived, { cell: { width: 9.5, height: 20 }, source: 'text area' })
    const fromReply = { cell: { width: 9, height: 20 }, source: 'terminal reply' as const }
    assert.deepEqual(trackCellSize(fromReply, parseWindowReports(bytes('\x1b[6;20;10t')), screen).cell, { width: 10, height: 20 })
  })
})

describe('learnCellSize', () => {
  it('sends the query and returns the reply, keeping other input as leftover', async () => {
    const input = new FakeInput()
    const written: string[] = []
    const p = learnCellSize({ input, write: (s) => written.push(s), timeoutMs: 1000 })
    assert.deepEqual(written, [STARTUP_QUERIES])
    assert.equal(STARTUP_QUERIES, TEXT_AREA_QUERY + TEXT_CELLS_QUERY + CELL_SIZE_QUERY)
    input.send('hi\x1b[6;1')
    input.send('7;9tthere')
    const r = await p
    assert.deepEqual(r.cell, { width: 9, height: 17 })
    assert.equal(r.fromTerminal, true)
    assert.equal(Buffer.from(r.leftover).toString('latin1'), 'hithere')
    assert.equal(input.paused, true)
    assert.equal(input.listenerCount('data'), 0)
  })

  it('falls back after the timeout and keeps everything read', async () => {
    const input = new FakeInput()
    const started = Date.now()
    const p = learnCellSize({ input, write: () => {}, fallback: { width: 7, height: 14 }, timeoutMs: 80 })
    input.send('typed early')
    const r = await p
    assert.ok(Date.now() - started >= 70)
    assert.deepEqual(r, { cell: { width: 7, height: 14 }, fromTerminal: false, source: 'fallback', reports: [], leftover: r.leftover })
    assert.equal(Buffer.from(r.leftover).toString('latin1'), 'typed early')
    assert.equal(input.paused, true)
  })

  it('defaults to 10x20', async () => {
    const r = await learnCellSize({ input: new FakeInput(), write: () => {}, timeoutMs: 10 })
    assert.deepEqual(r.cell, { width: 10, height: 20 })
    assert.equal(r.leftover.length, 0)
  })

  it('resolves as soon as all three replies are in, preferring the text area; replies split across chunks', async () => {
    const input = new FakeInput()
    const started = Date.now()
    const p = learnCellSize({ input, write: () => {}, timeoutMs: 5000, settleMs: 5000, screen: () => ({ columns: 80, rows: 24 }) })
    input.send('a\x1b[4;760;14')
    input.send('81t\x1b[8;38;158tb\x1b[6;2')
    input.send('0;9tc')
    const r = await p
    assert.ok(Date.now() - started < 1000)
    assert.equal(r.source, 'text area')
    assert.deepEqual(r.cell, { width: 1481 / 158, height: 20 })
    assert.equal(r.fromTerminal, true)
    assert.deepEqual(r.reports.map((x) => x.kind), ['text-area', 'cells', 'cell'])
    assert.equal(Buffer.from(r.leftover).toString('latin1'), 'abc')
  })

  it('waits only settleMs for missing replies; a text area alone uses the screen size', async () => {
    const input = new FakeInput()
    const started = Date.now()
    const p = learnCellSize({ input, write: () => {}, timeoutMs: 5000, settleMs: 30, screen: () => ({ columns: 158, rows: 38 }) })
    input.send('\x1b[4;760;1481t')
    const r = await p
    assert.ok(Date.now() - started < 1000)
    assert.deepEqual(r.cell, { width: 1481 / 158, height: 20 })
    assert.equal(r.source, 'text area')
  })
})
