import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_BOX_PIXELS, MAX_BOX_SIDE, createPlaceEmitter, emitPlacement, placementGeometry, scaleToBox } from '../src/term/emit.ts'
import { decodeSixel } from './helpers/sixel-decoder.ts'
import { make, pixel, rng, solid } from './helpers/images.ts'
import type { CursorPolicy, EngineEvent, Rgba } from '../src/types.ts'

type Place = Extract<EngineEvent, { kind: 'place' }>

const place = (image: Rgba, columns: number, rows: number, cursor: CursorPolicy): Place => ({
  kind: 'place',
  image,
  columns,
  rows,
  cursor,
  imageId: 1,
})

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1')

function split(out: string) {
  assert.ok(out.startsWith('\x1b7\x1bP'), JSON.stringify(out.slice(0, 8)))
  assert.equal(out.split('\x1bP').length, 2, 'exactly one DCS')
  const st = out.indexOf('\x1b\\')
  assert.ok(st > 0)
  return { sixel: out.slice(2, st + 2), tail: out.slice(st + 2) }
}

test('move policy: save, sixel, restore, down rows-1, right columns', () => {
  const out = emitPlacement(place(solid(3, 3, 255, 0, 0), 4, 3, 'move'), { width: 10, height: 20 })
  assert.ok(out instanceof Uint8Array)
  for (const b of out) assert.ok(b < 0x80)
  const { sixel, tail } = split(text(out))
  assert.equal(tail, '\x1b8\x1b[2B\x1b[4C')
  const d = decodeSixel(sixel)
  assert.equal(d.image.width, 40)
  assert.equal(d.image.height, 60)
  assert.deepEqual(pixel(d.image, 39, 59), [255, 0, 0, 255])
})

test('move policy with one row moves only right', () => {
  const out = emitPlacement(place(solid(5, 5, 0, 0, 255), 2, 1, 'move'), { width: 8, height: 16 })
  const { sixel, tail } = split(text(out))
  assert.equal(tail, '\x1b8\x1b[2C')
  const d = decodeSixel(sixel)
  assert.equal(d.image.width, 16)
  assert.equal(d.image.height, 16)
})

test('stay policy: restore only', () => {
  const out = emitPlacement(place(solid(5, 5, 0, 255, 0), 3, 2, 'stay'), { width: 9, height: 17 })
  const { sixel, tail } = split(text(out))
  assert.equal(tail, '\x1b8')
  const d = decodeSixel(sixel)
  assert.equal(d.image.width, 27)
  assert.equal(d.image.height, 34)
})

test('the image is scaled to fill the box, transparency kept', () => {
  // Left half opaque white, right half transparent.
  const image = make(10, 10, (x) => (x < 5 ? [255, 255, 255, 255] : [0, 0, 0, 0]))
  const out = emitPlacement(place(image, 2, 1, 'stay'), { width: 10, height: 20 })
  const d = decodeSixel(split(text(out)).sixel)
  assert.equal(d.image.width, 20)
  assert.equal(d.image.height, 20)
  assert.deepEqual(pixel(d.image, 2, 10), [255, 255, 255, 255])
  assert.deepEqual(pixel(d.image, 17, 10), [0, 0, 0, 0])
})

test('an image already at box size is drawn exactly', () => {
  const image = make(8, 6, (x, y) => [x * 32, y * 40, 0, 255])
  const out = createPlaceEmitter({ maxColors: 256 })(place(image, 2, 1, 'stay'), { width: 4, height: 6 })
  const d = decodeSixel(split(text(out)).sixel)
  assert.equal(d.palette.size, 48)
})

test('scaling policy: auto and nearest keep a small sprite sharp, smooth blends it', () => {
  // 2x1 pixels (red, blue) into 2x1 cells of 10x20: a 10x enlargement.
  const sprite = make(2, 1, (x) => (x === 0 ? [255, 0, 0, 255] : [0, 0, 255, 255]))
  const cell = { width: 10, height: 20 }
  for (const emit of [emitPlacement, createPlaceEmitter({ scale: 'nearest' }), createPlaceEmitter({ scale: 'auto' })]) {
    const d = decodeSixel(split(text(emit(place(sprite, 2, 1, 'stay'), cell))).sixel)
    assert.deepEqual([d.image.width, d.image.height], [20, 20])
    assert.deepEqual(pixel(d.image, 9, 10), [255, 0, 0, 255])
    assert.deepEqual(pixel(d.image, 10, 10), [0, 0, 255, 255])
    assert.equal(d.palette.size, 2)
  }
  const smooth = decodeSixel(split(text(createPlaceEmitter({ scale: 'smooth' })(place(sprite, 2, 1, 'stay'), cell))).sixel)
  assert.ok(smooth.palette.size > 2, 'blended colours in between')
})

test('fractional cells: the box is round(columns * cw) x round(rows * ch)', () => {
  const out = emitPlacement(place(solid(4, 4, 0, 255, 0), 8, 3, 'move'), { width: 9.375, height: 18.5 })
  const { sixel, tail } = split(text(out))
  const d = decodeSixel(sixel)
  assert.deepEqual([d.image.width, d.image.height], [75, 56]) // 75, round(55.5)
  assert.equal(tail, '\x1b8\x1b[2B\x1b[8C')
})

test('the scaled pixel box is capped: c=1000,r=1000 at 10x20 stays within 8192 a side and 16M pixels', () => {
  const cell = { width: 10, height: 20 }
  const g = placementGeometry(1000, 1000, cell) // uncapped: 10000x20000
  assert.ok(g.width <= MAX_BOX_SIDE && g.height <= MAX_BOX_SIDE, `${g.width}x${g.height}`)
  assert.ok(g.width * g.height <= MAX_BOX_PIXELS, `${g.width * g.height}`)
  assert.ok(Math.abs(g.width / g.height - 0.5) < 0.01, 'scaled down proportionally')
  assert.equal(Math.round(1000 * g.cell.width), g.width, 'the shrunk cell tiles the box')
  const scaled = scaleToBox(solid(2, 2, 0, 0, 255), 1000, 1000, cell, 'nearest')
  assert.deepEqual([scaled.width, scaled.height], [g.width, g.height])
  assert.ok(scaled.data.length <= MAX_BOX_PIXELS * 4)
  // One long side alone is capped too, and a box within the cap is untouched.
  const long = placementGeometry(1000, 1, cell)
  assert.deepEqual([long.width, long.height], [8192, 16])
  assert.deepEqual(placementGeometry(80, 24, cell), { width: 800, height: 480, cell })
})

test('options reach the encoder', () => {
  const image = make(64, 4, (x) => [x * 4, 0, 0, 255])
  const out = createPlaceEmitter({ maxColors: 8 })(place(image, 8, 1, 'stay'), { width: 8, height: 4 })
  const d = decodeSixel(split(text(out)).sixel)
  assert.ok(d.palette.size <= 8)
})

// Clipping to the screen, and the placement cache.

const raster = (out: Uint8Array) => decodeSixel(split(text(out)).sixel).raster!

/** A busy opaque image of at most 64 distinct colours (so quantization is exact). */
function busy(width: number, height: number, seed: number): Rgba {
  const r = rng(seed)
  return make(width, height, () => [Math.floor(r() * 4) * 85, Math.floor(r() * 4) * 85, Math.floor(r() * 4) * 85, 255])
}

test('a box larger than the screen draws only what the screen shows: c=819,r=400 on 80x24', () => {
  const cell = { width: 10, height: 20 }
  const event = place(busy(256, 128, 1), 819, 400, 'move')
  const out = createPlaceEmitter()(event, cell, { columns: 80, rows: 24 })
  const [, , width, height] = raster(out)
  assert.ok(width <= 80 * cell.width && height <= 24 * cell.height, `${width}x${height}`)
  assert.ok(out.length <= 80 * cell.width * 24 * cell.height * 5, `${out.length} bytes`)
  assert.ok(split(text(out)).tail === '\x1b8\x1b[399B\x1b[819C', 'the cursor still moves past the whole box')
})

test('clipped output is the top-left of the unclipped output (fractional cells)', () => {
  const cell = { width: 9.375, height: 18.5 }
  const event = place(busy(41, 29, 2), 100, 40, 'stay')
  const emit = createPlaceEmitter({ scale: 'nearest', cacheBytes: 0 })
  const whole = decodeSixel(split(text(emit(event, cell))).sixel).image
  const clipped = decodeSixel(split(text(emit(event, cell, { columns: 80, rows: 24 }))).sixel).image
  assert.deepEqual([whole.width, whole.height], [938, 740]) // round(937.5), 740
  assert.deepEqual([clipped.width, clipped.height], [750, 444]) // round(80 * 9.375), round(24 * 18.5)
  for (let y = 0; y < clipped.height; y++) {
    for (let x = 0; x < clipped.width; x++) {
      const a = pixel(clipped, x, y)
      const b = pixel(whole, x, y)
      for (let c = 0; c < 4; c++) assert.ok(Math.abs(a[c]! - b[c]!) <= 1, `(${x},${y}) ${a} vs ${b}`)
    }
  }
})

test('the screen clips each axis on its own; an unknown or larger screen changes nothing', () => {
  const cell = { width: 8, height: 16 }
  const event = place(busy(30, 20, 3), 100, 40, 'move')
  const emit = createPlaceEmitter({ cacheBytes: 0 })
  const base = emit(event, cell)
  for (const screen of [undefined, { columns: 0, rows: 0 }, { columns: 100, rows: 40 }, { columns: 200, rows: 90 }]) {
    assert.deepEqual(emit(event, cell, screen), base, JSON.stringify(screen))
  }
  assert.deepEqual(raster(emit(event, cell, { columns: 0, rows: 24 })).slice(2), [800, 384])
  assert.deepEqual(raster(emit(event, cell, { columns: 80, rows: 0 })).slice(2), [640, 640])
})

test('a capped box is clipped in screen pixels', () => {
  // 1000x1000 cells of 10x20 scale to a capped box under 8192 a side; the
  // screen still shows 800x480 pixels of it.
  const cell = { width: 10, height: 20 }
  const out = createPlaceEmitter({ scale: 'nearest' })(place(busy(16, 16, 4), 1000, 1000, 'stay'), cell, { columns: 80, rows: 24 })
  assert.deepEqual(raster(out).slice(2), [800, 480])
})

test('repeated puts of the same image reuse the encoded bytes', () => {
  const cell = { width: 10, height: 20 }
  const screen = { columns: 80, rows: 24 }
  const image = busy(64, 32, 5)
  const emit = createPlaceEmitter()
  const first = emit(place(image, 819, 400, 'move'), cell, screen)
  assert.equal(emit(place(image, 819, 400, 'move'), cell, { ...screen }), first, 'same image, box, cell and screen')
  // Anything the bytes depend on misses: cell size, screen, box, cursor policy, image object.
  for (const other of [
    emit(place(image, 819, 400, 'move'), { width: 9, height: 20 }, screen),
    emit(place(image, 819, 400, 'move'), cell, { columns: 70, rows: 24 }),
    emit(place(image, 818, 400, 'move'), cell, screen),
    emit(place(image, 819, 400, 'stay'), cell, screen),
    emit(place({ ...image }, 819, 400, 'move'), cell, screen),
  ]) {
    assert.notEqual(other, first)
  }
  assert.deepEqual(emit(place({ ...image }, 819, 400, 'move'), cell, screen), first, 'a copy encodes the same')
  // A screen that grew past the box still hits (nothing more is visible).
  const small = place(image, 4, 2, 'move')
  const a = emit(small, cell, screen)
  assert.equal(emit(small, cell, { columns: 200, rows: 60 }), a)
  assert.equal(emit(small, cell), a)
})

test('the cache is bounded: least recently used first out, oversized outputs never kept', () => {
  const cell = { width: 8, height: 16 }
  const a = place(busy(8, 8, 6), 4, 2, 'stay')
  const b = place(busy(8, 8, 7), 4, 2, 'stay')
  const size = createPlaceEmitter({ cacheBytes: 0 })(a, cell).length
  const emit = createPlaceEmitter({ cacheBytes: Math.floor(size * 1.5) })
  const a1 = emit(a, cell)
  assert.equal(emit(a, cell), a1)
  emit(b, cell) // evicts a
  assert.notEqual(emit(a, cell), a1)
  const none = createPlaceEmitter({ cacheBytes: 0 })
  assert.notEqual(none(a, cell), none(a, cell))
  const tight = createPlaceEmitter({ cacheBytes: size - 1 })
  assert.notEqual(tight(a, cell), tight(a, cell))
})
