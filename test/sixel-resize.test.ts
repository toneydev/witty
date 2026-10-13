import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resizeRegion, resizeRgba, resolveScaleMode } from '../src/image/resize.ts'
import { cropRgba } from '../src/image/crop.ts'
import type { Rgba } from '../src/types.ts'
import { make, pixel, rng, solid } from './helpers/images.ts'

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

/**
 * The smooth path as it was before the pass order became adaptive: a full
 * premultiplied Float32 copy of the source, the horizontal pass always first.
 * A reference for the pixels only; its intermediate is dw x sh.
 */
function horizontalFirstReference(image: Rgba, dw: number, dh: number): Rgba {
  const { width: sw, height: sh, data: src } = image
  const taps = (n: number, m: number) => {
    const out: [number, number][][] = []
    const scale = n / m
    for (let i = 0; i < m; i++) {
      const t: [number, number][] = []
      if (m === n) t.push([i, 1])
      else if (m < n) {
        const lo = i * scale
        const hi = Math.min(n, (i + 1) * scale)
        for (let j = Math.floor(lo); j < Math.ceil(hi); j++) {
          const overlap = Math.min(hi, j + 1) - Math.max(lo, j)
          if (overlap > 1e-9) t.push([j, overlap / scale])
        }
      } else {
        const x = (i + 0.5) * scale - 0.5
        if (x <= 0) t.push([0, 1])
        else if (x >= n - 1) t.push([n - 1, 1])
        else t.push([Math.floor(x), 1 - (x - Math.floor(x))], [Math.floor(x) + 1, x - Math.floor(x)])
      }
      out.push(t)
    }
    return out
  }
  const pre = new Float32Array(sw * sh * 4)
  for (let p = 0; p < sw * sh * 4; p += 4) {
    const k = src[p + 3]! / 255
    pre[p] = src[p]! * k
    pre[p + 1] = src[p + 1]! * k
    pre[p + 2] = src[p + 2]! * k
    pre[p + 3] = src[p + 3]!
  }
  const hx = taps(sw, dw)
  const mid = new Float32Array(dw * sh * 4)
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < dw; x++) {
      for (const [j, w] of hx[x]!) for (let c = 0; c < 4; c++) mid[(y * dw + x) * 4 + c]! += pre[(y * sw + j) * 4 + c]! * w
    }
  }
  const vy = taps(sh, dh)
  const out = new Uint8Array(dw * dh * 4)
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const v = [0, 0, 0, 0]
      for (const [j, w] of vy[y]!) for (let c = 0; c < 4; c++) v[c]! += mid[(j * dw + x) * 4 + c]! * w
      const a = Math.round(v[3]!)
      if (a <= 0) continue
      const d = (y * dw + x) * 4
      for (let c = 0; c < 3; c++) out[d + c] = Math.max(0, Math.min(255, Math.round((v[c]! * 255) / v[3]!)))
      out[d + 3] = Math.min(255, a)
    }
  }
  return { width: dw, height: dh, data: out }
}

/** Asserts every channel of `actual` is within 1 of `expected`. */
function assertClose(actual: Rgba, expected: Rgba, label: string) {
  assert.deepEqual([actual.width, actual.height], [expected.width, expected.height], label)
  for (let p = 0; p < expected.data.length; p++) {
    const diff = Math.abs(actual.data[p]! - expected.data[p]!)
    if (diff > 1) {
      const i = p >> 2
      assert.fail(`${label}: pixel ${i % expected.width},${Math.floor(i / expected.width)} channel ${p & 3}: ${actual.data[p]} vs ${expected.data[p]}`)
    }
  }
}

/** Random colour and alpha, with some fully transparent and fully opaque pixels. */
function noise(w: number, h: number, seed: number): Rgba {
  const r = rng(seed)
  return make(w, h, () => {
    const t = r()
    const a = t < 0.15 ? 0 : t < 0.5 ? 255 : Math.floor(r() * 256)
    return [Math.floor(r() * 256), Math.floor(r() * 256), Math.floor(r() * 256), a]
  })
}

test('smooth output does not depend on which axis is filtered first', () => {
  // Each pair is the same scaling both ways round: the cheaper pass order is
  // horizontal-first for one and vertical-first for the other.
  const shapes: [number, number, number, number][] = [
    [40, 30, 5, 20], // shrink both
    [30, 40, 20, 5],
    [5, 4, 13, 31], // grow both
    [4, 5, 31, 13],
    [40, 8, 6, 30], // shrink one, grow the other
    [8, 40, 30, 6],
    [33, 17, 33, 4], // one axis unchanged
    [17, 33, 4, 33],
    [16, 4096, 512, 5], // the tall-source shape, small enough for the reference
  ]
  let seed = 1
  for (const [sw, sh, dw, dh] of shapes) {
    const src = noise(sw, sh, seed++)
    const label = `${sw}x${sh} -> ${dw}x${dh}`
    assertClose(resizeRgba(src, dw, dh, { mode: 'smooth' }), horizontalFirstReference(src, dw, dh), label)
  }
})

/**
 * Runs `f` while watching every Float32Array and Float64Array built; one asking
 * for more than `limit` elements throws before it is allocated. Returns the
 * largest seen.
 */
function largestFloatArray(limit: number, f: () => void): number {
  const saved32 = globalThis.Float32Array
  const saved64 = globalThis.Float64Array
  let largest = 0
  const handler: ProxyHandler<Float32ArrayConstructor | Float64ArrayConstructor> = {
    construct(target, args) {
      const n = typeof args[0] === 'number' ? args[0] : (args[0] as ArrayLike<number>).length
      if (n > limit) throw new RangeError(`a ${n}-element ${target.name} exceeds ${limit}`)
      largest = Math.max(largest, n)
      return Reflect.construct(target, args)
    },
  }
  globalThis.Float32Array = new Proxy(saved32, handler) as Float32ArrayConstructor
  globalThis.Float64Array = new Proxy(saved64, handler) as Float64ArrayConstructor
  try {
    f()
  } finally {
    globalThis.Float32Array = saved32
    globalThis.Float64Array = saved64
  }
  return largest
}

test('scratch memory is bounded by the larger of source and destination, not their product', () => {
  // A 256x65536 source (64 MiB, a small zlib payload) placed in an 8192x20 box:
  // filtering horizontally first would need an 8192x65536 float intermediate
  // (8 GiB). Rows are identical, so the box-filtered column is the row itself
  // and the result is that row stretched, on every output row.
  const row = make(256, 1, (x) => [x, 255 - x, (x * 7) & 255, x < 16 ? 0 : 128 + (x >> 1)])
  for (const transpose of [false, true]) {
    const [sw, sh, dw, dh] = transpose ? [65536, 256, 20, 8192] : [256, 65536, 8192, 20]
    const data = new Uint8Array(sw * sh * 4)
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) data.set(row.data.subarray((transpose ? y : x) * 4, (transpose ? y : x) * 4 + 4), (y * sw + x) * 4)
    }
    const label = `${sw}x${sh} -> ${dw}x${dh}`
    let out: Rgba | undefined
    const largest = largestFloatArray(4 * Math.max(sw * sh, dw * dh), () => {
      out = resizeRgba({ width: sw, height: sh, data }, dw, dh)
    })
    assert.ok(largest < sw * sh, `${label}: no float copy of the whole source (largest ${largest})`)
    const line = transpose
      ? horizontalFirstReference({ width: 1, height: 256, data: row.data }, 1, 8192)
      : horizontalFirstReference(row, 8192, 1)
    const expected = new Uint8Array(dw * dh * 4)
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) expected.set(line.data.subarray((transpose ? y : x) * 4, (transpose ? y : x) * 4 + 4), (y * dw + x) * 4)
    }
    assertClose(out!, { width: dw, height: dh, data: expected }, label)
  }
})

test('a region is the top-left of the whole resize: exact for nearest and unchanged sizes, within 1 for smooth', () => {
  const image = noise(37, 23, 7)
  const cases: [number, number, number, number][] = [
    [200, 150, 61, 40], // growing
    [20, 11, 7, 5], // shrinking
    [90, 9, 33, 4], // growing across, shrinking down
    [9, 90, 4, 33], // shrinking across, growing down
    [37, 50, 20, 17], // one axis unchanged
    [37, 23, 10, 10], // no scaling at all
    [74, 46, 74, 46], // the whole box
    [300, 7, 1, 7], // one column
  ]
  for (const mode of ['smooth', 'nearest', 'auto'] as const) {
    for (const [w, h, rw, rh] of cases) {
      const label = `${mode} ${w}x${h} -> ${rw}x${rh}`
      const expected = cropRgba(resizeRgba(image, w, h, { mode }), 0, 0, rw, rh)
      const region = resizeRegion(image, w, h, rw, rh, { mode })
      assert.deepEqual([region.width, region.height], [rw, rh], label)
      if (resolveScaleMode(mode, 37, 23, w, h) === 'nearest' || (w === 37 && h === 23)) assert.deepEqual(region.data, expected.data, label)
      else assertClose(region, expected, label)
    }
  }
  const copy = resizeRegion(image, 37, 23, 37, 23)
  assert.notEqual(copy.data, image.data, 'always a new buffer')
})

test('a region costs what it reads, not the whole box', () => {
  // 100x100 of a 2048x2048 source enlarged to 4096x4096 (a 64 Mi-pixel box).
  const square = { width: 2048, height: 2048, data: new Uint8Array(2048 * 2048 * 4) }
  const largest = largestFloatArray(4 * 100 * 100, () => {
    resizeRegion(square, 4096, 4096, 100, 100, { mode: 'smooth' })
  })
  assert.ok(largest <= 4 * 100 * 100, `largest ${largest}`)
  // The tall source of the scratch-memory test, clipped to 800x20 of its
  // 8192x20 box: filtered vertically first over the ~25 columns it reads.
  const row = make(256, 1, (x) => [x, 255 - x, 0, 255])
  const tall = { width: 256, height: 65536, data: new Uint8Array(256 * 65536 * 4) }
  for (let y = 0; y < 65536; y++) tall.data.set(row.data, y * 256 * 4)
  let out: Rgba | undefined
  const tallLargest = largestFloatArray(4 * 65536 + 16, () => {
    out = resizeRegion(tall, 8192, 20, 800, 20, { mode: 'smooth' })
  })
  assert.ok(tallLargest <= 65536 + 16, `largest ${tallLargest}`) // the vertical taps, not a float image
  const line = cropRgba(horizontalFirstReference(row, 8192, 1), 0, 0, 800, 1)
  const expected = new Uint8Array(800 * 20 * 4)
  for (let y = 0; y < 20; y++) expected.set(line.data, y * 800 * 4)
  assertClose(out!, { width: 800, height: 20, data: expected }, 'every row is the stretched source row')
})
