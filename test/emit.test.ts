import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_BOX_PIXELS, MAX_BOX_SIDE, createPlaceEmitter, emitPlacement, placementGeometry, scaleToBox } from '../src/term/emit.ts'
import { decodeSixel } from './helpers/sixel-decoder.ts'
import { make, pixel, solid } from './helpers/images.ts'
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
