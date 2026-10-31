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
//    matched), so each cell is searched once. The search is exact either way
//    it runs (see nearestSearch): outwards in red order, or, in blocks of
//    cells the image uses many of (a photo uses most of the 2^18 cells),
//    through the block's short list of entries that can be nearest in it.
//
// The per-cell tables are allocated once and only the cells an image uses
// are touched (and reset after, one by one, or all at once when it used a
// sixteenth of them or more): allocating and scanning all 2^18 cells per
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
  // A non-finite maxColors (NaN) would make every comparison false and lift the cap.
  const requested = Number.isFinite(maxColors) ? Math.floor(maxColors) : 256
  const limit = Math.max(1, Math.min(hasTransparent ? 255 : 256, requested))

  const exact = exactPalette(data, count, threshold, limit, indices)
  if (exact) {
    const n = exact.length / 3
    return { palette: exact, indices, transparentIndex: Math.max(255, n) }
  }

  const t = tables()
  const cells = histogram(data, count, threshold, t)
  try {
    const palette = medianCut(cells, limit, t)
    mapNearest(data, count, threshold, palette, indices, t.nearest, cells)
    return { palette, indices, transparentIndex: Math.max(255, palette.length / 3) }
  } finally {
    // Leave the shared tables clean for the next call: cell by cell, or all
    // at once when the image used so many cells that that is cheaper.
    const { stats, nearest } = t
    if (cells.length * 16 >= CELLS) {
      stats.fill(0)
      nearest.fill(-1)
    } else {
      for (const c of cells) {
        const o = c * 4
        stats[o] = 0
        stats[o + 1] = 0
        stats[o + 2] = 0
        stats[o + 3] = 0
        nearest[c] = -1
      }
    }
  }
}

/** Per-cell tables shared by every call: zero counts and sums, -1 for "not searched yet". */
type Tables = {
  /**
   * Cell c's pixel count at `c * 4`, then the sums of their red, green and
   * blue. One array rather than four: a pixel touches one cache line, not four
   * (histogramming a photo, 2^18 cells spread over 8 MiB, took 10 ms with
   * separate arrays).
   */
  stats: Float64Array
  /** The palette index matched to each cell. */
  nearest: Int16Array
}

let shared: Tables | undefined

function tables(): Tables {
  shared ??= {
    stats: new Float64Array(CELLS * 4),
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
  const { stats } = t
  const cells = new Int32Array(Math.min(count, CELLS))
  let used = 0
  for (let i = 0; i < count; i++) {
    const p = i * 4
    if (data[p + 3]! < threshold) continue
    const r = data[p]!
    const g = data[p + 1]!
    const b = data[p + 2]!
    const c = cellOf(r, g, b)
    const o = c * 4
    if (stats[o] === 0) cells[used++] = c
    stats[o]! += 1
    stats[o + 1]! += r
    stats[o + 2]! += g
    stats[o + 3]! += b
  }
  // Ascending: sorting costs O(used log used) (10 ms for the 212k cells of a
  // 1500x900 photo), scanning the table O(CELLS) (about 1 ms); scan once the
  // image uses more than a sixteenth of the cells.
  if (used * 16 < CELLS) return cells.subarray(0, used).sort()
  let k = 0
  for (let c = 0; c < CELLS; c++) if (stats[c * 4] !== 0) cells[k++] = c
  return cells.subarray(0, used)
}

/** The palette for the histogrammed `cells` (reordered in place). */
function medianCut(cells: Int32Array, limit: number, t: Tables): Uint8Array {
  const { stats } = t
  const used = cells.length
  const sorted = new Int32Array(used)

  // The squared error of each axis, all three in one pass over the cells.
  const measure = (start: number, end: number): Box => {
    if (end - start < 2) return { start, end, score: -1, axis: 0 }
    let n = 0
    let s0 = 0
    let s1 = 0
    let s2 = 0
    let q0 = 0
    let q1 = 0
    let q2 = 0
    for (let k = start; k < end; k++) {
      const c = cells[k]!
      const w = stats[c * 4]!
      const v0 = coord(c, 0)
      const v1 = coord(c, 1)
      const v2 = coord(c, 2)
      n += w
      s0 += w * v0
      q0 += w * v0 * v0
      s1 += w * v1
      q1 += w * v1 * v1
      s2 += w * v2
      q2 += w * v2 * v2
    }
    const e0 = q0 - (s0 * s0) / n
    const e1 = q1 - (s1 * s1) / n
    const e2 = q2 - (s2 * s2) / n
    // The first axis wins ties, as when they were measured one by one.
    let best = -1
    let bestAxis = 0
    if (e0 > best) {
      best = e0
      bestAxis = 0
    }
    if (e1 > best) {
      best = e1
      bestAxis = 1
    }
    if (e2 > best) {
      best = e2
      bestAxis = 2
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
      total += stats[c * 4]!
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
      acc += stats[cells[k]! * 4]!
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
      const o = cells[k]! * 4
      n += stats[o]!
      r += stats[o + 1]!
      g += stats[o + 2]!
      b += stats[o + 3]!
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
  cells: Int32Array,
): void {
  // Cells per block: a block with enough of them gets a candidate list.
  let listed = (_block: number): boolean => false
  if (cells.length >= LIST_CELLS) {
    const perBlock = new Uint32Array(BLOCKS * BLOCKS * BLOCKS)
    for (let k = 0; k < cells.length; k++) perBlock[blockOf(cells[k]!)]!++
    listed = (block) => perBlock[block]! >= LIST_CELLS
  }
  const nearest = nearestSearch(palette, listed)
  for (let i = 0; i < count; i++) {
    const p = i * 4
    if (data[p + 3]! < threshold) {
      indices[i] = 255
      continue
    }
    const c = cellOf(data[p]!, data[p + 1]!, data[p + 2]!)
    let idx = cache[c]!
    if (idx < 0) {
      idx = nearest(c)
      cache[c] = idx
    }
    indices[i] = idx
  }
}

/** Histogram levels per side of a block of cells in {@link nearestSearch}: 4, so 16^3 blocks. */
const BLOCK = 4
const BLOCKS = LEVELS / BLOCK

/**
 * The cells an image must use in a block for the block to get a candidate
 * list. Building a list is one pass over the palette, about the cost of 11
 * red-order searches (which visit ~40 of 256 entries on a photo), and then a
 * cell visits ~4 entries, so a list pays from about a dozen cells. A
 * placeholder strip uses a few cells per block and keeps the red-order search
 * (lists for every block made a 75x20 strip 9x slower); a 1500x900 photo uses
 * 212k of the 2^18 cells, and its mapping drops from 47 to about 15 ms.
 */
const LIST_CELLS = 16

/** The block of BLOCK³ cells that `cell` lies in. */
function blockOf(cell: number): number {
  return (
    (Math.floor(coord(cell, 0) / BLOCK) * BLOCKS + Math.floor(coord(cell, 1) / BLOCK)) * BLOCKS + Math.floor(coord(cell, 2) / BLOCK)
  )
}

const EMPTY = new Float64Array(0)

/** The 0..255 value at the centre of 6-bit level `v`. */
function centre(v: number): number {
  return (v << SHIFT) + (1 << SHIFT) / 2 - 0.5
}

/**
 * Finds the palette entry nearest a histogram cell's centre (squared
 * distance, lowest index on ties). Exported for tests.
 *
 * Cells of a block for which `listed(block)` is false are searched outwards
 * in red order ({@link nearestIndex}). A listed block (of BLOCK³ cells) gets
 * a candidate list on its first query: the entries whose distance to the nearest point of
 * the block (the box spanned by its cell centres) is at most the smallest
 * farthest-point distance of any entry. Every entry is within its
 * farthest-point distance of any centre in the block, so the nearest entry
 * of a centre, and every entry tied with it, is within that bound and on the
 * list; scanning the list in index order gives the same answer as the full
 * search. Locally sorted search, after Heckbert's median-cut paper.
 */
export function nearestSearch(palette: Uint8Array, listed: (block: number) => boolean): (cell: number) => number {
  const n = palette.length / 3
  const byRed = Int32Array.from({ length: n }, (_, k) => k).sort((a, b) => palette[a * 3]! - palette[b * 3]! || a - b)
  const reds = Int32Array.from(byRed, (k) => palette[k * 3]!)
  // Per block: its candidate list, RED for the red-order search, undefined until first asked.
  const lists: (Int16Array | undefined)[] = new Array(BLOCKS * BLOCKS * BLOCKS)
  const RED = new Int16Array(0)
  const nearDistance = new Float64Array(n)
  // Per axis and block coordinate q (the slab of cells q*BLOCK .. q*BLOCK +
  // BLOCK-1 on that axis), each entry's squared distance along the axis to
  // the nearest and to the farthest cell centre of the slab, at
  // `(axis * BLOCKS + q) * n + k`. A block's distances are then three
  // lookups per entry, summed in axis order as when they were computed per
  // block, so the lists are the same. Each slab is filled when a list first
  // needs it, so an image with few listed blocks (a placeholder strip lists
  // none or a handful) does no more work than computing per block.
  let near = EMPTY
  let far = EMPTY
  const filled = new Uint8Array(3 * BLOCKS)
  const span = (BLOCK - 1) << SHIFT
  /** Where slab `q` of `axis` starts in `near` and `far`, filled first if it was not yet. */
  const slab = (axis: number, q: number): number => {
    const s = axis * BLOCKS + q
    const row = s * n
    if (filled[s] === 1) return row
    filled[s] = 1
    if (near.length === 0) {
      near = new Float64Array(3 * BLOCKS * n)
      far = new Float64Array(3 * BLOCKS * n)
    }
    const lo = centre(q * BLOCK)
    const hi = lo + span
    for (let k = 0; k < n; k++) {
      const v = palette[k * 3 + axis]!
      const d = v < lo ? lo - v : v > hi ? v - hi : 0
      near[row + k] = d * d
      const f = v - lo > hi - v ? v - lo : hi - v
      far[row + k] = f * f
    }
    return row
  }

  const listOf = (block: number): Int16Array => {
    const r0 = slab(0, Math.floor(block / (BLOCKS * BLOCKS)))
    const g0 = slab(1, Math.floor(block / BLOCKS) % BLOCKS)
    const b0 = slab(2, block % BLOCKS)
    let bound = Infinity
    for (let k = 0; k < n; k++) {
      nearDistance[k] = near[r0 + k]! + near[g0 + k]! + near[b0 + k]!
      const farthest = far[r0 + k]! + far[g0 + k]! + far[b0 + k]!
      if (farthest < bound) bound = farthest
    }
    let size = 0
    for (let k = 0; k < n; k++) if (nearDistance[k]! <= bound) size++
    const list = new Int16Array(size)
    size = 0
    for (let k = 0; k < n; k++) if (nearDistance[k]! <= bound) list[size++] = k
    return list
  }

  return (cell: number): number => {
    const v0 = coord(cell, 0)
    const v1 = coord(cell, 1)
    const v2 = coord(cell, 2)
    const r = centre(v0)
    const g = centre(v1)
    const b = centre(v2)
    const block = (Math.floor(v0 / BLOCK) * BLOCKS + Math.floor(v1 / BLOCK)) * BLOCKS + Math.floor(v2 / BLOCK)
    let list = lists[block]
    if (list === undefined) {
      list = listed(block) ? listOf(block) : RED
      lists[block] = list
    }
    if (list === RED) return nearestIndex(palette, byRed, reds, r, g, b)
    let best = Infinity
    let idx = 0
    for (let j = 0; j < list.length; j++) {
      const k = list[j]!
      const dr = palette[k * 3]! - r
      const dg = palette[k * 3 + 1]! - g
      const db = palette[k * 3 + 2]! - b
      const d = dr * dr + dg * dg + db * db
      if (d < best) {
        best = d
        idx = k
      }
    }
    return idx
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
