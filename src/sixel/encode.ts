// RGBA -> one sixel DCS sequence.
//
// Byte layout (everything is 7-bit ASCII; spaces below are for reading only):
//
//   ESC P 9 ; 1 ; 0 q          DCS introducer. P1=9: 1:1 pixel aspect ratio.
//                              P2=1: pixels not set keep the terminal
//                              background (this is how transparency works).
//                              P3=0: default grid size.
//   " 1 ; 1 ; W ; H            raster attributes: aspect 1:1, W x H pixels.
//   # n ; 2 ; R ; G ; B        one per palette entry n = 0..count-1 (count <= 256),
//                              R/G/B as percentages 0..100, round(v * 100 / 255).
//   then the image in bands of 6 pixel rows, top to bottom. For each band:
//     for each palette colour that has at least one pixel in the band,
//     in ascending register order:
//       # n                    select colour n
//       sixel data             one char per column, 0x3f + bitmask (bit 0 =
//                              top row of the band), starting at column 0 and
//                              ending at the last column with a bit set for
//                              this colour (trailing empty sixels trimmed).
//                              A run of 4 or more equal chars is written
//                              ! count char.
//       $                      between colours: carriage return to the start
//                              of the band (not after the band's last colour)
//     -                        between bands: next band (not after the last)
//   ESC \                      ST
//
// An empty band (all transparent) is just its `-`. Transparent pixels set no
// bit for any colour, so they are never drawn.

import type { Rgba, SixelOptions } from '../types.ts'
import { quantize } from './quantize.ts'

/** A growable ASCII byte buffer. */
class Bytes {
  buf: Uint8Array = new Uint8Array(1 << 16)
  len = 0

  reserve(n: number): void {
    if (this.len + n <= this.buf.length) return
    let size = this.buf.length * 2
    while (size < this.len + n) size *= 2
    const next = new Uint8Array(size)
    next.set(this.buf.subarray(0, this.len))
    this.buf = next
  }

  byte(b: number): void {
    this.reserve(1)
    this.buf[this.len++] = b
  }

  ascii(s: string): void {
    this.reserve(s.length)
    for (let i = 0; i < s.length; i++) this.buf[this.len++] = s.charCodeAt(i)
  }

  /** A non-negative integer in decimal. */
  num(n: number): void {
    if (n < 10) {
      this.byte(0x30 + n)
      return
    }
    this.ascii(String(n))
  }

  /** `count` copies of `ch`, as `!count ch` when count >= 4. */
  run(ch: number, count: number): void {
    if (count >= 4) {
      this.byte(0x21) // !
      this.num(count)
      this.byte(ch)
    } else {
      this.reserve(count)
      for (let i = 0; i < count; i++) this.buf[this.len++] = ch
    }
  }

  result(): Uint8Array {
    return this.buf.slice(0, this.len)
  }
}

/** Percent 0..100 of a 0..255 channel value. */
function percent(v: number): number {
  return Math.round((v * 100) / 255)
}

/**
 * Encodes `image` as one complete sixel DCS (see the layout at the top of
 * this file) and returns its bytes. `opts.maxColors` (default 256, clamped to
 * 1..256) caps the palette; with `opts.transparent` (default true) pixels
 * with alpha < 128 are left undrawn, and the palette then has at most 255
 * entries if any pixel is transparent. With `transparent: false` every pixel
 * is drawn with its RGB, ignoring alpha.
 */
export function encodeSixelBytes(image: Rgba, opts: SixelOptions = {}): Uint8Array {
  const width = image.width
  const height = image.height
  // Not finite (NaN) counts as absent: NaN would pass every clamp unchanged.
  const requested = opts.maxColors !== undefined && Number.isFinite(opts.maxColors) ? opts.maxColors : 256
  const maxColors = Math.max(1, Math.min(256, Math.floor(requested)))
  const transparent = opts.transparent ?? true
  const { palette, indices } = quantize(image, maxColors, { alphaThreshold: transparent ? 128 : 0 })
  const n = palette.length / 3

  const out = new Bytes()
  out.ascii('\x1bP9;1;0q"1;1;')
  out.num(width)
  out.byte(0x3b)
  out.num(height)
  for (let i = 0; i < n; i++) {
    out.byte(0x23) // #
    out.num(i)
    out.ascii(';2;')
    out.num(percent(palette[i * 3]!))
    out.byte(0x3b)
    out.num(percent(palette[i * 3 + 1]!))
    out.byte(0x3b)
    out.num(percent(palette[i * 3 + 2]!))
  }

  // Per band: bits[c * width + x] is colour c's 6-bit mask in column x.
  const bits = new Uint8Array(Math.max(1, n) * width)
  const minX = new Int32Array(Math.max(1, n)).fill(width)
  const maxX = new Int32Array(Math.max(1, n)).fill(-1)
  const present: number[] = []

  for (let y0 = 0; y0 < height; y0 += 6) {
    present.length = 0
    const rows = Math.min(6, height - y0)
    for (let r = 0; r < rows; r++) {
      const bit = 1 << r
      const row = (y0 + r) * width
      for (let x = 0; x < width; x++) {
        const c = indices[row + x]!
        if (c >= n) continue // transparent
        bits[c * width + x]! |= bit
        if (maxX[c]! < 0) {
          present.push(c)
          minX[c] = x
          maxX[c] = x
        } else {
          if (x < minX[c]!) minX[c] = x
          if (x > maxX[c]!) maxX[c] = x
        }
      }
    }
    present.sort((a, b) => a - b)

    for (let p = 0; p < present.length; p++) {
      const c = present[p]!
      if (p > 0) out.byte(0x24) // $
      out.byte(0x23) // #
      out.num(c)
      const base = c * width
      const lo = minX[c]!
      const hi = maxX[c]!
      out.run(0x3f, lo) // leading empty sixels
      let runChar = bits[base + lo]!
      let runLen = 1
      for (let x = lo + 1; x <= hi; x++) {
        const v = bits[base + x]!
        if (v === runChar) {
          runLen++
        } else {
          out.run(0x3f + runChar, runLen)
          runChar = v
          runLen = 1
        }
      }
      out.run(0x3f + runChar, runLen)
      bits.fill(0, base + lo, base + hi + 1)
      minX[c] = width
      maxX[c] = -1
    }

    if (y0 + 6 < height) out.byte(0x2d) // -
  }

  out.ascii('\x1b\\')
  return out.result()
}

/** {@link encodeSixelBytes} as a string (each char one byte, all ASCII). */
export function encodeSixel(image: Rgba, opts: SixelOptions = {}): string {
  const bytes = encodeSixelBytes(image, opts)
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString('latin1')
}
