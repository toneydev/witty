// The unicode placeholder pass: kitty's virtual placements (`U=1`) shown in
// cells the program fills with U+10EEEE, turned into sixel strips.
//
// A placeholder cell is U+10EEEE (UTF-8 F4 8E BB AE) followed by up to three
// diacritics from kitty's row/column table: row, column, and the most
// significant byte of a 32-bit image id. The low 24 bits of the image id are
// the cell's foreground colour, the placement id its underline colour. A cell
// that leaves diacritics out continues the cell to its left (same colours):
// none → same row, column + 1, same high byte; row only → column + 1 and the
// high byte when the row matches; row and column → the high byte when they
// continue the left cell.
//
// The pass watches the text that leaves the splitter: SGR sequences update the
// tracked foreground and underline colours, everything passes through, and a
// run of consecutive placeholder cells of the same image, row and consecutive
// columns (a strip) becomes
//
//   ESC 7  <n spaces>  ESC 8  <sixel of the strip>  ESC 8  CSI n C
//
// (see encodePlaceholderStrip). Cells of an image with no virtual placement
// pass through unchanged.
//
// Chunk safety: escape sequences are parsed by a streaming state machine, so
// their bytes pass straight through. Only a possible start of a placeholder
// (a trailing F4, F4 8E, F4 8E BB) or a run whose last cell may still get
// diacritics is held for the next chunk; a run whose last cell is complete is
// flushed at the end of the chunk.

import type {
  CellSize,
  PlaceholderPass,
  Rgba,
  ScaleMode,
  SixelOptions,
  VirtualPlacement,
  VirtualPlacementKey,
  VirtualRegistry,
} from '../types.ts'
import { cropRgba } from '../image/crop.ts'
import { diacriticIndex } from './diacritics.ts'
import { encodePlaceholderStrip, placementGeometry, scaleToBox } from './emit.ts'

/** U+10EEEE in UTF-8. */
const PLACEHOLDER = [0xf4, 0x8e, 0xbb, 0xae] as const

/** A held run longer than this is flushed up to its last cell, to bound memory. */
const MAX_HOLD_BYTES = 64 * 1024

/** Encoded strips kept per placement before the cache is cleared. */
const MAX_STRIPS_PER_PLACEMENT = 1024

/**
 * Default byte budget of the pass's caches (scaled images and encoded
 * strips), over all placements; the least recently drawn are dropped past
 * it. Two worst-case boxes (64 MiB of RGBA each) fit, or hundreds of the
 * images Claude Code draws.
 */
export const PLACEHOLDER_CACHE_BYTES = 128 * 1024 * 1024

/** Placements with a cache at once (least recently drawn dropped past it). */
const MAX_CACHED_PLACEMENTS = 256

/** Distinct unknown image ids logged (each once). */
const MAX_LOGGED_UNKNOWN = 64

// VT parser states (erasableSyntaxOnly: no enums).
const GROUND = 0
const ESCAPE = 1
const CSI = 2
const STRING = 3
const STRING_ESCAPE = 4

/** The decoded position and colours of a placeholder cell. */
type CellInfo = {
  row: number
  column: number
  /** The most significant byte of the image id. */
  msb: number
  /** Foreground colour as an id (low 24 bits of the image id), undefined when default. */
  fg: number | undefined
  /** Underline colour as an id (the placement id), undefined when default. */
  ul: number | undefined
}

/** A placeholder cell found in the buffer: its bytes are `[start, end)`. */
type Cell = CellInfo & { start: number; end: number }

/** A run of consecutive placeholder cells being collected. */
type Run = {
  cells: Cell[]
  /** The left-cell state before the run's first cell, to restart a held run from. */
  prevBefore: CellInfo | null
}

export type PlaceholderPassOptions = {
  /** Where cells find their virtual placement. */
  registry: VirtualRegistry
  /** Current cell size, read for each strip. */
  cellSize: () => CellSize
  /** Sixel encoder options. */
  sixel?: SixelOptions
  /** How a placement's image is scaled to its cell box. Default 'auto'. */
  scale?: ScaleMode
  /** Diagnostics (`--debug`). */
  log?: (line: string) => void
  /** Byte budget of the caches over all placements. Default {@link PLACEHOLDER_CACHE_BYTES}. */
  cacheBytes?: number
}

/** The pass, plus what its caches hold (for tests and diagnostics). */
export type PlaceholderPassWithCache = PlaceholderPass & {
  /** Bytes the caches hold now: scaled images and encoded strips. */
  readonly cachedBytes: number
  /** Placements with a cache now. */
  readonly cachedPlacements: number
}

/** Per placement: the image scaled to its cell box once per cell size, and the strips encoded from it. */
type PlacementCache = {
  cellWidth: number
  cellHeight: number
  scaled: Rgba
  /** The cell size the scaled image is cut by (smaller than the real cell when the box was capped). */
  cut: CellSize
  strips: Map<string, Uint8Array>
  /** Bytes of `strips`. */
  stripBytes: number
}

/** The pixels a placement shows: its source rectangle of the image, cut out now (the engine never copies it). */
function sourceOf(placement: VirtualPlacement): Rgba {
  const { image, source } = placement
  return source === undefined ? image : cropRgba(image, source.x, source.y, source.width, source.height)
}

/**
 * The virtual placements known to the pipeline, fed from `virtual` and
 * `delete` events. A new `virtual` for the same image and placement id
 * replaces the old object; the pass drops the old object's cache the next
 * time it builds one.
 */
export class VirtualPlacements implements VirtualRegistry {
  /** image id → placement id (0 for none) → placement, most recently set last. */
  readonly #byImage = new Map<number, Map<number, VirtualPlacement>>()

  set(placement: VirtualPlacement): void {
    let placements = this.#byImage.get(placement.imageId)
    if (placements === undefined) {
      placements = new Map()
      this.#byImage.set(placement.imageId, placements)
    }
    const key = placement.placementId ?? 0
    placements.delete(key)
    placements.set(key, placement)
  }

  /** Removes the listed placements, or every placement of `imageIds` when `virtual` is undefined. */
  delete(imageIds: readonly number[], virtual?: readonly VirtualPlacementKey[]): void {
    if (virtual === undefined) {
      for (const id of imageIds) this.#byImage.delete(id)
      return
    }
    for (const { imageId, placementId } of virtual) {
      const placements = this.#byImage.get(imageId)
      if (placements === undefined) continue
      placements.delete(placementId ?? 0)
      if (placements.size === 0) this.#byImage.delete(imageId)
    }
  }

  lookup(imageId: number, placementId?: number): VirtualPlacement | undefined {
    const placements = this.#byImage.get(imageId)
    if (placements === undefined) return undefined
    if (placementId !== undefined && placementId !== 0) return placements.get(placementId)
    // No placement id: kitty may choose any; prefer the one without an id, else the newest.
    const anonymous = placements.get(0)
    if (anonymous !== undefined) return anonymous
    let newest: VirtualPlacement | undefined
    for (const placement of placements.values()) newest = placement
    return newest
  }
}

/**
 * The pixel rectangle of cells `c0 .. c0+n-1` on `row` inside the scaled
 * image: `[x0, x1) × [y0, y1)` from the rounded cell boundaries
 * `round(c * cell.width)` and `round(r * cell.height)`. Adjacent ranges share
 * their boundary, so strips tile without gaps or overlaps for any fractional
 * cell size.
 */
export function stripRect(row: number, c0: number, n: number, cell: CellSize): { x0: number; x1: number; y0: number; y1: number } {
  return {
    x0: Math.round(c0 * cell.width),
    x1: Math.round((c0 + n) * cell.width),
    y0: Math.round(row * cell.height),
    y1: Math.round((row + 1) * cell.height),
  }
}

/** Decodes the UTF-8 code point at `i`: its value and length, 'partial' at a truncated end, or null. */
function codePointAt(buf: Uint8Array, i: number): { cp: number; size: number } | 'partial' | null {
  if (i >= buf.length) return 'partial'
  const b = buf[i]!
  let size: number
  let cp: number
  if (b < 0x80) return { cp: b, size: 1 }
  if (b >= 0xc2 && b <= 0xdf) {
    size = 2
    cp = b & 0x1f
  } else if (b >= 0xe0 && b <= 0xef) {
    size = 3
    cp = b & 0x0f
  } else if (b >= 0xf0 && b <= 0xf4) {
    size = 4
    cp = b & 0x07
  } else {
    return null
  }
  for (let k = 1; k < size; k++) {
    if (i + k >= buf.length) return 'partial'
    const c = buf[i + k]!
    if ((c & 0xc0) !== 0x80) return null
    cp = (cp << 6) | (c & 0x3f)
  }
  return { cp, size }
}

/** A colour from SGR parameters: an index (basic or 256-colour) or a packed 24-bit RGB, as an id. */
function rgbId(r: number, g: number, b: number): number | null {
  if (![r, g, b].every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) return null
  return ((r << 16) | (g << 8) | b) >>> 0
}

function indexId(n: number): number | null {
  return Number.isInteger(n) && n >= 0 && n <= 255 ? n : null
}

/** `38:5:n`, `38:2::r:g:b`, `38:2:r:g:b` (and the same for 48/58): the colour, or null when malformed. */
function colonColor(sub: string[]): number | null {
  if (sub[1] === '5') return indexId(Number(sub[2] ?? ''))
  if (sub[1] === '2') {
    const [r, g, b] = sub.length >= 6 ? [sub[3], sub[4], sub[5]] : [sub[2], sub[3], sub[4]]
    return rgbId(Number(r ?? 'x'), Number(g ?? 'x'), Number(b ?? 'x'))
  }
  return null
}

/**
 * Creates the placeholder pass (see the top of this file). The returned
 * object is stateful: feed it every text byte that goes to the terminal, in
 * order, and write out what it returns.
 */
export function createPlaceholderPass(options: PlaceholderPassOptions): PlaceholderPassWithCache {
  const { registry, cellSize } = options
  const sixelOptions = options.sixel ?? {}
  const scale = options.scale ?? 'auto'
  const log = options.log ?? (() => {})
  const maxCacheBytes = Math.max(0, options.cacheBytes ?? PLACEHOLDER_CACHE_BYTES)

  // Terminal state, tracked as it passes.
  let state = GROUND
  let csiParams = ''
  let csiIntermediate = false
  let fg: number | undefined
  let ul: number | undefined
  /** The placeholder cell just to the left (only SGR sequences may stand between it and the next cell). */
  let prev: CellInfo | null = null

  // Held bytes (always held in GROUND state) and the left-cell state at their start.
  let held: Uint8Array | null = null
  let heldPrev: CellInfo | null = null

  /** Per placement object, least recently drawn first; `cachedBytes` is their total size. */
  const caches = new Map<VirtualPlacement, PlacementCache>()
  let cachedBytes = 0
  const unknownLogged = new Set<number>()

  const cacheSize = (cache: PlacementCache): number => cache.scaled.data.length + cache.stripBytes

  const dropCache = (placement: VirtualPlacement): void => {
    const cache = caches.get(placement)
    if (cache === undefined) return
    caches.delete(placement)
    cachedBytes -= cacheSize(cache)
  }

  /** Drops the caches of placements the registry no longer holds (deleted or replaced). */
  const dropStale = (): void => {
    for (const placement of [...caches.keys()]) {
      if (registry.lookup(placement.imageId, placement.placementId) !== placement) dropCache(placement)
    }
  }

  /**
   * Keeps the caches within their budget: drops the least recently drawn
   * other placements first, then `current`'s strips, then `current` itself.
   */
  const trimCaches = (current: VirtualPlacement): void => {
    for (const placement of caches.keys()) {
      if (cachedBytes <= maxCacheBytes && caches.size <= MAX_CACHED_PLACEMENTS) return
      if (placement !== current) dropCache(placement)
    }
    const cache = caches.get(current)
    if (cache === undefined || cachedBytes <= maxCacheBytes) return
    cachedBytes -= cache.stripBytes
    cache.strips.clear()
    cache.stripBytes = 0
    if (cachedBytes > maxCacheBytes) dropCache(current)
  }

  const applySgr = (params: string): void => {
    const parts = params === '' ? [''] : params.split(';')
    for (let k = 0; k < parts.length; k++) {
      const part = parts[k]!
      if (part.includes(':')) {
        const sub = part.split(':')
        const code = Number(sub[0] === '' ? '0' : sub[0])
        if (code === 38 || code === 58) {
          const color = colonColor(sub)
          if (color !== null) {
            if (code === 38) fg = color
            else ul = color
          }
        }
        continue
      }
      const code = part === '' ? 0 : Number(part)
      if (code === 0) {
        fg = undefined
        ul = undefined
      } else if (code >= 30 && code <= 37) {
        fg = code - 30
      } else if (code >= 90 && code <= 97) {
        fg = code - 90 + 8
      } else if (code === 39) {
        fg = undefined
      } else if (code === 59) {
        ul = undefined
      } else if (code === 38 || code === 48 || code === 58) {
        const mode = parts[k + 1]
        let color: number | null = null
        if (mode === '5') {
          color = indexId(Number(parts[k + 2] ?? 'x'))
          k += 2
        } else if (mode === '2') {
          color = rgbId(Number(parts[k + 2] ?? 'x'), Number(parts[k + 3] ?? 'x'), Number(parts[k + 4] ?? 'x'))
          k += 4
        } else {
          k += 1
        }
        if (color !== null) {
          if (code === 38) fg = color
          else if (code === 58) ul = color
        }
      }
    }
  }

  /** Row, column and high byte of a cell with `marks` diacritic indices, by the inheritance rules. */
  const resolve = (marks: number[]): CellInfo => {
    const left = prev !== null && prev.fg === fg && prev.ul === ul ? prev : null
    let row = 0
    let column = 0
    let msb = 0
    if (marks.length === 0) {
      if (left !== null) {
        row = left.row
        column = left.column + 1
        msb = left.msb
      }
    } else if (marks.length === 1) {
      row = marks[0]!
      if (left !== null && left.row === row) {
        column = left.column + 1
        msb = left.msb
      }
    } else if (marks.length === 2) {
      row = marks[0]!
      column = marks[1]!
      if (left !== null && left.row === row && left.column + 1 === column) msb = left.msb
    } else {
      row = marks[0]!
      column = marks[1]!
      msb = marks[2]!
    }
    return { row, column, msb, fg, ul }
  }

  /** The replacement bytes for a strip of `n` cells of `placement` starting at `row`, `c0`. */
  const stripBytes = (placement: VirtualPlacement, row: number, c0: number, n: number): Uint8Array => {
    // Cell sizes may be fractional: geometry comes from rounded cell
    // boundaries (never rounded cell sizes), so neighbouring strips tile.
    const cell = cellSize()
    const cellWidth = cell.width > 0 ? cell.width : 1
    const cellHeight = cell.height > 0 ? cell.height : 1
    const columns = Math.max(1, Math.round(placement.columns))
    const rows = Math.max(1, Math.round(placement.rows))
    if (row >= rows || c0 >= columns) {
      // Outside the placement's box: kitty shows nothing there.
      return new Uint8Array(n).fill(0x20)
    }
    let cache = caches.get(placement)
    if (cache !== undefined && (cache.cellWidth !== cellWidth || cache.cellHeight !== cellHeight)) {
      dropCache(placement)
      cache = undefined
    }
    if (cache === undefined) {
      dropStale()
      const cell = { width: cellWidth, height: cellHeight }
      // The source rectangle is cut here, only for as long as it takes to scale it.
      const scaled = scaleToBox(sourceOf(placement), columns, rows, cell, scale)
      // A box too large for the pixel cap is scaled down: cut it by the shrunk cell.
      const cut = placementGeometry(columns, rows, cell).cell
      cache = { cellWidth, cellHeight, scaled, cut, strips: new Map(), stripBytes: 0 }
      caches.set(placement, cache)
      cachedBytes += scaled.data.length
    } else {
      // Most recently drawn last.
      caches.delete(placement)
      caches.set(placement, cache)
    }
    const key = `${row},${c0},${n}`
    let bytes = cache.strips.get(key)
    if (bytes === undefined) {
      const { x0, x1, y0, y1 } = stripRect(row, c0, n, cache.cut)
      const strip = cropRgba(cache.scaled, x0, y0, x1 - x0, y1 - y0)
      bytes = encodePlaceholderStrip(strip, n, sixelOptions)
      if (cache.strips.size >= MAX_STRIPS_PER_PLACEMENT) {
        cachedBytes -= cache.stripBytes
        cache.strips.clear()
        cache.stripBytes = 0
      }
      cache.strips.set(key, bytes)
      cache.stripBytes += bytes.length
      cachedBytes += bytes.length
    }
    trimCaches(placement)
    return bytes
  }

  /** Runs `chunk` (after anything held) through the pass; `final` means no more bytes will come. */
  const scan = (chunk: Uint8Array, final: boolean): Uint8Array => {
    let buf = chunk
    if (held !== null) {
      buf = new Uint8Array(held.length + chunk.length)
      buf.set(held, 0)
      buf.set(chunk, held.length)
      prev = heldPrev
      held = null
      heldPrev = null
    }
    const len = buf.length
    const pieces: Uint8Array[] = []
    let emitFrom = 0
    let run: Run | null = null

    /** Writes out the current run (which ends where its last cell ends), strip by strip. */
    const endRun = (): void => {
      if (run === null) return
      const { cells } = run
      run = null
      const first = cells[0]!
      if (first.start > emitFrom) pieces.push(buf.subarray(emitFrom, first.start))
      let s = 0
      while (s < cells.length) {
        const head = cells[s]!
        let e = s + 1
        while (e < cells.length) {
          const c = cells[e]!
          const p = cells[e - 1]!
          if (c.msb !== head.msb || c.row !== head.row || c.column !== p.column + 1) break
          e++
        }
        const last = cells[e - 1]!
        const raw = buf.subarray(head.start, last.end)
        const imageId = (head.msb * 0x1000000 + (head.fg ?? 0)) >>> 0
        const placementId = head.ul !== undefined && head.ul !== 0 ? head.ul : undefined
        const placement = imageId === 0 ? undefined : registry.lookup(imageId, placementId)
        if (placement === undefined) {
          if (imageId !== 0 && !unknownLogged.has(imageId) && unknownLogged.size < MAX_LOGGED_UNKNOWN) {
            unknownLogged.add(imageId)
            log(`placeholder cells for image ${imageId}${placementId === undefined ? '' : ` placement ${placementId}`} without a virtual placement, passed through`)
          }
          pieces.push(raw)
        } else {
          try {
            pieces.push(stripBytes(placement, head.row, head.column, e - s))
          } catch (error) {
            log(`placeholder strip failed: ${error instanceof Error ? error.message : String(error)}`)
            pieces.push(raw)
          }
        }
        s = e
      }
      emitFrom = cells[cells.length - 1]!.end
    }

    /** Keeps `[from, len)` for the next chunk; `from` is in GROUND state. */
    const hold = (from: number, leftCell: CellInfo | null): void => {
      if (from > emitFrom) pieces.push(buf.subarray(emitFrom, from))
      emitFrom = len
      held = buf.slice(from)
      heldPrev = leftCell
    }

    /** Holds from the current run's start (or from `at` without a run, or when the run is too long). */
    const holdRunOrCell = (at: number): void => {
      const current = run as Run | null
      if (current !== null && at - current.cells[0]!.start <= MAX_HOLD_BYTES) {
        const start = current.cells[0]!.start
        run = null
        hold(start, current.prevBefore)
        return
      }
      const leftCell = prev
      endRun()
      hold(at, leftCell)
    }

    let i = 0
    scanning: while (i < len) {
      const b = buf[i]!
      switch (state) {
        case GROUND: {
          if (b === 0xf4) {
            let k = 1
            while (k < 4 && i + k < len && buf[i + k] === PLACEHOLDER[k]) k++
            if (k < 4) {
              if (i + k === len && !final) {
                holdRunOrCell(i)
                break scanning
              }
              endRun()
              prev = null
              i++
              continue
            }
            // A placeholder: collect up to three diacritics.
            const marks: number[] = []
            let j = i + 4
            let incomplete = false
            while (marks.length < 3) {
              const decoded = codePointAt(buf, j)
              if (decoded === 'partial') {
                incomplete = !final
                break
              }
              if (decoded === null) break
              const index = diacriticIndex(decoded.cp)
              if (index < 0) break
              marks.push(index)
              j += decoded.size
            }
            if (incomplete) {
              holdRunOrCell(i)
              break scanning
            }
            const before = prev
            const info = resolve(marks)
            const cell: Cell = { ...info, start: i, end: j }
            if (run === null) run = { cells: [cell], prevBefore: before }
            else run.cells.push(cell)
            prev = info
            i = j
            continue
          }
          endRun()
          if (b === 0x1b) state = ESCAPE
          else prev = null
          i++
          continue
        }
        case ESCAPE: {
          if (b === 0x5b) {
            state = CSI
            csiParams = ''
            csiIntermediate = false
          } else if (b === 0x5d || b === 0x50 || b === 0x58 || b === 0x5e || b === 0x5f) {
            state = STRING
            prev = null
          } else if (b === 0x18 || b === 0x1a) {
            state = GROUND
            prev = null
          } else if (b >= 0x20 && b <= 0x2f) {
            // intermediate: stay
          } else if (b === 0x1b) {
            // ESC ESC: start over
          } else if (b < 0x20) {
            // C0 control inside an escape: executed, sequence goes on
          } else {
            state = GROUND
            prev = null
          }
          i++
          continue
        }
        case CSI: {
          if (b >= 0x30 && b <= 0x3f) {
            if (csiParams.length < 256) csiParams += String.fromCharCode(b)
          } else if (b >= 0x20 && b <= 0x2f) {
            csiIntermediate = true
          } else if (b >= 0x40 && b <= 0x7e) {
            const isSgr = b === 0x6d && !csiIntermediate && !/^[<=>?]/.test(csiParams)
            if (isSgr) applySgr(csiParams)
            else prev = null
            state = GROUND
          } else if (b === 0x1b) {
            state = ESCAPE
          } else if (b === 0x18 || b === 0x1a) {
            state = GROUND
            prev = null
          }
          i++
          continue
        }
        case STRING: {
          if (b === 0x1b) state = STRING_ESCAPE
          else if (b === 0x07 || b === 0x18 || b === 0x1a) state = GROUND
          i++
          continue
        }
        default: {
          // STRING_ESCAPE: ESC \ ends the string; ESC + anything else starts a new escape.
          if (b === 0x5c) {
            state = GROUND
            i++
          } else if (b === 0x1b) {
            i++
          } else {
            state = ESCAPE
          }
          continue
        }
      }
    }
    if (i >= len) {
      endRun()
      if (emitFrom < len) pieces.push(buf.subarray(emitFrom, len))
    }

    if (pieces.length === 1 && pieces[0]!.length === buf.length) return buf
    let total = 0
    for (const piece of pieces) total += piece.length
    const out = new Uint8Array(total)
    let at = 0
    for (const piece of pieces) {
      out.set(piece, at)
      at += piece.length
    }
    return out
  }

  return {
    push: (chunk) => scan(chunk, false),
    flush: () => (held === null ? new Uint8Array(0) : scan(new Uint8Array(0), true)),
    get holding() {
      return held !== null
    },
    get cachedBytes() {
      return cachedBytes
    },
    get cachedPlacements() {
      return caches.size
    },
  }
}
