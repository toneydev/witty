// The unicode placeholder pass: decoding placeholder cells, strips, chunk safety.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { cropRgba } from '../src/image/crop.ts'
import { ROW_COLUMN_DIACRITICS } from '../src/term/diacritics.ts'
import { VirtualPlacements, createPlaceholderPass } from '../src/term/placeholders.ts'
import type { CellSize, Rgba, VirtualPlacement } from '../src/types.ts'
import { make, pixel } from './helpers/images.ts'
import { decodeSixel } from './helpers/sixel-decoder.ts'

const enc = new TextEncoder()
const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1')
const concat = (parts: Uint8Array[]): Uint8Array => new Uint8Array(Buffer.concat(parts))

const CELL: CellSize = { width: 4, height: 6 }
const PH = '\u{10EEEE}'
/** The diacritic encoding `n`. */
const D = (n: number): string => String.fromCodePoint(ROW_COLUMN_DIACRITICS[n]!)
/** One placeholder cell with the given diacritic numbers. */
const cell = (...marks: number[]): string => PH + marks.map(D).join('')
/** A row of `n` cells with explicit row and column, from column `c0`. */
const row = (r: number, n: number, c0 = 0): string => Array.from({ length: n }, (_, c) => cell(r, c0 + c)).join('')

/** Channel values that survive sixel's 0..100 percentages exactly. */
const LEVELS = [0, 51, 102, 153, 204, 255]

/** An image where every cell (cw × ch pixels) of a columns × rows grid has its own exact colour. */
function cellImage(columns: number, rows: number, seed = 0, cw = CELL.width, ch = CELL.height): Rgba {
  return make(columns * cw, rows * ch, (x, y) => {
    const c = Math.floor(x / cw)
    const r = Math.floor(y / ch)
    const k = seed + r * columns + c
    return [LEVELS[k % 6]!, LEVELS[Math.floor(k / 6) % 6]!, LEVELS[Math.floor(k / 36) % 6]!, 255]
  })
}

function placement(imageId: number, image: Rgba, columns: number, rows: number, placementId?: number): VirtualPlacement {
  return { imageId, placementId, image, columns, rows }
}

function setup(...placements: VirtualPlacement[]) {
  const registry = new VirtualPlacements()
  for (const p of placements) registry.set(p)
  const logs: string[] = []
  let cellSize = CELL
  const pass = createPlaceholderPass({ registry, cellSize: () => cellSize, log: (l) => logs.push(l) })
  /** Pushes each chunk, then flushes; returns everything written, as latin1. */
  const run = (...chunks: (string | Uint8Array)[]): string =>
    latin1(concat([...chunks.map((c) => pass.push(typeof c === 'string' ? enc.encode(c) : c)), pass.flush()]))
  return { registry, pass, run, logs, setCell: (c: CellSize) => (cellSize = c) }
}

type Strip = { cells: number; image: Rgba; at: number }

/** Every strip replacement in `out`: ESC 7, spaces, ESC 8, sixel, ESC 8, CSI n C. */
function strips(out: string): Strip[] {
  const found: Strip[] = []
  const re = /\x1b7( +)\x1b8(\x1bP[\s\S]*?\x1b\\)\x1b8\x1b\[(\d+)C/g
  for (let m = re.exec(out); m !== null; m = re.exec(out)) {
    const cells = Number(m[3])
    assert.equal(m[1]!.length, cells, 'one space per cell')
    found.push({ cells, image: decodeSixel(m[2]!).image, at: m.index })
  }
  return found
}

/** `out` with every strip replacement cut out. */
const withoutStrips = (out: string): string => out.replace(/\x1b7 +\x1b8\x1bP[\s\S]*?\x1b\\\x1b8\x1b\[\d+C/g, '')

function assertPixels(actual: Rgba, expected: Rgba, label = ''): void {
  assert.equal(actual.width, expected.width, `${label} width`)
  assert.equal(actual.height, expected.height, `${label} height`)
  for (let y = 0; y < expected.height; y++) {
    for (let x = 0; x < expected.width; x++) {
      assert.deepEqual(pixel(actual, x, y), pixel(expected, x, y), `${label} pixel ${x},${y}`)
    }
  }
}

/** Strips laid side by side (all one row), to compare runs that were split differently. */
function joined(found: Strip[]): Rgba {
  const width = found.reduce((w, s) => w + s.image.width, 0)
  const height = found[0]?.image.height ?? 0
  const data = new Uint8Array(width * height * 4)
  let x0 = 0
  for (const s of found) {
    for (let y = 0; y < height; y++) {
      data.set(s.image.data.subarray(y * s.image.width * 4, (y + 1) * s.image.width * 4), (y * width + x0) * 4)
    }
    x0 += s.image.width
  }
  return { width, height, data }
}

// What Claude Code sends: a=T,U=1,i=8605545,c=8,r=2, then the cells in fg rgb(131,79,105).
const CAPTURE_ID = 8605545
const CAPTURE_SGR = '\x1b[38;2;131;79;105m'

describe('placeholder pass', () => {
  it('decodes the captured Claude Code row into one strip of the right image row', () => {
    const image = cellImage(8, 2)
    const t = setup(placement(CAPTURE_ID, image, 8, 2))
    const bytes = concat([enc.encode(CAPTURE_SGR), ...Array.from({ length: 8 }, (_, c) => enc.encode(`${PH}\u{305}${D(c)}`))])
    const out = t.run(bytes)
    const found = strips(out)
    assert.equal(found.length, 1)
    assert.equal(found[0]!.cells, 8)
    assertPixels(found[0]!.image, cropRgba(image, 0, 0, 8 * CELL.width, CELL.height), 'row 0')
    // The SGR passes through; no placeholder glyph is left.
    assert.equal(withoutStrips(out), CAPTURE_SGR)
    assert.ok(!out.includes('\xf4'))
  })

  it('scales a sprite with nearest at 9x (auto), so strips are sharp blocks; smooth on request', () => {
    const sprite = cellImage(8, 4, 0, 1, 1) // 8x4 pixels, each its own exact colour
    const cell9 = { width: 9, height: 18 } // 8x2 cells: 72x36, 9x on both axes
    const t = setup(placement(CAPTURE_ID, sprite, 8, 2))
    t.setCell(cell9)
    const found = strips(t.run(`${CAPTURE_SGR}${row(1, 8)}x`))
    assert.equal(found.length, 1)
    const strip = found[0]!.image
    assert.deepEqual([strip.width, strip.height], [72, 18])
    for (let y = 0; y < 18; y++) {
      for (let x = 0; x < 72; x++) {
        assert.deepEqual(pixel(strip, x, y), pixel(sprite, Math.floor(x / 9), 2 + Math.floor(y / 9)), `${x},${y}`)
      }
    }

    const registry = new VirtualPlacements()
    registry.set(placement(CAPTURE_ID, sprite, 8, 2))
    const smooth = createPlaceholderPass({ registry, cellSize: () => cell9, scale: 'smooth' })
    const out = latin1(concat([smooth.push(enc.encode(`${CAPTURE_SGR}${row(1, 8)}x`)), smooth.flush()]))
    const blurred = strips(out)[0]!.image
    assert.notDeepEqual(pixel(blurred, 8, 4), pixel(sprite, 0, 2), 'smooth blends at the block edge')
  })

  it('fractional cells: strips for every column range tile the scaled image with no gap or overlap', () => {
    const cw = 9.375
    const width = Math.round(10 * cw) // 94: the scaled image is exactly this wide
    const image = make(width, 20, (x) => [LEVELS[x % 6]!, LEVELS[Math.floor(x / 6) % 6]!, LEVELS[Math.floor(x / 36) % 6]!, 255])
    const t = setup(placement(CAPTURE_ID, image, 10, 1))
    t.setCell({ width: cw, height: 20 })
    for (let c0 = 0; c0 < 10; c0++) {
      for (let n = 1; c0 + n <= 10; n++) {
        const found = strips(t.run(`${CAPTURE_SGR}${row(0, n, c0)}x`))
        assert.equal(found.length, 1)
        const x0 = Math.round(c0 * cw)
        const x1 = Math.round((c0 + n) * cw)
        assertPixels(found[0]!.image, cropRgba(image, x0, 0, x1 - x0, 20), `cells ${c0}..${c0 + n - 1}`)
      }
    }
    // Single cells, side by side, cover pixel columns 0..94 exactly once.
    let next = 0
    for (let c = 0; c < 10; c++) {
      const strip = strips(t.run(`${CAPTURE_SGR}${row(0, 1, c)}x`))[0]!.image
      assert.deepEqual(pixel(strip, 0, 0), pixel(image, next, 0), `cell ${c} starts where cell ${c - 1} ended`)
      next += strip.width
    }
    assert.equal(next, width)
    // Widths alternate 9 and 10 pixels rather than all being round(9.375) = 9.
    const widths = Array.from({ length: 10 }, (_, c) => Math.round((c + 1) * cw) - Math.round(c * cw))
    assert.ok(widths.includes(9) && widths.includes(10), widths.join(','))
  })

  it('fractional cell heights: rows tile vertically from rounded row boundaries', () => {
    const ch = 18.5
    const height = Math.round(2 * ch) // 37
    const image = make(10, height, (x, y) => [LEVELS[y % 6]!, LEVELS[Math.floor(y / 6) % 6]!, LEVELS[x % 6]!, 255])
    const t = setup(placement(CAPTURE_ID, image, 2, 2))
    t.setCell({ width: 5, height: ch })
    const found = strips(t.run(`${CAPTURE_SGR}${row(0, 2)}\r\n${row(1, 2)}x`))
    assert.equal(found.length, 2)
    const y1 = Math.round(ch)
    assertPixels(found[0]!.image, cropRgba(image, 0, 0, 10, y1), 'row 0')
    assertPixels(found[1]!.image, cropRgba(image, 0, y1, 10, height - y1), 'row 1')
    assert.equal(found[0]!.image.height + found[1]!.image.height, height)
  })

  it('two rows between cursor moves become two strips', () => {
    const image = cellImage(8, 2)
    const t = setup(placement(CAPTURE_ID, image, 8, 2))
    const out = t.run(`\x1b[5;3H${CAPTURE_SGR}${row(0, 8)}\x1b[6;3H${row(1, 8)}\x1b[39m`)
    const found = strips(out)
    assert.equal(found.length, 2)
    assertPixels(found[0]!.image, cropRgba(image, 0, 0, 32, 6), 'row 0')
    assertPixels(found[1]!.image, cropRgba(image, 0, 6, 32, 6), 'row 1')
    assert.equal(withoutStrips(out), `\x1b[5;3H${CAPTURE_SGR}\x1b[6;3H\x1b[39m`)
  })

  it('scales the image once to the c x r box and crops the strip from it', () => {
    const image = cellImage(4, 1, 0, 2, 3) // 8x3 pixels, shown in 8x2 cells of 4x6
    const t = setup(placement(CAPTURE_ID, image, 8, 2))
    const found = strips(t.run(`${CAPTURE_SGR}${row(1, 3, 2)}x`))
    assert.equal(found.length, 1)
    assert.equal(found[0]!.image.width, 3 * CELL.width)
    assert.equal(found[0]!.image.height, CELL.height)
  })

  it('produces the same cells when a run is split at every byte offset', () => {
    const image = cellImage(8, 2)
    const input = enc.encode(`ab${CAPTURE_SGR}${row(0, 8)}\x1b[K`)
    const reference = setup(placement(CAPTURE_ID, image, 8, 2)).run(input)
    assert.equal(strips(reference).length, 1)
    for (let at = 0; at <= input.length; at++) {
      const t = setup(placement(CAPTURE_ID, image, 8, 2))
      const out = t.run(input.subarray(0, at), input.subarray(at))
      assert.equal(out, reference, `split at ${at}`)
    }
  })

  it('cells with all three diacritics may flush at a chunk end; the drawn cells stay the same', () => {
    const image = cellImage(8, 2)
    const input = enc.encode(`${CAPTURE_SGR}${Array.from({ length: 8 }, (_, c) => cell(0, c, 0)).join('')}`)
    for (let at = 0; at <= input.length; at++) {
      const t = setup(placement(CAPTURE_ID, image, 8, 2))
      const out = t.run(input.subarray(0, at), input.subarray(at))
      const found = strips(out)
      assert.ok(found.length >= 1 && found.length <= 2, `split at ${at}: ${found.length} strips`)
      assert.equal(found.reduce((n, s) => n + s.cells, 0), 8)
      assertPixels(joined(found), cropRgba(image, 0, 0, 32, 6), `split at ${at}`)
      assert.equal(withoutStrips(out), CAPTURE_SGR)
    }
  })

  it('holds a partial placeholder or diacritic at a chunk end until the next chunk', () => {
    const t = setup(placement(42, cellImage(2, 1), 2, 1))
    const bytes = enc.encode(`\x1b[38;5;42m${row(0, 2)}.`)
    const sgr = enc.encode('\x1b[38;5;42m').length
    assert.equal(latin1(t.pass.push(bytes.subarray(0, sgr + 2))), '\x1b[38;5;42m') // F4 8E held
    assert.equal(t.pass.push(bytes.subarray(sgr + 2, bytes.length - 2)).length, 0) // last cell's diacritic is open
    const rest = latin1(t.pass.push(bytes.subarray(bytes.length - 2)))
    assert.equal(strips(rest).length, 1)
    assert.ok(rest.endsWith('.'))
    assert.equal(t.pass.flush().length, 0)
  })

  it('flush() writes a held run at end of stream', () => {
    const t = setup(placement(42, cellImage(2, 1), 2, 1))
    assert.equal(latin1(t.pass.push(enc.encode(`\x1b[38;5;42m${row(0, 2)}`))), '\x1b[38;5;42m')
    assert.equal(strips(latin1(t.pass.flush())).length, 1)
    // A lone partial placeholder at the end is passed on as it was.
    const u = setup()
    assert.equal(u.pass.push(Uint8Array.of(0x61, 0xf4, 0x8e)).length, 1)
    assert.deepEqual([...u.pass.flush()], [0xf4, 0x8e])
  })

  it('cells without diacritics continue the previous cell; a row-only cell continues its row', () => {
    const image = cellImage(8, 2)
    const t = setup(placement(CAPTURE_ID, image, 8, 2))
    const out = t.run(`${CAPTURE_SGR}${cell(0, 0)}${PH.repeat(7)}\r\n${cell(1)}${cell(1)}${cell(1)}x`)
    const found = strips(out)
    assert.deepEqual(found.map((s) => s.cells), [8, 3])
    assertPixels(found[0]!.image, cropRgba(image, 0, 0, 32, 6), 'row 0 by inheritance')
    assertPixels(found[1]!.image, cropRgba(image, 0, 6, 12, 6), 'row 1 by row-only cells')
  })

  it('a cell whose left neighbour has other colours does not inherit', () => {
    const image = cellImage(8, 2)
    const t = setup(placement(CAPTURE_ID, image, 8, 2))
    // The second cell has no diacritics but follows a cell of another image: row 0, column 0.
    const found = strips(t.run(`\x1b[38;5;9m${cell(1, 5)}${CAPTURE_SGR}${PH}x`))
    assert.equal(found.length, 1)
    assertPixels(found[0]!.image, cropRgba(image, 0, 0, 4, 6))
  })

  it('a 256-colour and a basic-colour foreground name the image', () => {
    const a = cellImage(2, 1, 0)
    const b = cellImage(2, 1, 10)
    const c = cellImage(2, 1, 20)
    const t = setup(placement(42, a, 2, 1), placement(3, b, 2, 1), placement(11, c, 2, 1))
    for (const [sgr, image] of [
      ['\x1b[38;5;42m', a],
      ['\x1b[38:5:42m', a],
      ['\x1b[38:2::0:0:42m', a],
      ['\x1b[38:2:0:0:42m', a],
      ['\x1b[1;38;2;0;0;42;4m', a],
      ['\x1b[33m', b],
      ['\x1b[93m', c],
    ] as const) {
      const found = strips(t.run(`${sgr}${row(0, 2)}\x1b[0m`))
      assert.equal(found.length, 1, JSON.stringify(sgr))
      assertPixels(found[0]!.image, image, JSON.stringify(sgr))
    }
  })

  it('the underline colour picks the placement', () => {
    const a = cellImage(2, 1, 0)
    const b = cellImage(2, 1, 10)
    const t = setup(placement(42, a, 2, 1, 7), placement(42, b, 2, 1, 9))
    assertPixels(strips(t.run(`\x1b[38;5;42;58;5;9m${row(0, 2)}x`))[0]!.image, b, '58;5;9')
    assertPixels(strips(t.run(`\x1b[38;5;42m\x1b[58:2::0:0:7m${row(0, 2)}x`))[0]!.image, a, '58:2::0:0:7')
    // An unknown placement id shows nothing of the image; 59 resets to "any placement".
    const unknown = `\x1b[38;5;42;58;5;8m${row(0, 2)}x`
    assert.equal(t.run(unknown), latin1(enc.encode(unknown)))
    assert.equal(strips(t.run(`\x1b[38;5;42;58;5;8m\x1b[59m${row(0, 2)}x`)).length, 1)
  })

  it('the third diacritic is the most significant byte of the image id', () => {
    const image = cellImage(3, 1)
    const id = 2 * 0x1000000 + 5
    const t = setup(placement(id, image, 3, 1), placement(5, cellImage(3, 1, 30), 3, 1))
    // The second cell inherits the high byte (it continues the first), the third gives it again.
    const found = strips(t.run(`\x1b[38;5;5m${cell(0, 0, 2)}${cell(0, 1)}${cell(0, 2, 2)}x`))
    assert.equal(found.length, 1)
    assertPixels(found[0]!.image, image)
  })

  it('cells of an unknown image pass through unchanged', () => {
    const t = setup(placement(42, cellImage(2, 1), 2, 1))
    const input = `\x1b[38;2;1;2;3m${row(0, 4)}\x1b[0m${row(0, 2)}`
    assert.equal(t.run(input), latin1(enc.encode(input)))
    assert.ok(t.logs.some((l) => l.includes('image 66051')), t.logs.join('\n'))
  })

  it('SGR tracking survives 0 and 39 resets, and background colours are not foreground', () => {
    const t = setup(placement(42, cellImage(2, 1), 2, 1))
    const passthrough = [
      `\x1b[38;5;42m\x1b[0m${row(0, 2)}`,
      `\x1b[38;5;42m\x1b[m${row(0, 2)}`,
      `\x1b[38;5;42;39m${row(0, 2)}`,
      `\x1b[48;5;42m${row(0, 2)}`,
      `\x1b[48;2;0;0;42m${row(0, 2)}`,
    ]
    for (const input of passthrough) assert.equal(t.run(input), latin1(enc.encode(input)), JSON.stringify(input))
    assert.equal(strips(t.run(`\x1b[38;5;42m\x1b[0m\x1b[38;5;42m${row(0, 2)}`)).length, 1)
    // A private-mode CSI ending in m is not SGR.
    assert.equal(strips(t.run(`\x1b[38;5;42m\x1b[?0m${row(0, 2)}`)).length, 1)
  })

  it('placeholders inside an OSC string are left alone', () => {
    const t = setup(placement(42, cellImage(2, 1), 2, 1))
    const input = `\x1b[38;5;42m\x1b]0;${row(0, 2)}\x07`
    assert.equal(t.run(input), latin1(enc.encode(input)))
  })

  it('cells outside the placement box are blanked; strips are cut at image edges', () => {
    const image = cellImage(2, 1)
    const t = setup(placement(42, image, 2, 1))
    const outside = t.run(`\x1b[38;5;42m${row(1, 2)}x`)
    assert.equal(outside, '\x1b[38;5;42m  x')
    const found = strips(t.run(`\x1b[38;5;42m${row(0, 3, 1)}x`))
    assert.equal(found.length, 1)
    assert.equal(found[0]!.cells, 3)
    assert.deepEqual(pixel(found[0]!.image, 0, 0), pixel(image, 4, 0))
    assert.deepEqual(pixel(found[0]!.image, 4, 0), [0, 0, 0, 0], 'past the image: transparent')
  })

  it('a replaced placement shows its new pixels; the cell size is read per strip', () => {
    const t = setup(placement(42, cellImage(2, 1, 0), 2, 1))
    const input = `\x1b[38;5;42m${row(0, 2)}x`
    const before = strips(t.run(input))[0]!.image
    t.registry.set(placement(42, cellImage(2, 1, 7), 2, 1))
    const after = strips(t.run(input))[0]!.image
    assertPixels(after, cellImage(2, 1, 7))
    assert.notDeepEqual(after.data, before.data)
    t.setCell({ width: 5, height: 7 })
    const resized = strips(t.run(input))[0]!.image
    assert.deepEqual([resized.width, resized.height], [10, 7])
  })

  it('a deleted placement passes its cells through again', () => {
    const t = setup(placement(42, cellImage(2, 1), 2, 1, 3), placement(42, cellImage(2, 1, 5), 2, 1))
    const input = `\x1b[38;5;42m${row(0, 2)}x`
    t.registry.delete([42], [{ imageId: 42, placementId: undefined }])
    assert.equal(strips(t.run(input)).length, 1, 'placement 3 is still there')
    t.registry.delete([42])
    assert.equal(t.run(input), latin1(enc.encode(input)))
  })

  it('plain text passes through as the same bytes', () => {
    const t = setup()
    const chunk = enc.encode('hello \x1b[1mworld\x1b[0m \u{E9}\u{1F600}\n')
    assert.equal(t.pass.push(chunk), chunk)
  })
})
