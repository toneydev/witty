// Test image builders.

import type { Rgba } from '../../src/types.ts'

export function solid(width: number, height: number, r: number, g: number, b: number, a = 255): Rgba {
  const data = new Uint8Array(width * height * 4)
  for (let p = 0; p < data.length; p += 4) {
    data[p] = r
    data[p + 1] = g
    data[p + 2] = b
    data[p + 3] = a
  }
  return { width, height, data }
}

/** Builds an image from a per-pixel function returning [r,g,b,a]. */
export function make(width: number, height: number, f: (x: number, y: number) => [number, number, number, number]): Rgba {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = f(x, y)
      const p = (y * width + x) * 4
      data[p] = r
      data[p + 1] = g
      data[p + 2] = b
      data[p + 3] = a
    }
  }
  return { width, height, data }
}

export function pixel(image: Rgba, x: number, y: number): [number, number, number, number] {
  const p = (y * image.width + x) * 4
  const d = image.data
  return [d[p]!, d[p + 1]!, d[p + 2]!, d[p + 3]!]
}

/** A deterministic pseudo-random generator (mulberry32). */
export function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
