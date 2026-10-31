import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nearestSearch, quantize } from '../src/sixel/quantize.ts'
import { make, rng, solid } from './helpers/images.ts'

test('few colours: exact palette in first-appearance order', () => {
  const image = make(3, 2, (x, y) => {
    if (y === 1 && x === 2) return [9, 9, 9, 0]
    return x === 1 ? [1, 2, 3, 255] : [200, 100, 50, 255]
  })
  const q = quantize(image, 256)
  assert.deepEqual([...q.palette], [200, 100, 50, 1, 2, 3])
  assert.deepEqual([...q.indices], [0, 1, 0, 0, 1, 255])
  assert.equal(q.transparentIndex, 255)
})

test('alpha threshold', () => {
  const image = make(4, 1, (x) => [10, 10, 10, [0, 127, 128, 255][x]!])
  assert.deepEqual([...quantize(image, 256).indices], [255, 255, 0, 0])
  assert.deepEqual([...quantize(image, 256, { alphaThreshold: 0 }).indices], [0, 0, 0, 0])
  assert.deepEqual([...quantize(image, 256, { alphaThreshold: 256 }).indices], [255, 255, 255, 255])
})

test('256 opaque colours are exact; transparentIndex stays above the palette', () => {
  const image = make(16, 16, (x, y) => [x * 16, y * 16, 7, 255])
  const q = quantize(image, 256)
  assert.equal(q.palette.length / 3, 256)
  assert.equal(q.transparentIndex, 256)
  for (let i = 0; i < 256; i++) {
    assert.equal(q.palette[q.indices[i]! * 3], (i % 16) * 16)
    assert.equal(q.palette[q.indices[i]! * 3 + 1], Math.floor(i / 16) * 16)
  }
})

test('256 colours plus transparency fall back to <= 255 entries', () => {
  const image = make(17, 16, (x, y) => (x === 16 ? [0, 0, 0, 0] : [x * 16, y * 16, 7, 255]))
  const q = quantize(image, 256)
  const n = q.palette.length / 3
  assert.ok(n <= 255, `n=${n}`)
  assert.equal(q.transparentIndex, 255)
  for (let y = 0; y < 16; y++) assert.equal(q.indices[y * 17 + 16], 255)
  for (const i of q.indices) assert.ok(i < n || i === 255)
})

test('median cut respects maxColors, maps every opaque pixel, is deterministic', () => {
  const rand = rng(11)
  const image = make(100, 80, () => [Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256), 255])
  for (const max of [2, 16, 100, 256]) {
    const q = quantize(image, max)
    const n = q.palette.length / 3
    assert.ok(n <= max && n >= Math.min(max, 2), `max=${max} n=${n}`)
    for (const i of q.indices) assert.ok(i < n)
    const again = quantize(image, max)
    assert.deepEqual(again.palette, q.palette)
    assert.deepEqual(again.indices, q.indices)
  }
})

test('median cut maps to the nearest palette colour', () => {
  // Two tight clusters plus noise: dark pixels must map to the dark entry.
  const image = make(40, 40, (x, y) => (x < 20 ? [10 + (y % 5), 10, 10, 255] : [240, 240 - (y % 7), 240, 255]))
  const q = quantize(image, 2)
  assert.equal(q.palette.length / 3, 2)
  const left = q.indices[0]!
  const right = q.indices[39]!
  assert.notEqual(left, right)
  assert.ok(q.palette[left * 3]! < 30)
  assert.ok(q.palette[right * 3]! > 220)
})

test('median cut picks the nearest palette entry of each cell centre, lowest index on ties', () => {
  const rand = rng(5)
  const image = make(120, 90, (x, y) => [(x * 2 + Math.floor(rand() * 40)) & 255, (y * 3) & 255, Math.floor(rand() * 256), 255])
  for (const max of [3, 37, 256]) {
    const q = quantize(image, max)
    const n = q.palette.length / 3
    for (let i = 0; i < image.width * image.height; i++) {
      // The full search, over the 6-bit cell centre of the pixel.
      const centre = [0, 1, 2].map((k) => (image.data[i * 4 + k]! & 0xfc) + 1.5)
      let best = Infinity
      let expected = 0
      for (let k = 0; k < n; k++) {
        const d = [0, 1, 2].reduce((sum, ch) => sum + (q.palette[k * 3 + ch]! - centre[ch]!) ** 2, 0)
        if (d < best) {
          best = d
          expected = k
        }
      }
      assert.equal(q.indices[i], expected, `max=${max} pixel ${i}`)
    }
  }
})

test('results do not depend on earlier calls', () => {
  const rand = rng(23)
  const noisy = (alpha: boolean) =>
    make(64, 48, () => [Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256), alpha && rand() < 0.3 ? 0 : 255])
  const a = noisy(false)
  const b = noisy(true)
  const first = quantize(a, 64)
  const between = quantize(b, 200)
  assert.deepEqual(quantize(a, 64), first)
  quantize(noisy(false), 17)
  assert.deepEqual(quantize(b, 200), between)
})

test('results do not depend on an earlier image that used most of the cells (tables reset at once)', () => {
  const rand = rng(29)
  const small = make(40, 30, () => [Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256), rand() < 0.2 ? 0 : 255])
  // 200x150 random pixels fall in about 28k of the 2^18 cells: past the
  // sixteenth (16384) from which the tables are cleared whole.
  const dense = make(200, 150, () => [Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256), 255])
  const before = quantize(small, 100)
  const denseFirst = quantize(dense, 256)
  assert.deepEqual(quantize(small, 100), before)
  assert.deepEqual(quantize(dense, 256), denseFirst)
  assert.deepEqual(quantize(small, 100), before)
})

test('an all-transparent image has an empty palette', () => {
  const q = quantize(solid(3, 3, 1, 2, 3, 0), 256)
  assert.equal(q.palette.length, 0)
  assert.ok(q.indices.every((i) => i === q.transparentIndex))
})

/** The full search: the palette entry nearest the centre of 6-bit cell `cell`, lowest index on ties. */
function bruteNearest(palette: Uint8Array, cell: number): number {
  const centre = [(cell >> 12) & 63, (cell >> 6) & 63, cell & 63].map((v) => v * 4 + 1.5)
  let best = Infinity
  let index = 0
  for (let k = 0; k < palette.length / 3; k++) {
    const d = (palette[k * 3]! - centre[0]!) ** 2 + (palette[k * 3 + 1]! - centre[1]!) ** 2 + (palette[k * 3 + 2]! - centre[2]!) ** 2
    if (d < best) {
      best = d
      index = k
    }
  }
  return index
}

test('the nearest search is exact both ways it runs: red order and block candidate lists', () => {
  const rand = rng(31)
  const byte = () => Math.floor(rand() * 256)
  const palettes = [
    Uint8Array.from({ length: 256 * 3 }, byte),
    Uint8Array.from({ length: 255 * 3 }, byte),
    Uint8Array.from({ length: 16 * 3 }, byte),
    Uint8Array.from([0, 0, 0, 255, 255, 255]),
    // Clustered, with duplicates and entries on cell boundaries: ties are common.
    Uint8Array.from({ length: 200 * 3 }, () => 64 + Math.floor(rand() * 8) * 4),
  ]
  for (const [p, palette] of palettes.entries()) {
    const red = nearestSearch(palette, () => false)
    const lists = nearestSearch(palette, () => true)
    // Every cell for the first palette, a fixed sample of cells for the rest.
    const step = p === 0 ? 1 : 7
    for (let cell = 0; cell < 1 << 18; cell += step) {
      const expected = bruteNearest(palette, cell)
      if (red(cell) !== expected || lists(cell) !== expected) {
        assert.fail(`palette ${p} cell ${cell}: red ${red(cell)}, lists ${lists(cell)}, expected ${expected}`)
      }
    }
  }
})

test('a photo-sized image (block lists in use) maps every pixel to the nearest entry of its cell', () => {
  const rand = rng(41)
  const image = make(512, 256, (x, y) => [
    Math.min(255, Math.max(0, x / 2 + (rand() - 0.5) * 60)),
    Math.min(255, Math.max(0, y + (rand() - 0.5) * 60)),
    Math.floor(128 + 100 * Math.sin(x / 40 + y / 30) + (rand() - 0.5) * 30),
    255,
  ])
  const q = quantize(image, 256)
  const seen = new Map<number, number>()
  for (let i = 0; i < image.width * image.height; i++) {
    const d = image.data
    const cell = ((d[i * 4]! >> 2) << 12) | ((d[i * 4 + 1]! >> 2) << 6) | (d[i * 4 + 2]! >> 2)
    let expected = seen.get(cell)
    if (expected === undefined) {
      expected = bruteNearest(q.palette, cell)
      seen.set(cell, expected)
    }
    if (q.indices[i] !== expected) assert.fail(`pixel ${i}: ${q.indices[i]} instead of ${expected}`)
  }
  assert.ok(seen.size > 16384, `the image should use many cells (${seen.size})`)
})

test('median cut on an opaque image: transparentIndex stays above a 256-entry palette', () => {
  const rand = rng(43)
  const image = make(64, 64, () => [Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256), 255])
  const q = quantize(image, 256)
  assert.equal(q.palette.length / 3, 256)
  assert.equal(q.transparentIndex, 256)
  const transparent = quantize({ ...image, data: image.data.map((v, i) => (i === 3 ? 0 : v)) }, 256)
  assert.ok(transparent.palette.length / 3 <= 255)
  assert.equal(transparent.transparentIndex, 255)
})

test('a non-finite maxColors means the default, never an unbounded palette', () => {
  const rand = rng(47)
  const image = make(40, 40, () => [Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256), 255])
  for (const max of [NaN, Infinity, -Infinity]) {
    const q = quantize(image, max)
    assert.deepEqual(q, quantize(image, 256), `maxColors ${max}`)
  }
})
