// Turns a `place` event into the bytes written to the outer terminal:
//
//   ESC 7  <sixel DCS>  ESC 8  [CSI (rows-1) B]  [CSI columns C]
//
// DECSC/DECRC bracket the image because sixel terminals disagree about where
// the cursor ends up after one. With kitty's default cursor policy ('move')
// the cursor is then moved to the cell right of the image's bottom-right
// cell; with 'stay' it is left where it was.
//
// A placement never draws more than the screen can show: with a known screen
// size the sixel covers at most min(columns, screen columns) × min(rows,
// screen rows) cells, the top-left part of what the whole box would show,
// cropped as kitty clips at the screen edge. Only that part is scaled (the
// same filter taps as scaling the whole box, see resizeRegion) and encoded,
// so a ~30-byte `a=p,c=1000,r=1000` costs at most a screenful of sixel. The
// cursor still moves past the whole box. Encoded placements are cached per
// source image (the engine passes the same `Rgba` for every uncropped put of
// an image) within a byte budget, so repeated puts are not re-encoded.
//
// encodePlaceholderStrip does the same for one strip of unicode placeholder
// cells (see src/term/placeholders.ts).

import type { CellSize, PlaceEmitter, Rgba, ScaleMode, ScreenSize, SixelOptions } from '../types.ts'
import { resizeRegion, resizeRgba } from '../image/resize.ts'
import { encodeSixelBytes } from '../sixel/encode.ts'

const SAVE = [0x1b, 0x37] // ESC 7
const RESTORE = [0x1b, 0x38] // ESC 8

/** Emitter options: the sixel encoder's, plus how images are scaled to their box. */
export type EmitOptions = SixelOptions & {
  /** Scaling policy (see `ScaleMode`). Default 'auto'. */
  scale?: ScaleMode
  /** Byte budget of the emitter's cache of encoded placements (0 disables it). Default {@link PLACE_CACHE_BYTES}. */
  cacheBytes?: number
}

/** The sixel encoder options within `opts` (without `scale` and `cacheBytes`). */
function sixelOptionsOf(opts: EmitOptions): SixelOptions {
  const { scale: _scale, cacheBytes: _cacheBytes, ...sixel } = opts
  return sixel
}

/**
 * Default byte budget of an emitter's placement cache. Busy images encode at
 * up to ~4.4 bytes per pixel, so this holds three worst-case 1920x1080
 * screenfuls, or thousands of the small images Claude Code draws, while
 * staying well under the 256 MiB image store. An output larger than the
 * budget is not cached.
 */
export const PLACE_CACHE_BYTES = 32 * 1024 * 1024

/** Largest side of any scaled image, in pixels. */
export const MAX_BOX_SIDE = 8192
/** Largest area of any scaled image, in pixels (64 MiB of RGBA). */
export const MAX_BOX_PIXELS = 16_777_216

/**
 * The pixel box of `columns` × `rows` cells: `round(columns * cw)` ×
 * `round(rows * ch)` (each side at least 1), and the cell size to cut it by.
 * A box over {@link MAX_BOX_SIDE} on a side or {@link MAX_BOX_PIXELS} in area
 * is scaled down proportionally (the image then draws smaller than its
 * cells), and `cell` is shrunk to match so strips still tile it exactly.
 */
export function placementGeometry(columns: number, rows: number, cell: CellSize): { width: number; height: number; cell: CellSize } {
  const width = Math.max(1, Math.round(columns * cell.width))
  const height = Math.max(1, Math.round(rows * cell.height))
  if (width <= MAX_BOX_SIDE && height <= MAX_BOX_SIDE && width * height <= MAX_BOX_PIXELS) return { width, height, cell }
  const f = Math.min(MAX_BOX_SIDE / width, MAX_BOX_SIDE / height, Math.sqrt(MAX_BOX_PIXELS / (width * height)))
  const w = Math.max(1, Math.floor(width * f))
  const h = Math.max(1, Math.floor(height * f))
  return { width: w, height: h, cell: { width: w / Math.max(1, columns), height: h / Math.max(1, rows) } }
}

/** The (capped) pixel box of `columns` × `rows` cells, see {@link placementGeometry}. */
export function placementBox(columns: number, rows: number, cell: CellSize): { width: number; height: number } {
  const { width, height } = placementGeometry(columns, rows, cell)
  return { width, height }
}

/** `image` scaled to fill `columns` × `rows` cells exactly with `mode` (itself when it already fits). */
export function scaleToBox(image: Rgba, columns: number, rows: number, cell: CellSize, mode: ScaleMode = 'auto'): Rgba {
  const box = placementBox(columns, rows, cell)
  if (image.width === box.width && image.height === box.height) return image
  return resizeRgba(image, box.width, box.height, { mode })
}

/**
 * Encoded placements by source image (weakly, so a dropped image takes its
 * entries' keys with it) and by everything else the bytes depend on, least
 * recently used evicted first once they pass `budget` bytes. Evicted bytes
 * are released at once; bytes of an image that was dropped stay until
 * evicted, so the budget bounds them too.
 */
class PlaceCache {
  readonly #byImage = new WeakMap<Rgba, Map<string, Uint8Array>>()
  /** Every cached output, least recently used first, with the map and key it is filed under. */
  readonly #order = new Map<Uint8Array, { owner: Map<string, Uint8Array>; key: string }>()
  #bytes = 0
  readonly budget: number

  constructor(budget: number) {
    this.budget = budget
  }

  get(image: Rgba, key: string): Uint8Array | undefined {
    const out = this.#byImage.get(image)?.get(key)
    if (out === undefined) return undefined
    const entry = this.#order.get(out)!
    this.#order.delete(out)
    this.#order.set(out, entry)
    return out
  }

  set(image: Rgba, key: string, out: Uint8Array): void {
    if (out.length > this.budget) return
    let owner = this.#byImage.get(image)
    if (owner === undefined) {
      owner = new Map()
      this.#byImage.set(image, owner)
    }
    owner.set(key, out)
    this.#order.set(out, { owner, key })
    this.#bytes += out.length
    for (const [bytes, entry] of this.#order) {
      if (this.#bytes <= this.budget) break
      this.#order.delete(bytes)
      entry.owner.delete(entry.key)
      this.#bytes -= bytes.length
    }
  }
}

/** How many of `count` cells fit in `screen` cells (all of them when the screen size is unknown). */
function visibleCells(count: number, screen: number | undefined): number {
  return screen !== undefined && screen > 0 ? Math.min(count, Math.max(1, Math.floor(screen))) : count
}

/**
 * Makes a {@link PlaceEmitter} that scales each placed image to fill its
 * cell box exactly (aspect not preserved, as kitty does when both `c` and `r`
 * are given) with `opts.scale`, encodes it as sixel with the rest of `opts`,
 * and wraps it in cursor save/restore plus the movement its cursor policy
 * asks for.
 *
 * With a known `screen` size, a box wider or taller than the screen is
 * clipped: only its top-left `min(columns, screen.columns)` ×
 * `min(rows, screen.rows)` cells are drawn, at the pixels the whole box would
 * show there (`round(cells * cell size)`, within the capped box of
 * {@link placementGeometry}). The cursor still moves past the whole box.
 *
 * Outputs are cached per `event.image` object (see {@link PlaceCache}) under
 * its box, cell size, visible cells and cursor policy, within
 * `opts.cacheBytes`; a hit returns the same `Uint8Array`, which callers must
 * not modify.
 */
export function createPlaceEmitter(opts: EmitOptions = {}): PlaceEmitter {
  const sixelOptions = sixelOptionsOf(opts)
  const cache = new PlaceCache(opts.cacheBytes ?? PLACE_CACHE_BYTES)
  return (event, cell, screen?: ScreenSize) => {
    const columns = Math.max(1, Math.round(event.columns))
    const rows = Math.max(1, Math.round(event.rows))
    const shownColumns = visibleCells(columns, screen?.columns)
    const shownRows = visibleCells(rows, screen?.rows)
    const key = `${columns},${rows},${cell.width},${cell.height},${shownColumns},${shownRows},${event.cursor}`
    const cached = cache.get(event.image, key)
    if (cached !== undefined) return cached

    const box = placementGeometry(columns, rows, cell)
    const width = shownColumns < columns ? Math.min(box.width, Math.max(1, Math.round(shownColumns * cell.width))) : box.width
    const height = shownRows < rows ? Math.min(box.height, Math.max(1, Math.round(shownRows * cell.height))) : box.height
    const image =
      width === box.width && height === box.height
        ? scaleToBox(event.image, columns, rows, cell, opts.scale)
        : resizeRegion(event.image, box.width, box.height, width, height, { mode: opts.scale ?? 'auto' })
    const sixel = encodeSixelBytes(image, sixelOptions)

    let tail = String.fromCharCode(...RESTORE)
    if (event.cursor === 'move') {
      if (rows > 1) tail += `\x1b[${rows - 1}B`
      tail += `\x1b[${columns}C`
    }

    const out = new Uint8Array(SAVE.length + sixel.length + tail.length)
    out.set(SAVE, 0)
    out.set(sixel, SAVE.length)
    for (let i = 0; i < tail.length; i++) out[SAVE.length + sixel.length + i] = tail.charCodeAt(i)
    cache.set(event.image, key, out)
    return out
  }
}

/** The default emitter: 256-colour palette, transparency on, 'auto' scaling. */
export const emitPlacement: PlaceEmitter = createPlaceEmitter()

/**
 * The bytes that stand in for `cells` unicode placeholder cells at the
 * cursor, drawing `strip` (already cut to the cells it covers: all of them,
 * or the leading ones inside the placement's box) over them:
 *
 *   ESC 7  <cells spaces>  ESC 8  <sixel DCS>  ESC 8  CSI cells C
 *
 * The spaces clear whatever glyphs were in those cells, with the current
 * attributes (the background shows through transparent pixels). DECRC, not
 * `CSI cells D`, returns to the strip start: after spaces that end in the
 * last column the cursor is in its pending-wrap state there, and moving left
 * from it would land one cell short. The final `CSI cells C` leaves the
 * cursor where printing the cells would have.
 *
 * The strip is cut from the placement's image after it was scaled to the
 * whole box (with {@link scaleToBox} and the same `opts.scale`), so it is not
 * scaled again here: scaling strips one by one would blur or misalign their
 * seams. Only the sixel options of `opts` apply.
 */
export function encodePlaceholderStrip(strip: Rgba, cells: number, opts: EmitOptions = {}): Uint8Array {
  const n = Math.max(1, Math.round(cells))
  const sixel = encodeSixelBytes(strip, sixelOptionsOf(opts))
  const head = `\x1b7${' '.repeat(n)}\x1b8`
  const tail = `\x1b8\x1b[${n}C`
  const out = new Uint8Array(head.length + sixel.length + tail.length)
  for (let i = 0; i < head.length; i++) out[i] = head.charCodeAt(i)
  out.set(sixel, head.length)
  for (let i = 0; i < tail.length; i++) out[head.length + sixel.length + i] = tail.charCodeAt(i)
  return out
}
