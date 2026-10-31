// Scales an RGBA bitmap to an exact pixel box, or computes only the top-left
// region of that scaled box.
//
// Two modes. 'nearest' copies the source pixel under each destination pixel's
// centre: sharp blocks, for pixel art, icons and sprites. 'smooth' filters.
// 'auto' (default) uses nearest when the image grows 2x or more on both axes
// and smooth otherwise, so downscales and small enlargements stay smooth.
//
// Smooth: each axis is filtered on its own (separable): an axis that shrinks uses a
// box filter (every destination pixel is the area-weighted average of the
// source pixels it covers), an axis that grows uses bilinear interpolation
// between pixel centres (edges clamped), and an axis that keeps its size is
// copied. Colour is filtered premultiplied by alpha so transparent pixels do
// not bleed their (usually black) colour into the edges of opaque ones, and is
// un-premultiplied on output.
//
// Regions. resizeRegion computes the top-left rw × rh pixels of the dw × dh
// result (a placement clipped at the screen edge, src/term/emit.ts) with the
// same taps, reading only the sx × sy source rectangle they touch. The whole
// resize is the region that is the whole box.
//
// Cost. The source is untrusted and need not resemble the box: a decoded image
// may be up to 64 MiB of RGBA in any shape (say 256 × 65536), and only the
// destination is capped (src/term/emit.ts). The two passes commute, so the
// first pass is whichever axis gives the smaller intermediate, min(rw × sy,
// sx × rh) float pixels, never their cross product (8 GiB for 256 × 65536 into
// 8192 × 20 if the horizontal pass always ran first). That minimum is at most
// max(sx × sy, rw × rh) (the two products multiply to the same thing), so
// scratch memory stays within 4x the larger of the source rectangle's and the
// region's RGBA bytes (16-byte float pixels), and the work within a small
// multiple of their pixel counts. The source is premultiplied as each pixel is
// read, not copied whole.

import type { Rgba, ScaleMode } from '../types.ts'

/** Filter taps for one axis: destination i reads `index[k]` × `weight[k]` for k in `[offset[i], offset[i+1])`. */
type Taps = { offset: Int32Array; index: Int32Array; weight: Float64Array }

/** The taps of destination pixels `0..n-1` when scaling `src` pixels to `dst`. */
function axisTaps(src: number, dst: number, n: number): Taps {
  const index: number[] = []
  const weight: number[] = []
  const offset = new Int32Array(n + 1)
  if (dst === src) {
    for (let i = 0; i < n; i++) {
      offset[i] = i
      index.push(i)
      weight.push(1)
    }
  } else if (dst < src) {
    // Box filter: destination pixel i covers source interval [i*s, (i+1)*s).
    const scale = src / dst
    for (let i = 0; i < n; i++) {
      offset[i] = index.length
      const lo = i * scale
      const hi = Math.min(src, (i + 1) * scale)
      for (let j = Math.floor(lo); j < Math.ceil(hi); j++) {
        const overlap = Math.min(hi, j + 1) - Math.max(lo, j)
        if (overlap > 1e-9) {
          index.push(j)
          weight.push(overlap / scale)
        }
      }
    }
  } else {
    // Bilinear: map destination pixel centres onto source pixel centres.
    const scale = src / dst
    for (let i = 0; i < n; i++) {
      offset[i] = index.length
      const x = (i + 0.5) * scale - 0.5
      if (x <= 0) {
        index.push(0)
        weight.push(1)
      } else if (x >= src - 1) {
        index.push(src - 1)
        weight.push(1)
      } else {
        const j = Math.floor(x)
        const f = x - j
        index.push(j)
        weight.push(1 - f)
        if (f > 0) {
          index.push(j + 1)
          weight.push(f)
        }
      }
    }
  }
  offset[n] = index.length
  return { offset, index: Int32Array.from(index), weight: Float64Array.from(weight) }
}

/** How many source pixels `taps` reach into: one past the highest index read. */
function tapExtent(taps: Taps): number {
  let max = 0
  for (const i of taps.index) if (i > max) max = i
  return max + 1
}

export type ResizeOptions = {
  /** Scaling policy (see `ScaleMode`). Default 'auto'. */
  mode?: ScaleMode
}

/** The enlargement factor, on both axes, from which 'auto' samples nearest. */
export const AUTO_NEAREST_FACTOR = 2

/** What `mode` means for scaling `sw`×`sh` to `dw`×`dh`: 'nearest' or 'smooth'. */
export function resolveScaleMode(mode: ScaleMode, sw: number, sh: number, dw: number, dh: number): 'nearest' | 'smooth' {
  if (mode !== 'auto') return mode
  return dw >= AUTO_NEAREST_FACTOR * sw && dh >= AUTO_NEAREST_FACTOR * sh ? 'nearest' : 'smooth'
}

/**
 * Returns `image` scaled to exactly `width` × `height` pixels (each rounded
 * and clamped to at least 1). In 'smooth' mode shrinking axes use a box
 * (area-average) filter, growing axes bilinear, with alpha premultiplied
 * while filtering; in 'nearest' mode each destination pixel copies the source
 * pixel under its centre; 'auto' (the default) picks one per
 * {@link resolveScaleMode}.
 *
 * Always returns a new `Rgba` with its own `data`, also when the size is
 * unchanged (then the data is a plain copy), so callers may mutate it freely.
 */
export function resizeRgba(image: Rgba, width: number, height: number, options: ResizeOptions = {}): Rgba {
  return resizeRegion(image, width, height, width, height, options)
}

/**
 * The top-left `regionWidth` × `regionHeight` pixels (each rounded, at least
 * 1 and at most the box) of `image` scaled to `width` × `height` as by
 * {@link resizeRgba}: the same taps and scaling mode (resolved for the whole
 * box), with only the source pixels the region reads filtered, so the cost
 * follows the region and that source rectangle, not the whole box. 'nearest'
 * and an unchanged size give exactly the pixels of the whole resize cropped;
 * 'smooth' may pick the other pass order than the whole resize would, which
 * moves a channel by at most 1.
 *
 * Always returns a new `Rgba` with its own `data`.
 */
export function resizeRegion(
  image: Rgba,
  width: number,
  height: number,
  regionWidth: number,
  regionHeight: number,
  options: ResizeOptions = {},
): Rgba {
  const dw = Math.max(1, Math.round(width))
  const dh = Math.max(1, Math.round(height))
  const rw = Math.min(dw, Math.max(1, Math.round(regionWidth)))
  const rh = Math.min(dh, Math.max(1, Math.round(regionHeight)))
  const sw = image.width
  const sh = image.height
  const src = image.data
  if (dw === sw && dh === sh) return copyRegion(image, rw, rh)
  if (resolveScaleMode(options.mode ?? 'auto', sw, sh, dw, dh) === 'nearest') return nearest(image, dw, dh, rw, rh)

  const hx = axisTaps(sw, dw, rw)
  const vy = axisTaps(sh, dh, rh)
  const sx = tapExtent(hx)
  const sy = tapExtent(vy)
  const out = new Uint8Array(rw * rh * 4)
  // The intermediate holds the first pass's output: rw × sy horizontal-first,
  // sx × rh vertical-first. Take the smaller (ties keep horizontal-first).
  if (sx * rh < rw * sy) verticalFirst(src, sw, sx, rw, rh, hx, vy, out)
  else horizontalFirst(src, sw, sy, rw, rh, hx, vy, out)
  return { width: rw, height: rh, data: out }
}

/** The top-left `rw` × `rh` pixels of `image`, copied. */
function copyRegion(image: Rgba, rw: number, rh: number): Rgba {
  const src = image.data
  if (rw === image.width) return { width: rw, height: rh, data: src.slice(0, rw * rh * 4) }
  const data = new Uint8Array(rw * rh * 4)
  for (let y = 0; y < rh; y++) data.set(src.subarray(y * image.width * 4, (y * image.width + rw) * 4), y * rw * 4)
  return { width: rw, height: rh, data }
}

/** Smooth, horizontal pass first: sw × sy (source rows 0..sy-1) → rw × sy → rw × rh. */
function horizontalFirst(src: Uint8Array, sw: number, sy: number, rw: number, rh: number, hx: Taps, vy: Taps, out: Uint8Array): void {
  // Horizontal pass: sw × sy → rw × sy, premultiplying source pixels as they are read.
  const mid = new Float32Array(rw * sy * 4)
  for (let y = 0; y < sy; y++) {
    const srow = y * sw * 4
    const drow = y * rw * 4
    for (let x = 0; x < rw; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      const end = hx.offset[x + 1]!
      for (let k = hx.offset[x]!; k < end; k++) {
        const s = srow + hx.index[k]! * 4
        const w = hx.weight[k]!
        const sa = src[s + 3]!
        const m = sa / 255
        r += Math.fround(src[s]! * m) * w
        g += Math.fround(src[s + 1]! * m) * w
        b += Math.fround(src[s + 2]! * m) * w
        a += sa * w
      }
      const d = drow + x * 4
      mid[d] = r
      mid[d + 1] = g
      mid[d + 2] = b
      mid[d + 3] = a
    }
  }

  // Vertical pass: rw × sy → rw × rh, un-premultiplied into bytes.
  const rowStride = rw * 4
  for (let y = 0; y < rh; y++) {
    const start = vy.offset[y]!
    const end = vy.offset[y + 1]!
    const drow = y * rowStride
    for (let x = 0; x < rw; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      const col = x * 4
      for (let k = start; k < end; k++) {
        const s = vy.index[k]! * rowStride + col
        const w = vy.weight[k]!
        r += mid[s]! * w
        g += mid[s + 1]! * w
        b += mid[s + 2]! * w
        a += mid[s + 3]! * w
      }
      // Un-premultiply into bytes, inlined: see the note after verticalFirst.
      if (a >= 0.5) {
        const k = 255 / a
        const d = drow + col
        out[d] = r * k + 0.5
        out[d + 1] = g * k + 0.5
        out[d + 2] = b * k + 0.5
        out[d + 3] = a >= 255 ? 255 : a + 0.5
      }
    }
  }
}

/** Smooth, vertical pass first: sx × sh (source columns 0..sx-1) → sx × rh → rw × rh. */
function verticalFirst(src: Uint8Array, sw: number, sx: number, rw: number, rh: number, hx: Taps, vy: Taps, out: Uint8Array): void {
  // Vertical pass: sx × sh → sx × rh, premultiplying source pixels as they are
  // read. Each output row sums its source rows into `acc` front to back, so
  // both are read in memory order.
  const rowStride = sx * 4
  const sourceStride = sw * 4
  const mid = new Float32Array(rowStride * rh)
  const acc = new Float64Array(rowStride)
  for (let y = 0; y < rh; y++) {
    acc.fill(0)
    const end = vy.offset[y + 1]!
    for (let k = vy.offset[y]!; k < end; k++) {
      const srow = vy.index[k]! * sourceStride
      const w = vy.weight[k]!
      for (let p = 0; p < rowStride; p += 4) {
        const s = srow + p
        const sa = src[s + 3]!
        const m = sa / 255
        acc[p]! += Math.fround(src[s]! * m) * w
        acc[p + 1]! += Math.fround(src[s + 1]! * m) * w
        acc[p + 2]! += Math.fround(src[s + 2]! * m) * w
        acc[p + 3]! += sa * w
      }
    }
    mid.set(acc, y * rowStride)
  }

  // Horizontal pass: sx × rh → rw × rh, un-premultiplied into bytes.
  for (let y = 0; y < rh; y++) {
    const srow = y * rowStride
    const drow = y * rw * 4
    for (let x = 0; x < rw; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      const end = hx.offset[x + 1]!
      for (let k = hx.offset[x]!; k < end; k++) {
        const s = srow + hx.index[k]! * 4
        const w = hx.weight[k]!
        r += mid[s]! * w
        g += mid[s + 1]! * w
        b += mid[s + 2]! * w
        a += mid[s + 3]! * w
      }
      // Un-premultiply into bytes, inlined: see the note after verticalFirst.
      if (a >= 0.5) {
        const k = 255 / a
        const d = drow + x * 4
        out[d] = r * k + 0.5
        out[d + 1] = g * k + 0.5
        out[d + 2] = b * k + 0.5
        out[d + 3] = a >= 255 ? 255 : a + 0.5
      }
    }
  }
}

// Un-premultiplying (the last step of both orders): premultiplied float
// r, g, b, a (alpha 0..255) become straight-alpha bytes. Alpha that rounds to
// 0 (a < 0.5) leaves the pixel 0,0,0,0. Otherwise each channel is
// round(c * 255 / a): c <= a, so the value is 0..255 (plus float error), and
// a Uint8Array store truncates, so storing `v + 0.5` is Math.round with no
// clamp needed. It is written out at both sites rather than called: a helper
// taking five doubles per pixel with Math.round and a clamp cost more than the
// filtering itself (a 1600x900 -> 1500x900 resize: 44 ms, 24 ms inlined, same
// bytes).

/**
 * Nearest-neighbour scaling to `dw` × `dh`, its top-left `rw` × `rh` pixels:
 * destination pixel i reads source pixel floor((i + 0.5) * src / dst).
 */
function nearest(image: Rgba, dw: number, dh: number, rw: number, rh: number): Rgba {
  const sw = image.width
  const sh = image.height
  const src = image.data
  const columns = new Int32Array(rw)
  for (let x = 0; x < rw; x++) columns[x] = Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / dw)) * 4
  const out = new Uint8Array(rw * rh * 4)
  for (let y = 0; y < rh; y++) {
    const srow = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / dh)) * sw * 4
    const drow = y * rw * 4
    for (let x = 0; x < rw; x++) {
      const s = srow + columns[x]!
      const d = drow + x * 4
      out[d] = src[s]!
      out[d + 1] = src[s + 1]!
      out[d + 2] = src[s + 2]!
      out[d + 3] = src[s + 3]!
    }
  }
  return { width: rw, height: rh, data: out }
}
