// A small reference sixel decoder for tests. It understands what witty's
// encoder writes (and a little more): DCS parameters, raster attributes,
// `#n;2;r;g;b` RGB-percent colour definitions, `#n` colour selection, `!n`
// repeats, `$`, `-`, and sixel data characters. The output image has the
// raster size; pixels never set are transparent (0,0,0,0).

import type { Rgba } from '../../src/types.ts'

export type DecodedSixel = {
  /** DCS numeric parameters before `q`. */
  params: number[]
  /** Raster attributes `"Pan;Pad;Ph;Pv`, or null if absent. */
  raster: [number, number, number, number] | null
  image: Rgba
  /** Colour registers defined, register → [r,g,b] percentages. */
  palette: Map<number, [number, number, number]>
  /** Highest register number seen in a definition or selection. */
  maxRegister: number
  /** Number of `!` repeat introducers seen. */
  repeats: number
  /** Bits that fell outside the raster area. */
  outOfBounds: number
  /** Bytes consumed, including the final ST. */
  length: number
}

/** Percent 0..100 back to a 0..255 channel. */
export function fromPercent(p: number): number {
  return Math.round((p * 255) / 100)
}

/** Decodes one sixel DCS starting at `text[0]` (must be `ESC P`). */
export function decodeSixel(text: string): DecodedSixel {
  let i = 0
  const peek = (): number => (i < text.length ? text.charCodeAt(i) : -1)
  const readNum = (): number => {
    let n = 0
    let any = false
    while (peek() >= 0x30 && peek() <= 0x39) {
      n = n * 10 + (peek() - 0x30)
      i++
      any = true
    }
    if (!any) throw new Error(`number expected at ${i}`)
    return n
  }

  if (text.charCodeAt(0) !== 0x1b || text[1] !== 'P') throw new Error('not a DCS')
  i = 2
  const params: number[] = []
  while (peek() !== 0x71 /* q */) {
    if (peek() === 0x3b) {
      i++
      continue
    }
    params.push(readNum())
  }
  i++ // q

  let raster: [number, number, number, number] | null = null
  if (peek() === 0x22) {
    i++
    const vals: number[] = [readNum()]
    while (peek() === 0x3b) {
      i++
      vals.push(readNum())
    }
    if (vals.length !== 4) throw new Error('raster attributes need 4 values')
    raster = [vals[0]!, vals[1]!, vals[2]!, vals[3]!]
  }
  const width = raster ? raster[2] : 0
  const height = raster ? raster[3] : 0
  const data = new Uint8Array(width * height * 4)
  const palette = new Map<number, [number, number, number]>()
  let maxRegister = -1
  let repeats = 0
  let outOfBounds = 0
  let color = 0
  let x = 0
  let band = 0

  const put = (ch: number, count: number): void => {
    const mask = ch - 0x3f
    const def = palette.get(color)
    if (!def && mask !== 0) throw new Error(`colour ${color} used before definition`)
    for (let k = 0; k < count; k++, x++) {
      for (let r = 0; r < 6; r++) {
        if (!(mask & (1 << r))) continue
        const y = band * 6 + r
        if (x >= width || y >= height) {
          outOfBounds++
          continue
        }
        const p = (y * width + x) * 4
        data[p] = fromPercent(def![0])
        data[p + 1] = fromPercent(def![1])
        data[p + 2] = fromPercent(def![2])
        data[p + 3] = 255
      }
    }
  }

  for (;;) {
    const c = peek()
    if (c < 0) throw new Error('unterminated DCS')
    if (c === 0x1b) {
      if (text[i + 1] !== '\\') throw new Error(`ESC not followed by \\ at ${i}`)
      i += 2
      break
    }
    if (c === 0x23) {
      i++
      const n = readNum()
      if (peek() === 0x3b) {
        i++
        const kind = readNum()
        const v: number[] = []
        for (let k = 0; k < 3; k++) {
          if (peek() !== 0x3b) throw new Error('colour definition needs 3 values')
          i++
          v.push(readNum())
        }
        if (kind !== 2) throw new Error(`colour space ${kind} not supported`)
        for (const p of v) if (p < 0 || p > 100) throw new Error(`percentage ${p} out of range`)
        palette.set(n, [v[0]!, v[1]!, v[2]!])
      }
      color = n
      if (n > maxRegister) maxRegister = n
    } else if (c === 0x21) {
      i++
      const n = readNum()
      const ch = peek()
      if (ch < 0x3f || ch > 0x7e) throw new Error('repeat without sixel char')
      i++
      repeats++
      put(ch, n)
    } else if (c === 0x24) {
      i++
      x = 0
    } else if (c === 0x2d) {
      i++
      x = 0
      band++
    } else if (c >= 0x3f && c <= 0x7e) {
      i++
      put(c, 1)
    } else {
      throw new Error(`unexpected byte 0x${c.toString(16)} at ${i}`)
    }
  }

  return { params, raster, image: { width, height, data }, palette, maxRegister, repeats, outOfBounds, length: i }
}
