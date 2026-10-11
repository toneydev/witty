// Turns a `place` event into the bytes written to the outer terminal:
//
//   ESC 7  <sixel DCS>  ESC 8  [CSI (rows-1) B]  [CSI columns C]
//
// DECSC/DECRC bracket the image because sixel terminals disagree about where
// the cursor ends up after one. With kitty's default cursor policy ('move')
// the cursor is then moved to the cell right of the image's bottom-right
// cell; with 'stay' it is left where it was.
//
// encodePlaceholderStrip does the same for one strip of unicode placeholder
// cells (see src/term/placeholders.ts).

import type { CellSize, PlaceEmitter, Rgba, ScaleMode, SixelOptions } from '../types.ts'
import { resizeRgba } from '../image/resize.ts'
import { encodeSixelBytes } from '../sixel/encode.ts'

const SAVE = [0x1b, 0x37] // ESC 7
const RESTORE = [0x1b, 0x38] // ESC 8

/** Emitter options: the sixel encoder's, plus how images are scaled to their box. */
export type EmitOptions = SixelOptions & {
  /** Scaling policy (see `ScaleMode`). Default 'auto'. */
  scale?: ScaleMode
}

/** The sixel encoder options within `opts` (without `scale`). */
function sixelOptionsOf(opts: EmitOptions): SixelOptions {
  const { scale: _scale, ...sixel } = opts
  return sixel
}

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
 * Makes a {@link PlaceEmitter} that scales each placed image to fill its
 * cell box exactly (aspect not preserved, as kitty does when both `c` and `r`
 * are given) with `opts.scale`, encodes it as sixel with the rest of `opts`,
 * and wraps it in cursor save/restore plus the movement its cursor policy
 * asks for.
 */
export function createPlaceEmitter(opts: EmitOptions = {}): PlaceEmitter {
  const sixelOptions = sixelOptionsOf(opts)
  return (event, cell) => {
    const columns = Math.max(1, Math.round(event.columns))
    const rows = Math.max(1, Math.round(event.rows))
    const image = scaleToBox(event.image, columns, rows, cell, opts.scale)
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
    return out
  }
}

/** The default emitter: 256-colour palette, transparency on, 'auto' scaling. */
export const emitPlacement: PlaceEmitter = createPlaceEmitter()

/**
 * The bytes that stand in for `cells` unicode placeholder cells at the
 * cursor, drawing `strip` (already `cells * cell.width` × `cell.height`
 * pixels) over them:
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
