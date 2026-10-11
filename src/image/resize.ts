// Scales an RGBA bitmap to an exact pixel box.
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

import type { Rgba, ScaleMode } from '../types.ts'

/** Filter taps for one axis: destination i reads `index[k]` × `weight[k]` for k in `[offset[i], offset[i+1])`. */
type Taps = { offset: Int32Array; index: Int32Array; weight: Float64Array }

function axisTaps(src: number, dst: number): Taps {
  const index: number[] = []
  const weight: number[] = []
  const offset = new Int32Array(dst + 1)
  if (dst === src) {
    for (let i = 0; i < dst; i++) {
      offset[i] = i
      index.push(i)
      weight.push(1)
    }
  } else if (dst < src) {
    // Box filter: destination pixel i covers source interval [i*s, (i+1)*s).
    const scale = src / dst
    for (let i = 0; i < dst; i++) {
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
    for (let i = 0; i < dst; i++) {
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
  offset[dst] = index.length
  return { offset, index: Int32Array.from(index), weight: Float64Array.from(weight) }
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
  const dw = Math.max(1, Math.round(width))
  const dh = Math.max(1, Math.round(height))
  const sw = image.width
  const sh = image.height
  const src = image.data
  if (dw === sw && dh === sh) {
    return { width: sw, height: sh, data: src.slice(0, sw * sh * 4) }
  }
  if (resolveScaleMode(options.mode ?? 'auto', sw, sh, dw, dh) === 'nearest') return nearest(image, dw, dh)

  // Premultiplied float copy of the source.
  const pre = new Float32Array(sw * sh * 4)
  for (let p = 0; p < sw * sh * 4; p += 4) {
    const a = src[p + 3]!
    const k = a / 255
    pre[p] = src[p]! * k
    pre[p + 1] = src[p + 1]! * k
    pre[p + 2] = src[p + 2]! * k
    pre[p + 3] = a
  }

  // Horizontal pass: sw × sh → dw × sh.
  const hx = axisTaps(sw, dw)
  const mid = new Float32Array(dw * sh * 4)
  for (let y = 0; y < sh; y++) {
    const srow = y * sw * 4
    const drow = y * dw * 4
    for (let x = 0; x < dw; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      const end = hx.offset[x + 1]!
      for (let k = hx.offset[x]!; k < end; k++) {
        const s = srow + hx.index[k]! * 4
        const w = hx.weight[k]!
        r += pre[s]! * w
        g += pre[s + 1]! * w
        b += pre[s + 2]! * w
        a += pre[s + 3]! * w
      }
      const d = drow + x * 4
      mid[d] = r
      mid[d + 1] = g
      mid[d + 2] = b
      mid[d + 3] = a
    }
  }

  // Vertical pass: dw × sh → dw × dh, un-premultiplied into bytes.
  const vy = axisTaps(sh, dh)
  const out = new Uint8Array(dw * dh * 4)
  const rowStride = dw * 4
  for (let y = 0; y < dh; y++) {
    const start = vy.offset[y]!
    const end = vy.offset[y + 1]!
    const drow = y * rowStride
    for (let x = 0; x < dw; x++) {
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
      const d = drow + col
      const ab = Math.round(a)
      if (ab <= 0) continue // fully transparent: leave 0,0,0,0
      const k = 255 / a
      out[d] = clamp(Math.round(r * k))
      out[d + 1] = clamp(Math.round(g * k))
      out[d + 2] = clamp(Math.round(b * k))
      out[d + 3] = ab > 255 ? 255 : ab
    }
  }
  return { width: dw, height: dh, data: out }
}

/** Nearest-neighbour scaling: destination pixel i reads source pixel floor((i + 0.5) * src / dst). */
function nearest(image: Rgba, dw: number, dh: number): Rgba {
  const sw = image.width
  const sh = image.height
  const src = image.data
  const columns = new Int32Array(dw)
  for (let x = 0; x < dw; x++) columns[x] = Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / dw)) * 4
  const out = new Uint8Array(dw * dh * 4)
  for (let y = 0; y < dh; y++) {
    const srow = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / dh)) * sw * 4
    const drow = y * dw * 4
    for (let x = 0; x < dw; x++) {
      const s = srow + columns[x]!
      const d = drow + x * 4
      out[d] = src[s]!
      out[d + 1] = src[s + 1]!
      out[d + 2] = src[s + 2]!
      out[d + 3] = src[s + 3]!
    }
  }
  return { width: dw, height: dh, data: out }
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v
}
