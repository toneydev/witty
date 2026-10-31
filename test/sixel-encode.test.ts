import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeSixel, encodeSixelBytes } from '../src/sixel/encode.ts'
import { decodeSixel, fromPercent } from './helpers/sixel-decoder.ts'
import { make, pixel, rng, solid } from './helpers/images.ts'
import type { Rgba } from '../src/types.ts'

/** What a channel value becomes after the sixel 0..100 percentage step. */
const viaPercent = (v: number): number => fromPercent(Math.round((v * 100) / 255))

/** Asserts that `got` equals `want` after percentage rounding; transparent (a < 128) must come back a = 0. */
function assertSame(got: Rgba, want: Rgba): void {
  assert.equal(got.width, want.width)
  assert.equal(got.height, want.height)
  for (let y = 0; y < want.height; y++) {
    for (let x = 0; x < want.width; x++) {
      const [r, g, b, a] = pixel(want, x, y)
      const expected = a < 128 ? [0, 0, 0, 0] : [viaPercent(r), viaPercent(g), viaPercent(b), 255]
      assert.deepEqual(pixel(got, x, y), expected, `pixel ${x},${y}`)
    }
  }
}

function roundTrip(image: Rgba, opts = {}) {
  const text = encodeSixel(image, opts)
  const decoded = decodeSixel(text)
  assert.equal(decoded.length, text.length, 'one DCS, nothing after ST')
  assert.equal(decoded.outOfBounds, 0)
  assert.ok(decoded.maxRegister <= 255)
  return { text, decoded }
}

test('header, raster attributes and terminator', () => {
  const text = encodeSixel(solid(13, 7, 10, 20, 30))
  assert.ok(text.startsWith('\x1bP9;1;0q"1;1;13;7#0;'), JSON.stringify(text.slice(0, 30)))
  assert.ok(text.endsWith('\x1b\\'))
  assert.equal(text.split('\x1bP').length, 2)
  assert.ok(!text.endsWith('-\x1b\\'), 'no band separator after the last band')
  assert.ok(!text.includes('$-'), 'no carriage return before a band separator')
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    assert.ok(c === 0x1b || (c >= 0x20 && c < 0x7f), `byte ${c} at ${i}`)
  }
  const d = decodeSixel(text)
  assert.deepEqual(d.params, [9, 1, 0])
  assert.deepEqual(d.raster, [1, 1, 13, 7])
})

test('solid colours come back exact', () => {
  for (const [r, g, b] of [
    [255, 0, 0],
    [0, 0, 0],
    [255, 255, 255],
    [fromPercent(37), fromPercent(81), fromPercent(3)],
  ] as const) {
    const image = solid(16, 12, r, g, b)
    const { decoded } = roundTrip(image)
    assertSame(decoded.image, image)
    assert.equal(decoded.palette.size, 1)
    assert.deepEqual(pixel(decoded.image, 5, 5), [r, g, b, 255])
  }
})

test('255 and 0 map to 100% and 0%', () => {
  const { decoded } = roundTrip(make(2, 1, (x) => (x === 0 ? [255, 0, 255, 255] : [0, 255, 0, 255])))
  assert.deepEqual(decoded.palette.get(0), [100, 0, 100])
  assert.deepEqual(decoded.palette.get(1), [0, 100, 0])
})

test('<= 255 distinct colours plus a transparent region round-trip pixel-exact', () => {
  // 255 distinct colours, each exactly representable in percentages.
  const colors: [number, number, number][] = []
  for (let i = 0; i < 255; i++) colors.push([fromPercent(i % 101), fromPercent((i * 7) % 101), fromPercent((i * 13) % 97)])
  const image = make(41, 29, (x, y) => {
    if (x >= 10 && x < 20 && y >= 5 && y < 17) return [12, 34, 56, x % 2 === 0 ? 0 : 100] // transparent block
    const c = colors[(y * 41 + x) % 255]!
    return [c[0], c[1], c[2], 255]
  })
  const { decoded } = roundTrip(image)
  assert.equal(decoded.palette.size, 255)
  assertSame(decoded.image, image)
  for (let y = 0; y < 29; y++) {
    for (let x = 0; x < 41; x++) {
      const [r, g, b, a] = pixel(image, x, y)
      if (a === 255) assert.deepEqual(pixel(decoded.image, x, y), [r, g, b, 255])
    }
  }
})

test('256 distinct opaque colours use all 256 registers exactly', () => {
  const image = make(16, 16, (x, y) => [fromPercent(x * 6), fromPercent(y * 6), fromPercent((x + y) % 101), 255])
  const { decoded } = roundTrip(image)
  assert.equal(decoded.palette.size, 256)
  assert.equal(decoded.maxRegister, 255)
  assertSame(decoded.image, image)
})

test('a 1000-colour gradient stays close and uses <= 256 registers', () => {
  const w = 200
  const h = 50
  const image = make(w, h, (x, y) => [Math.round((x * 255) / (w - 1)), Math.round((y * 255) / (h - 1)), 128, 255])
  // Count distinct colours in the source to be sure it is > 256.
  const distinct = new Set<number>()
  for (let p = 0; p < image.data.length; p += 4) distinct.add((image.data[p]! << 16) | (image.data[p + 1]! << 8) | image.data[p + 2]!)
  assert.ok(distinct.size >= 1000, `distinct ${distinct.size}`)

  const { decoded } = roundTrip(image)
  assert.ok(decoded.palette.size <= 256 && decoded.palette.size > 200, `palette ${decoded.palette.size}`)
  let err = 0
  let worst = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = pixel(image, x, y)
      const b = pixel(decoded.image, x, y)
      assert.equal(b[3], 255)
      for (let k = 0; k < 3; k++) {
        const e = Math.abs(a[k]! - b[k]!)
        err += e
        if (e > worst) worst = e
      }
    }
  }
  const mean = err / (w * h * 3)
  assert.ok(mean < 4, `mean error ${mean}`)
  assert.ok(worst < 24, `worst error ${worst}`)
})

test('random noise never uses a register above 255', () => {
  const rand = rng(7)
  const image = make(64, 64, () => [Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256), rand() < 0.1 ? 0 : 255])
  const { decoded } = roundTrip(image)
  assert.ok(decoded.palette.size <= 255, `palette ${decoded.palette.size}`)
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      assert.equal(pixel(decoded.image, x, y)[3], pixel(image, x, y)[3] === 0 ? 0 : 255)
    }
  }
})

test('long runs are run-length encoded', () => {
  const image = solid(100, 6, 0, 0, 255)
  const { text, decoded } = roundTrip(image)
  assert.ok(text.includes('#0!100~'), text)
  assert.equal(decoded.repeats, 1)
  assertSame(decoded.image, image)

  // Runs of 3 are written out, runs of 4 use `!`.
  const short = make(7, 1, (x) => (x < 3 ? [255, 0, 0, 255] : [0, 255, 0, 255]))
  const s = roundTrip(short)
  assert.ok(s.text.includes('#0@@@'), s.text)
  assert.ok(s.text.includes('#1???!4@'), s.text)
  assertSame(s.decoded.image, short)
})

test('trailing empty sixels are trimmed and absent colours skipped', () => {
  // Red only in the left half of band 0; blue only in band 1.
  const image = make(20, 12, (x, y) => (y < 6 ? (x < 5 ? [255, 0, 0, 255] : [0, 0, 0, 0]) : [0, 0, 255, 255]))
  const { text, decoded } = roundTrip(image)
  const body = text.slice(text.indexOf('#1;2;0;0;100') + '#1;2;0;0;100'.length, -2)
  assert.equal(body, '#0!5~-#1!20~')
  assertSame(decoded.image, image)
})

test('a 1x1 image', () => {
  const image = solid(1, 1, 255, 128, 0)
  const { text, decoded } = roundTrip(image)
  assert.ok(text.includes('"1;1;1;1'))
  assertSame(decoded.image, image)
  const empty = roundTrip(solid(1, 1, 0, 0, 0, 0))
  assert.equal(empty.decoded.palette.size, 0)
  assert.deepEqual(pixel(empty.decoded.image, 0, 0), [0, 0, 0, 0])
})

test('odd widths and heights that are not multiples of 6', () => {
  for (const w of [1, 7, 37]) {
    for (const h of [1, 5, 6, 7, 11, 13, 18]) {
      const image = make(w, h, (x, y) => [(x % 8) * 36, (y % 6) * 51, (x + y) % 3 * 120, (x + y) % 5 === 0 ? 0 : 255])
      const { text, decoded } = roundTrip(image)
      assert.equal(text.split('-').length, Math.ceil(h / 6), `bands for h=${h}`)
      assertSame(decoded.image, image)
    }
  }
})

test('a fully transparent image draws nothing', () => {
  const image = solid(10, 13, 200, 100, 50, 0)
  const { text, decoded } = roundTrip(image)
  assert.equal(text, '\x1bP9;1;0q"1;1;10;13--\x1b\\')
  assert.equal(decoded.palette.size, 0)
})

test('transparent: false draws every pixel', () => {
  const image = make(4, 4, (x) => (x < 2 ? [255, 255, 255, 0] : [0, 0, 0, 255]))
  const { decoded } = roundTrip(image, { transparent: false })
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) assert.equal(pixel(decoded.image, x, y)[3], 255)
  assert.deepEqual(pixel(decoded.image, 0, 0), [255, 255, 255, 255])
})

test('maxColors caps the palette', () => {
  const image = make(64, 8, (x) => [x * 4, 255 - x * 4, 0, 255])
  const { decoded } = roundTrip(image, { maxColors: 16 })
  assert.ok(decoded.palette.size <= 16, `palette ${decoded.palette.size}`)
  const exact = roundTrip(make(4, 1, (x) => [x * 80, 0, 0, 255]), { maxColors: 4 })
  assert.equal(exact.decoded.palette.size, 4)
})

test('a non-finite maxColors means the default 256, never more registers', () => {
  const rand = rng(17)
  const image = make(40, 40, () => [Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256), 255])
  for (const maxColors of [NaN, Infinity]) {
    const { text, decoded } = roundTrip(image, { maxColors })
    assert.equal(decoded.palette.size, 256, `maxColors ${maxColors}`)
    assert.equal(text, encodeSixel(image))
  }
})

test('output is deterministic and the string matches the bytes', () => {
  const rand = rng(3)
  const image = make(50, 20, () => [Math.floor(rand() * 256), Math.floor(rand() * 256), 0, 255])
  const a = encodeSixel(image)
  assert.equal(encodeSixel(image), a)
  assert.equal(Buffer.from(encodeSixelBytes(image)).toString('latin1'), a)
})

test('a 1280x720 image encodes in well under a second', () => {
  const w = 1280
  const h = 720
  const image = make(w, h, (x, y) => [
    (x * 255) / w,
    (y * 255) / h,
    128 + 127 * Math.sin(x / 40) * Math.cos(y / 30),
    255,
  ])
  const start = performance.now()
  const text = encodeSixel(image)
  const ms = performance.now() - start
  const decoded = decodeSixel(text)
  assert.equal(decoded.image.width, w)
  assert.equal(decoded.image.height, h)
  assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`)
})
