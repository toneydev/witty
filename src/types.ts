// Shared contracts between witty's modules. Each phase implements against these;
// change them only together with every consumer.

/** An RGBA bitmap, row-major, 4 bytes per pixel, no padding. */
export type Rgba = {
  width: number
  height: number
  data: Uint8Array
}

/**
 * Pixels per terminal cell. May be fractional (xterm.js cells are, in CSS
 * pixels): geometry rounds cell boundaries, `round(n * width)`, never the
 * cell size itself.
 */
export type CellSize = {
  width: number
  height: number
}

/**
 * One kitty graphics command as it arrived: the control keys, raw and
 * unparsed (`a=T`, `f=100`, `i=31`, `m=1`, ...), and the payload after `;`
 * (base64 text, possibly empty). The leading `G` is not included.
 */
export type KittyCommand = {
  keys: Record<string, string>
  payload: string
}

/** What the splitter yields from a chunk of child output, in order. */
export type SplitItem =
  | { kind: 'text'; data: Uint8Array }
  | { kind: 'apc'; command: KittyCommand }

/**
 * The streaming splitter. `push` returns the items that became complete with
 * this chunk, in output order. Text is passed on as soon as it cannot be the
 * start of a kitty APC (`ESC _ G`); a partial APC at the end of a chunk is
 * held until the next chunk completes it. Non-kitty APCs (`ESC _` followed by
 * anything but `G`) and every other escape sequence pass through as text.
 * `flush` yields anything still held (as text) at end of stream.
 */
export interface ApcSplitter {
  push(chunk: Uint8Array): SplitItem[]
  flush(): SplitItem[]
}

/** The cursor policy of a placement: kitty's `C` key. */
export type CursorPolicy = 'move' | 'stay'

/**
 * What the engine asks the terminal side to do, in order.
 *
 * `place`: draw `image` over a box of `columns` × `rows` cells at the cursor
 * (the image is already the right source; the emitter scales it to the box).
 * `cursor: 'move'` means leave the cursor to the right of the image's
 * bottom-right cell afterwards, `'stay'` means put it back where it was.
 *
 * `respond`: write `data` to the child's input, verbatim (a full
 * `ESC _ G ... ESC \` response).
 *
 * `virtual`: a virtual placement (`U=1`) was created or its image replaced.
 * Nothing is drawn now; the image appears where the program later writes
 * unicode placeholder cells (U+10EEEE) for it. `image` is the stored image
 * itself (shared, never copied), `source` the part of it shown (the
 * `x,y,w,h` rectangle, absent for the whole image; it is cut out only when
 * the placement is drawn), `columns` × `rows` the cell box it is scaled to. A
 * later `virtual` with the same `imageId` and `placementId` replaces it.
 *
 * `delete`: placements were removed; the emitter may erase nothing (sixel has
 * no delete and positions are not tracked) but the event is reported.
 * `virtual` lists the virtual placements the delete removed (possibly none);
 * when it is absent, every virtual placement of `imageIds` is gone.
 *
 * `log`: a diagnostic line for `--debug`.
 */
export type EngineEvent =
  | { kind: 'place'; image: Rgba; columns: number; rows: number; cursor: CursorPolicy; imageId: number }
  | { kind: 'virtual'; imageId: number; placementId: number | undefined; image: Rgba; source?: SourceRect; columns: number; rows: number }
  | { kind: 'respond'; data: string }
  | { kind: 'delete'; imageIds: number[]; virtual?: VirtualPlacementKey[] }
  | { kind: 'log'; message: string }

/** Names one virtual placement: an image id and its placement id (`p`), undefined when none was given. */
export type VirtualPlacementKey = {
  imageId: number
  placementId: number | undefined
}

/** A pixel rectangle inside an image (kitty's `x,y,w,h`, clamped to the image). */
export type SourceRect = {
  x: number
  y: number
  width: number
  height: number
}

/** A virtual placement as the placeholder pass sees it (the payload of a `virtual` event). */
export type VirtualPlacement = VirtualPlacementKey & {
  /** The stored image, shared with the engine (not a copy). */
  image: Rgba
  /** The part of `image` shown; absent for the whole image. */
  source?: SourceRect
  columns: number
  rows: number
}

/**
 * Where the placeholder pass finds the virtual placement of a cell. With a
 * `placementId` (non-zero underline colour) only that placement matches;
 * without one, any virtual placement of the image may be chosen.
 */
export interface VirtualRegistry {
  lookup(imageId: number, placementId?: number): VirtualPlacement | undefined
}

/**
 * The unicode placeholder pass over the text that leaves the splitter. Every
 * byte is passed on unchanged, except runs of placeholder cells of a known
 * virtual placement, which become spaces plus a sixel strip. `push` returns
 * the bytes ready to write (possibly empty: a partial sequence is held until
 * the next chunk); `flush` returns whatever is still held, at end of stream.
 */
export interface PlaceholderPass {
  push(chunk: Uint8Array): Uint8Array
  flush(): Uint8Array
  /** True while bytes are held for the next chunk (what `flush` would write). */
  readonly holding: boolean
}

/** The part of a transmitted file an image uses: `O` (offset), `S` (size, 0 = to the end), and the size limit. */
export type FileRange = {
  offset: number
  size: number
  /** Largest file accepted, bytes. */
  maxBytes: number
}

export type KittyEngineOptions = {
  /** Pixels per cell, read at each placement (it can be learned late). */
  cellSize: () => CellSize
  /**
   * Reads a file for `t=f` / `t=t` (the whole file; `range` is what will be
   * used of it, to be checked before reading). Absent, those transports are
   * refused with EINVAL. Any rejection becomes `EBADF:Failed to read image file`.
   */
  readFile?: (path: string, range: FileRange) => Promise<Uint8Array>
  /** Deletes a `t=t` temp file after reading; absent, the file is left in place. */
  deleteFile?: (path: string) => Promise<void>
  /** Largest decoded image accepted, in bytes of RGBA. Default 64 MiB. */
  maxImageBytes?: number
  /** Largest payload accumulated across chunks, in base64 bytes. Default 32 MiB. */
  maxPayloadBytes?: number
}

/**
 * The kitty graphics interpreter: holds transmitted images and chunk state,
 * and turns each command into events. `handle` calls must be awaited in
 * order; the caller serialises them with the text around them.
 */
export interface KittyEngine {
  handle(command: KittyCommand): Promise<EngineEvent[]>
}

/**
 * How images are scaled to their cell box: `nearest` samples the nearest
 * source pixel (sharp blocks), `smooth` filters (box when shrinking, bilinear
 * when growing), `auto` uses nearest when the image grows by 2x or more on
 * both axes (pixel art, icons, sprites) and smooth otherwise.
 */
export type ScaleMode = 'auto' | 'nearest' | 'smooth'

/** Options for the sixel encoder. */
export type SixelOptions = {
  /** Palette size, 2..256; one slot is taken for transparency only when the image has a transparent pixel. Default 256. */
  maxColors?: number
  /** Pixels with alpha < 128 are left undrawn (the terminal background shows). Default true. */
  transparent?: boolean
}

/**
 * The terminal-side writer. Given a `place` event it returns the complete
 * byte sequence to write to the outer terminal: save cursor, the sixel DCS
 * for the image scaled to `columns * cell.width` × `rows * cell.height`,
 * restore cursor, then the cursor movement the policy asks for.
 */
export type PlaceEmitter = (
  event: Extract<EngineEvent, { kind: 'place' }>,
  cell: CellSize,
  screen?: ScreenSize,
) => Uint8Array

/** The outer terminal's size in cells (0 when unknown). */
export type ScreenSize = {
  columns: number
  rows: number
}
