// Cell-size reply parsing, `--cell` parsing, following the size reports seen
// on the input (witty's own answers, however they are split, and the
// child's), and taking witty's answers out of the input.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CellSize } from '../src/types.ts'
import {
  CELL_SIZE_QUERY,
  STARTUP_QUERIES,
  TEXT_AREA_QUERY,
  TEXT_CELLS_QUERY,
  deriveCellSize,
  formatCell,
  parseCellOption,
  parseCellSizeReply,
  parseWindowReports,
  ReplyFilter,
  STARTUP_KINDS,
  trackCellSize,
  type TrackedCellSize,
} from '../src/term/metrics.ts'

const bytes = (s: string) => Buffer.from(s, 'latin1')
const text = (b: Uint8Array) => Buffer.from(b).toString('latin1')

/**
 * Feeds `reads` through a ReplyFilter owing all three startup answers and
 * trackCellSize, as cli.ts does. Returns the size after each read and
 * everything forwarded to the child.
 */
function follow(reads: readonly string[], screen: { columns: number; rows: number }, fallback: CellSize = { width: 8, height: 16 }) {
  const filter = new ReplyFilter(STARTUP_KINDS)
  let size: TrackedCellSize = { cell: fallback, source: 'fallback' }
  const sizes: TrackedCellSize[] = []
  let forwarded = ''
  for (const read of reads) {
    const { forward, reports, consumed } = filter.push(bytes(read))
    forwarded += text(forward)
    size = trackCellSize(size, reports, screen, consumed)
    sizes.push(size)
  }
  return { size, sizes, forwarded }
}

describe('parseCellSizeReply', () => {
  it('parses CSI 6 ; height ; width t', () => {
    assert.deepEqual(parseCellSizeReply(bytes('\x1b[6;20;10t')), { cell: { width: 10, height: 20 }, start: 0, end: 10 })
  })

  it('finds the reply amid other input and reports its span', () => {
    const r = parseCellSizeReply(bytes('ab\x1b[A\x1b[6;17;9tcd'))
    assert.deepEqual(r, { cell: { width: 9, height: 17 }, start: 5, end: 14 })
  })

  it('ignores a 0x9b byte: in UTF-8 input it is part of a character, never an 8-bit CSI', () => {
    assert.equal(parseCellSizeReply(Uint8Array.of(0x9b, ...bytes('6;16;8t'))), undefined)
    // Û is C3 9B, 💛 is F0 9F 92 9B: typed or pasted before `6;20;10t` they once read as a report.
    for (const text of ['Û6;20;10t', '💛4;1;1t', 'ě8;12;30t', 'Л6;9;9t']) {
      assert.deepEqual(parseWindowReports(Buffer.from(text, 'utf8')), [], text)
    }
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

  it('asks for the text area, its cell count and the cell size, in that order', () => {
    assert.equal(STARTUP_QUERIES, TEXT_AREA_QUERY + TEXT_CELLS_QUERY + CELL_SIZE_QUERY)
    assert.equal(STARTUP_QUERIES, '\x1b[14t\x1b[18t\x1b[16t')
    assert.deepEqual(STARTUP_KINDS, ['text-area', 'cells', 'cell'])
  })

  it('derives a fractional cell from a text area and its cell count', () => {
    const cell = deriveCellSize({ width: 1481, height: 760 }, { columns: 158, rows: 38 })
    assert.deepEqual(cell, { width: 1481 / 158, height: 20 })
    assert.equal(formatCell(cell!), '9.373x20.000')
    assert.equal(deriveCellSize({ width: 100, height: 100 }, { columns: 0, rows: 5 }), undefined)
    assert.equal(deriveCellSize({ width: 0, height: 100 }, { columns: 10, rows: 5 }), undefined)
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

  it('divides a text area by the cell count from the same batch, even when that comes after it', () => {
    // The order the startup queries are answered in: 14 t, 18 t, 16 t. The screen here is not the terminal's size.
    const fallback = { cell: { width: 8, height: 16 }, source: 'fallback' as const }
    const reports = parseWindowReports(bytes('\x1b[4;760;1481t\x1b[8;38;158t\x1b[6;20;9t'))
    const tracked = trackCellSize(fallback, reports, { columns: 80, rows: 24 })
    assert.deepEqual(tracked, { cell: { width: 1481 / 158, height: 20 }, source: 'text area' })
  })
})

describe('ReplyFilter', () => {
  it('consumes the first report of each owed kind and forwards later ones', () => {
    const filter = new ReplyFilter(STARTUP_KINDS)
    const first = filter.push(bytes('a\x1b[4;760;1481tb\x1b[8;38;158t\x1b[6;20;9tc'))
    assert.equal(text(first.forward), 'abc')
    assert.deepEqual(first.consumed.map((r) => r.kind), ['text-area', 'cells', 'cell'])
    assert.deepEqual(first.reports.map((r) => r.kind), ['text-area', 'cells', 'cell'])
    assert.equal(filter.pending.size, 0)
    // The child asks next: its answers pass through, and are still reported for tracking.
    const later = filter.push(bytes('\x1b[6;20;9tx'))
    assert.equal(text(later.forward), '\x1b[6;20;9tx')
    assert.deepEqual(later.consumed, [])
    assert.deepEqual(later.reports.map((r) => r.kind), ['cell'])
  })

  it('consumes only the kinds still owed; a repeat of an answered kind goes to the child', () => {
    const filter = new ReplyFilter(['cell'])
    const r = filter.push(bytes('\x1b[4;760;1481t\x1b[6;20;9t\x1b[6;21;9t'))
    assert.equal(text(r.forward), '\x1b[4;760;1481t\x1b[6;21;9t')
    assert.deepEqual(r.consumed.map((x) => [x.kind, x.height]), [['cell', 20]])
  })

  it('holds the start of an owed report across chunks, and gives it back when it was not one', () => {
    const filter = new ReplyFilter(['cell'])
    const a = filter.push(bytes('ab\x1b[6;2'))
    assert.equal(text(a.forward), 'ab')
    assert.equal(filter.holding, true)
    const b = filter.push(bytes('0;9tcd'))
    assert.equal(text(b.forward), 'cd')
    assert.deepEqual(b.consumed.map((x) => x.kind), ['cell'])
    assert.equal(filter.holding, false)

    const other = new ReplyFilter(['cell'])
    assert.equal(text(other.push(bytes('x\x1b[6;5')).forward), 'x')
    assert.equal(text(other.push(bytes('~y')).forward), '\x1b[6;5~y', 'Ctrl+PgDn split after its parameters')
    other.push(bytes('\x1b[6;'))
    assert.equal(text(other.flush()), '\x1b[6;')
    assert.equal(other.holding, false)
  })

  it('never holds keys: a lone ESC, CSI 6 ~, or a report kind no longer owed', () => {
    const filter = new ReplyFilter(['cell'])
    for (const key of ['\x1b', '\x1b[', '\x1b[6', '\x1b[6~', '\x1b[4;5']) {
      assert.equal(text(filter.push(bytes(key)).forward), key, JSON.stringify(key))
      assert.equal(filter.holding, false, JSON.stringify(key))
    }
  })

  it('keeps UTF-8 typed while the answers are owed intact, 0x9b bytes and all', () => {
    const filter = new ReplyFilter(STARTUP_KINDS)
    const typed = Buffer.from('ńŁ ść Û6;20;10t ok 💛4;1;1t ě8;12;30t', 'utf8')
    const r = filter.push(typed)
    assert.deepEqual(Buffer.from(r.forward), typed)
    assert.deepEqual(r.reports, [])
    assert.equal(filter.pending.size, 3)
    assert.equal(filter.holding, false)
  })

  it('passes everything through untouched when nothing is owed', () => {
    const filter = new ReplyFilter([])
    const chunk = bytes('\x1b[6;20;9t\x1b[6;2')
    const r = filter.push(chunk)
    assert.equal(r.forward, chunk)
    assert.equal(r.reports.length, 1)
    assert.equal(filter.holding, false)
  })
})

describe("witty's own answers, however they are split", () => {
  // The terminal's text area is 158x38 cells; the console size passed as the screen is not.
  const exact: TrackedCellSize = { cell: { width: 1481 / 158, height: 20 }, source: 'text area' }
  const answers = '\x1b[4;760;1481t\x1b[8;38;158t\x1b[6;20;9t'

  it('picks the text area divided by its cell count when all three come in one read', () => {
    const { size, forwarded } = follow([answers], { columns: 80, rows: 24 })
    assert.deepEqual(size, exact)
    assert.equal(forwarded, '')
  })

  it('ends at the same size when they are split across reads, with typing around them', () => {
    const splits = [
      ['\x1b[4;760;1481t', '\x1b[8;38;158t', '\x1b[6;20;9t'],
      ['\x1b[4;760;1481t\x1b[8;38;158t', '\x1b[6;20;9t'],
      ['\x1b[4;760;1481t', '\x1b[8;38;158t\x1b[6;20;9t'],
      ['a\x1b[4;760;14', '81tb\x1b[8;38;1', '58tc\x1b[6;2', '0;9td'],
      ['a\x1b[4;760;1481tb', 'c', '\x1b[8;38;158t', 'd\x1b[6;20;9t'],
    ]
    for (const reads of splits) {
      const { size, forwarded } = follow(reads, { columns: 80, rows: 24 })
      assert.deepEqual(size, exact, JSON.stringify(reads))
      assert.equal(forwarded, reads.join('').replace(/\x1b\[[468];\d+;\d+t/g, ''), JSON.stringify(reads))
    }
  })

  it('divides a text area that comes before its cell count by the console size, then by the count', () => {
    const { sizes } = follow(['\x1b[4;760;1481t', '\x1b[8;38;158t', '\x1b[6;20;9t'], { columns: 80, rows: 24 })
    assert.deepEqual(sizes[0], { cell: { width: 1481 / 80, height: 760 / 24 }, source: 'text area', area: { width: 1481, height: 760 } })
    assert.deepEqual(sizes[1], exact)
    assert.deepEqual(sizes[2], exact)
  })

  it('waits for the cell count when the console size is unknown', () => {
    const { sizes } = follow(['\x1b[4;760;1481t', '\x1b[8;38;158t'], { columns: 0, rows: 0 })
    assert.deepEqual(sizes[0], { cell: { width: 8, height: 16 }, source: 'fallback', area: { width: 1481, height: 760 } })
    assert.deepEqual(sizes[1], exact)
  })

  it('keeps the text area against its own 16 t answer even when that is more than rounding; a later one replaces it', () => {
    const { sizes } = follow(['\x1b[4;760;1481t\x1b[8;38;158t', '\x1b[6;24;12t', '\x1b[6;24;12t'], { columns: 80, rows: 24 })
    assert.deepEqual(sizes[1], exact, "witty's own 16 t answer")
    assert.deepEqual(sizes[2], { cell: { width: 12, height: 24 }, source: 'terminal reply' }, "the child's")
  })

  it('without a text area takes the 16 t answer, and without that keeps the fallback', () => {
    assert.deepEqual(follow(['\x1b[8;38;158t', '\x1b[6;20;9t'], { columns: 80, rows: 24 }).size, {
      cell: { width: 9, height: 20 },
      source: 'terminal reply',
    })
    assert.deepEqual(follow(['\x1b[8;38;158t'], { columns: 80, rows: 24 }).size, { cell: { width: 8, height: 16 }, source: 'fallback' })
    assert.deepEqual(follow(['typed'], { columns: 80, rows: 24 }).size, { cell: { width: 8, height: 16 }, source: 'fallback' })
  })

  it('a text area with no cell count at all: divided by the console size, else the 16 t answer', () => {
    assert.deepEqual(follow(['\x1b[4;760;1481t', '\x1b[6;20;9t'], { columns: 158, rows: 38 }).size, exact)
    // The 16 t answer comes after any 18 t answer, so the text area stops waiting for one.
    assert.deepEqual(follow(['\x1b[4;760;1481t', '\x1b[6;20;9t'], { columns: 0, rows: 0 }).size, {
      cell: { width: 9, height: 20 },
      source: 'terminal reply',
    })
  })

  it("re-derives only from witty's own cell count: the child's lone CSI 8 t (after a resize, say) changes nothing", () => {
    const screen = { columns: 100, rows: 30 }
    const resized = parseWindowReports(bytes('\x1b[8;30;100t'))
    assert.deepEqual(trackCellSize(exact, resized, screen, []), exact)
    const waiting: TrackedCellSize = { ...exact, area: { width: 1481, height: 760 } }
    assert.deepEqual(trackCellSize(waiting, resized, screen, []), waiting)
    assert.deepEqual(trackCellSize(waiting, resized, screen, resized), {
      cell: { width: 14.81, height: 760 / 30 },
      source: 'text area',
    })
  })
})
