// Cuts a rectangle out of an RGBA bitmap.

import type { Rgba } from '../types.ts'

/**
 * The `width` × `height` region of `image` whose top-left corner is at
 * `x`,`y`. Parts of the region outside the image are transparent (0,0,0,0),
 * so the result always has the requested size (each side at least 1). When
 * the region is exactly the whole image, `image` itself is returned.
 */
export function cropRgba(image: Rgba, x: number, y: number, width: number, height: number): Rgba {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  const left = Math.round(x)
  const top = Math.round(y)
  if (left === 0 && top === 0 && w === image.width && h === image.height) return image
  const data = new Uint8Array(w * h * 4)
  const fromX = Math.max(0, left)
  const toX = Math.min(image.width, left + w)
  if (toX <= fromX) return { width: w, height: h, data }
  const rowBytes = (toX - fromX) * 4
  for (let row = 0; row < h; row++) {
    const sy = top + row
    if (sy < 0 || sy >= image.height) continue
    const start = (sy * image.width + fromX) * 4
    data.set(image.data.subarray(start, start + rowBytes), (row * w + (fromX - left)) * 4)
  }
  return { width: w, height: h, data }
}
