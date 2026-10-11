import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resizeRgba, resolveScaleMode } from '../src/image/resize.ts'
import { make, pixel, solid } from './helpers/images.ts'

const checker = (w: number, h: number, size = 1) =>
  make(w, h, (x, y) => ((Math.floor(x / size) + Math.floor(y / size)) % 2 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]))

test('downscaling a checkerboard gives gray', () => {
  const out = resizeRgba(checker(16, 16), 4, 4)
  assert.equal(out.width, 4)
  assert.equal(out.height, 4)
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const [r, g, b, a] = pixel(out, x, y)
      assert.ok(Math.abs(r - 128) <= 1 && r === g && g === b, `${x},${y}: ${r}`)
      assert.equal(a, 255)
    }
  }
  const one = resizeRgba(checker(7, 5), 1, 1)
  assert.ok(Math.abs(pixel(one, 0, 0)[0] - 128) <= 20) // 18 of 35 black: ~120
})

test('non-integer shrink keeps a solid colour solid', () => {
  const out = resizeRgba(solid(10, 7, 30, 60, 90), 3, 4)
  for (let y = 0; y < 4; y++) for (let x = 0; x < 3; x++) assert.deepEqual(pixel(out, x, y), [30, 60, 90, 255])
})

test('upscaling preserves corner colours', () => {
  const src = make(2, 2, (x, y) => [x ? 255 : 0, y ? 255 : 0, x && y ? 255 : 0, 255])
  const out = resizeRgba(src, 9, 8, { mode: 'smooth' })
  assert.deepEqual(pixel(out, 0, 0), [0, 0, 0, 255])
  assert.deepEqual(pixel(out, 8, 0), [255, 0, 0, 255])
  assert.deepEqual(pixel(out, 0, 7), [0, 255, 0, 255])
  assert.deepEqual(pixel(out, 8, 7), [255, 255, 255, 255])
  // Monotonic in between.
  for (let x = 1; x < 9; x++) assert.ok(pixel(out, x, 0)[0] >= pixel(out, x - 1, 0)[0])
})

test('one axis shrinks while the other grows', () => {
  const src = make(8, 2, (x, y) => [x < 4 ? 0 : 255, y === 0 ? 0 : 255, 0, 255])
  const out = resizeRgba(src, 2, 6)
  assert.equal(out.width, 2)
  assert.equal(out.height, 6)
  assert.deepEqual(pixel(out, 0, 0), [0, 0, 0, 255])
  assert.deepEqual(pixel(out, 1, 0), [255, 0, 0, 255])
  assert.deepEqual(pixel(out, 0, 5), [0, 255, 0, 255])
  assert.deepEqual(pixel(out, 1, 5), [255, 255, 0, 255])
})

test('transparent edges do not darken colour', () => {
  // Opaque red on the left, fully transparent black on the right.
  const src = make(10, 10, (x) => (x < 5 ? [255, 0, 0, 255] : [0, 0, 0, 0]))
  for (const [w, h] of [
    [3, 3],
    [7, 10],
    [23, 17],
  ] as const) {
    const out = resizeRgba(src, w, h)
    let partial = 0
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const [r, g, b, a] = pixel(out, x, y)
        if (a === 0) continue
        if (a < 255) partial++
        assert.deepEqual([r, g, b], [255, 0, 0], `${w}x${h} at ${x},${y} alpha ${a}`)
      }
    }
    assert.ok(partial > 0, `${w}x${h} has a blended edge`)
  }
})

test('same size returns an equal copy', () => {
  const src = checker(5, 3)
  const out = resizeRgba(src, 5, 3)
  assert.notEqual(out, src)
  assert.notEqual(out.data, src.data)
  assert.deepEqual(out.data, src.data)
})

test('sizes round and clamp to at least 1', () => {
  const out = resizeRgba(solid(4, 4, 1, 2, 3), 0, 2.4)
  assert.equal(out.width, 1)
  assert.equal(out.height, 2)
})

/** An 8x4 sprite: every pixel its own colour, the last column transparent. */
const sprite = make(8, 4, (x, y) => [x * 32, y * 64, (x + y) % 2 ? 255 : 0, x === 7 ? 0 : 255])

test('nearest reproduces a sprite exactly at 9x: each pixel a sharp 9x9 block', () => {
  const out = resizeRgba(sprite, 72, 36, { mode: 'nearest' })
  assert.deepEqual([out.width, out.height], [72, 36])
  for (let y = 0; y < 36; y++) {
    for (let x = 0; x < 72; x++) {
      assert.deepEqual(pixel(out, x, y), pixel(sprite, Math.floor(x / 9), Math.floor(y / 9)), `${x},${y}`)
    }
  }
  // The block edge between source pixels 0 and 1 (columns 8 and 9) is a hard step.
  assert.deepEqual(pixel(out, 8, 4), pixel(sprite, 0, 0))
  assert.deepEqual(pixel(out, 9, 4), pixel(sprite, 1, 0))
  assert.notDeepEqual(pixel(out, 8, 4), pixel(out, 9, 4))
  // Smooth blends across that edge instead.
  const smooth = resizeRgba(sprite, 72, 36, { mode: 'smooth' })
  const [r8] = pixel(smooth, 8, 4)
  assert.ok(r8 > 0 && r8 < 32, `smooth blends: ${r8}`)
})

test('nearest handles non-integer factors and shrinking', () => {
  const up = resizeRgba(sprite, 20, 10, { mode: 'nearest' })
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 20; x++) {
      assert.deepEqual(pixel(up, x, y), pixel(sprite, Math.floor(((x + 0.5) * 8) / 20), Math.floor(((y + 0.5) * 4) / 10)))
    }
  }
  const down = resizeRgba(sprite, 4, 2, { mode: 'nearest' })
  assert.deepEqual(pixel(down, 0, 0), pixel(sprite, 1, 1))
})

test('auto picks nearest at 2x or more on both axes, smooth otherwise', () => {
  assert.equal(resolveScaleMode('auto', 8, 4, 16, 8), 'nearest')
  assert.equal(resolveScaleMode('auto', 8, 4, 72, 38), 'nearest')
  assert.equal(resolveScaleMode('auto', 8, 4, 12, 6), 'smooth')
  assert.equal(resolveScaleMode('auto', 8, 4, 16, 6), 'smooth', 'only one axis at 2x')
  assert.equal(resolveScaleMode('auto', 8, 4, 4, 2), 'smooth')
  assert.equal(resolveScaleMode('nearest', 8, 4, 4, 2), 'nearest')
  assert.equal(resolveScaleMode('smooth', 8, 4, 72, 36), 'smooth')

  // And resizeRgba follows it: auto is the default.
  assert.deepEqual(resizeRgba(sprite, 16, 8), resizeRgba(sprite, 16, 8, { mode: 'nearest' }))
  assert.deepEqual(resizeRgba(sprite, 12, 6, { mode: 'auto' }), resizeRgba(sprite, 12, 6, { mode: 'smooth' }))
  assert.notDeepEqual(resizeRgba(sprite, 12, 6, { mode: 'smooth' }), resizeRgba(sprite, 12, 6, { mode: 'nearest' }))
})
