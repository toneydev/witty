import { test } from 'node:test'
import assert from 'node:assert/strict'
import { quantize } from '../src/sixel/quantize.ts'
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

test('an all-transparent image has an empty palette', () => {
  const q = quantize(solid(3, 3, 1, 2, 3, 0), 256)
  assert.equal(q.palette.length, 0)
  assert.ok(q.indices.every((i) => i === q.transparentIndex))
})
