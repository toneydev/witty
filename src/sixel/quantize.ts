// Reduces an RGBA bitmap to an indexed one with at most 256 palette entries.
//
// Pixels with alpha below the threshold are "transparent" and get the
// sentinel index `transparentIndex`, which is never a palette slot.
//
// 1. Exact path: if the opaque pixels use few enough distinct RGB values they
//    become the palette as-is, in order of first appearance (row-major), and
//    every pixel maps to its own colour. Sprites and icons stay pixel-exact.
// 2. Otherwise median cut: the opaque pixels are histogrammed at 6 bits per
//    channel; boxes of histogram cells are split repeatedly (always the box
//    with the largest population-weighted squared error along its widest
//    axis, at the weighted median of that axis) until there are enough boxes;
//    each box's palette colour is the mean of the pixels in it. Pixels are
//    then mapped to the nearest palette colour (squared RGB distance, lowest
//    index on ties), cached per 6-bit histogram cell (the cell's centre is
//    matched), so each cell is searched once.
//
// The per-cell tables are allocated once and only the cells an image uses
// are touched (and reset after): allocating and scanning all 2^18 cells per
// call cost more than quantizing a placeholder strip itself.
//
// Everything is deterministic: same input, same output.

import type { Rgba } from '../types.ts'

/** The result of {@link quantize}. */
export type Quantized = {
  /** RGB triples, 3 bytes per palette entry; `palette.length / 3` entries. */
  palette: Uint8Array
  /** One palette index per pixel, row-major; `transparentIndex` for transparent pixels. */
  indices: Uint8Array
  /**
   * The index given to transparent pixels: always >= the palette size, so it
   * names no colour. It is 255 whenever the palette has <= 255 entries (the
   * palette is capped at 255 entries when any pixel is transparent, so then it
   * is always 255); only an image with no transparent pixels and exactly 256
   * colours gets 256, which then occurs nowhere in `indices`.
   */
  transparentIndex: number
}

export type QuantizeOptions = {
  /** Pixels with alpha < this are transparent. Default 128; 0 makes every pixel opaque. */
  alphaThreshold?: number
}

const BITS = 6
const SHIFT = 8 - BITS
const LEVELS = 1 << BITS
const CELLS = LEVELS * LEVELS * LEVELS

/**
 * Quantizes `image` to at most `maxColors` (clamped to 1..256) palette
 * entries; see the module comment for the method. When any pixel is
 * transparent the palette holds at most 255 entries so index 255 is free for
 * transparency.
 */
export function quantize(image: Rgba, maxColors: number, opts: QuantizeOptions = {}): Quantized {
  const threshold = opts.alphaThreshold ?? 128
  const data = image.data
  const count = image.width * image.height
  const indices = new Uint8Array(count)

  let hasTransparent = false
  for (let i = 0; i < count; i++) {
    if (data[i * 4 + 3]! < threshold) {
      hasTransparent = true
      break
    }
  }
  const limit = Math.max(1, Math.min(hasTransparent ? 255 : 256, Math.floor(maxColors)))

  const exact = exactPalette(data, count, threshold, limit, indices)
  if (exact) {
    const n = exact.length / 3
    return { palette: exact, indices, transparentIndex: Math.max(255, n) }
  }

  const t = tables()
  const cells = histogram(data, count, threshold, t)
  try {
    const palette = medianCut(cells, limit, t)
    mapNearest(data, count, threshold, palette, indices, t.nearest)
    return { palette, indices, transparentIndex: 255 }
  } finally {
    // Leave the shared tables clean for the next call.
    for (const c of cells) {
      t.hist[c] = 0
      t.sumR[c] = 0
      t.sumG[c] = 0
      t.sumB[c] = 0
      t.nearest[c] = -1
    }
  }
}

/** Per-cell tables shared by every call: zero sums and counts, -1 for "not searched yet". */
type Tables = {
  hist: Float64Array
  sumR: Float64Array
  sumG: Float64Array
  sumB: Float64Array
  /** The palette index matched to each cell. */
  nearest: Int16Array
}

let shared: Tables | undefined

function tables(): Tables {
  shared ??= {
    hist: new Float64Array(CELLS),
    sumR: new Float64Array(CELLS),
    sumG: new Float64Array(CELLS),
    sumB: new Float64Array(CELLS),
    nearest: new Int16Array(CELLS).fill(-1),
  }
  return shared
}

/** Fills `indices` and returns the palette if there are <= `limit` distinct opaque colours; else null. */
function exactPalette(
  data: Uint8Array,
  count: number,
  threshold: number,
  limit: number,
  indices: Uint8Array,
): Uint8Array | null {
  const seen = new Map<number, number>()
  const colors: number[] = []
  let lastKey = -1
  let lastIndex = 0
  for (let i = 0; i < count; i++) {
    const p = i * 4
    if (data[p + 3]! < threshold) {
      indices[i] = 255
      continue
    }
    const key = (data[p]! << 16) | (data[p + 1]! << 8) | data[p + 2]!
    if (key !== lastKey) {
      let idx = seen.get(key)
      if (idx === undefined) {
        if (colors.length >= limit) return null
        idx = colors.length
        seen.set(key, idx)
        colors.push(key)
      }
      lastKey = key
      lastIndex = idx
    }
    indices[i] = lastIndex
  }
  const palette = new Uint8Array(colors.length * 3)
  for (let i = 0; i < colors.length; i++) {
    const c = colors[i]!
    palette[i * 3] = c >>> 16
    palette[i * 3 + 1] = (c >>> 8) & 255
    palette[i * 3 + 2] = c & 255
  }
  return palette
}

function cellOf(r: number, g: number, b: number): number {
  return ((r >> SHIFT) << (2 * BITS)) | ((g >> SHIFT) << BITS) | (b >> SHIFT)
}

function coord(cell: number, axis: number): number {
  return (cell >> ((2 - axis) * BITS)) & (LEVELS - 1)
}

/** A median-cut box: the cells `cells[start..end)`, its split priority and axis. */
type Box = { start: number; end: number; score: number; axis: number }

/** Histograms the opaque pixels into `t`; returns the cells used, ascending. */
function histogram(data: Uint8Array, count: number, threshold: number, t: Tables): Int32Array {
  const { hist, sumR, sumG, sumB } = t
  const cells = new Int32Array(Math.min(count, CELLS))
  let used = 0
  for (let i = 0; i < count; i++) {
    const p = i * 4
    if (data[p + 3]! < threshold) continue
    const r = data[p]!
    const g = data[p + 1]!
    const b = data[p + 2]!
    const c = cellOf(r, g, b)
    if (hist[c] === 0) cells[used++] = c
    hist[c]! += 1
    sumR[c]! += r
    sumG[c]! += g
    sumB[c]! += b
  }
  return cells.subarray(0, used).sort()
}

/** The palette for the histogrammed `cells` (reordered in place). */
function medianCut(cells: Int32Array, limit: number, t: Tables): Uint8Array {
  const { hist, sumR, sumG, sumB } = t
  const used = cells.length
  const sorted = new Int32Array(used)

  const measure = (start: number, end: number): Box => {
    if (end - start < 2) return { start, end, score: -1, axis: 0 }
    let best = -1
    let bestAxis = 0
    for (let axis = 0; axis < 3; axis++) {
      let n = 0
      let s = 0
      let s2 = 0
      for (let k = start; k < end; k++) {
        const c = cells[k]!
        const w = hist[c]!
        const v = coord(c, axis)
        n += w
        s += w * v
        s2 += w * v * v
      }
      const sse = s2 - (s * s) / n
      if (sse > best) {
        best = sse
        bestAxis = axis
      }
    }
    return { start, end, score: best, axis: bestAxis }
  }

  const boxes: Box[] = [measure(0, used)]
  const bucket = new Int32Array(LEVELS + 1)
  while (boxes.length < limit) {
    let pick = -1
    let bestScore = 0
    for (let i = 0; i < boxes.length; i++) {
      const s = boxes[i]!.score
      if (s > bestScore) {
        bestScore = s
        pick = i
      }
    }
    if (pick < 0) break
    const { start, end, axis } = boxes[pick]!

    // Stable counting sort of the box's cells along `axis`.
    bucket.fill(0)
    let total = 0
    for (let k = start; k < end; k++) {
      const c = cells[k]!
      bucket[coord(c, axis) + 1]!++
      total += hist[c]!
    }
    for (let v = 0; v < LEVELS; v++) bucket[v + 1]! += bucket[v]!
    for (let k = start; k < end; k++) {
      const c = cells[k]!
      sorted[start + bucket[coord(c, axis)]!++] = c
    }
    cells.set(sorted.subarray(start, end), start)

    // Split at the weighted median, keeping both halves non-empty.
    let acc = 0
    let split = end - 1
    for (let k = start; k < end - 1; k++) {
      acc += hist[cells[k]!]!
      if (acc * 2 >= total) {
        split = k + 1
        break
      }
    }
    boxes[pick] = measure(start, split)
    boxes.push(measure(split, end))
  }

  const palette = new Uint8Array(boxes.length * 3)
  for (let i = 0; i < boxes.length; i++) {
    const { start, end } = boxes[i]!
    let n = 0
    let r = 0
    let g = 0
    let b = 0
    for (let k = start; k < end; k++) {
      const c = cells[k]!
      n += hist[c]!
      r += sumR[c]!
      g += sumG[c]!
      b += sumB[c]!
    }
    palette[i * 3] = Math.round(r / n)
    palette[i * 3 + 1] = Math.round(g / n)
    palette[i * 3 + 2] = Math.round(b / n)
  }
  return palette
}

function mapNearest(
  data: Uint8Array,
  count: number,
  threshold: number,
  palette: Uint8Array,
  indices: Uint8Array,
  cache: Int16Array,
): void {
  const n = palette.length / 3
  const half = (1 << SHIFT) / 2 - 0.5
  const byRed = Int32Array.from({ length: n }, (_, k) => k).sort((a, b) => palette[a * 3]! - palette[b * 3]! || a - b)
  const reds = Int32Array.from(byRed, (k) => palette[k * 3]!)
  for (let i = 0; i < count; i++) {
    const p = i * 4
    if (data[p + 3]! < threshold) {
      indices[i] = 255
      continue
    }
    const c = cellOf(data[p]!, data[p + 1]!, data[p + 2]!)
    let idx = cache[c]!
    if (idx < 0) {
      const r = (coord(c, 0) << SHIFT) + half
      const g = (coord(c, 1) << SHIFT) + half
      const b = (coord(c, 2) << SHIFT) + half
      idx = nearestIndex(palette, byRed, reds, r, g, b)
      cache[c] = idx
    }
    indices[i] = idx
  }
}

/**
 * The palette entry nearest `r`,`g`,`b` (squared distance, lowest index on
 * ties), searched outwards from `r` in red order (`byRed`, with `reds` their
 * reds) until red alone is at least the best distance on both sides. That
 * stop is exact for cell centres: they sit between channel values, so green
 * and blue always add to the distance and a stopped entry could not even tie.
 */
function nearestIndex(palette: Uint8Array, byRed: Int32Array, reds: Int32Array, r: number, g: number, b: number): number {
  const n = reds.length
  let up = 0
  let down = n
  while (up < down) {
    const mid = (up + down) >>> 1
    if (reds[mid]! < r) up = mid + 1
    else down = mid
  }
  down = up - 1
  let best = Infinity
  let idx = 0
  while (up < n || down >= 0) {
    let k: number
    // Step to the side whose red is closer; once it is out of reach, so is the other.
    if (up < n && (down < 0 || reds[up]! - r <= r - reds[down]!)) {
      const dr = reds[up]! - r
      if (dr * dr >= best) break
      k = byRed[up++]!
    } else {
      const dr = r - reds[down]!
      if (dr * dr >= best) break
      k = byRed[down--]!
    }
    const dr = palette[k * 3]! - r
    const dg = palette[k * 3 + 1]! - g
    const db = palette[k * 3 + 2]! - b
    const d = dr * dr + dg * dg + db * db
    if (d < best || (d === best && k < idx)) {
      best = d
      idx = k
    }
  }
  return idx
}
