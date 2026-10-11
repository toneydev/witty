// The kitty graphics interpreter: image store, chunk accumulation, actions, responses.

import type { EngineEvent, KittyCommand, KittyEngine, KittyEngineOptions, Rgba, VirtualPlacementKey } from '../types.ts'
import { KittyError, encodeResponse, uintKey } from './command.ts'
import type { ResponseFields } from './command.ts'
import { DEFAULT_MAX_IMAGE_BYTES, DEFAULT_MAX_PAYLOAD_BYTES, decodeImage } from './decode.ts'
import { cropRgba as crop } from '../image/crop.ts'

/** Default bound on stored image data (RGBA bytes) before LRU eviction. */
export const DEFAULT_MAX_STORE_BYTES = 256 * 1024 * 1024

/** Engine options plus internal knobs (exposed for tests). */
export type EngineOptions = KittyEngineOptions & {
  /** Stored RGBA bytes beyond which least recently used images are evicted. Default 256 MiB. */
  maxStoreBytes?: number
}

/** Placement keys that witty cannot honor; each is logged once when seen. */
const IGNORED_PLACEMENT_KEYS = ['z', 'X', 'Y', 'P', 'Q', 'H', 'V'] as const

/** Ids allocated by witty (for `I=` and anonymous images) start here, away from small client ids. */
const FIRST_ALLOCATED_ID = 0x40000000

type StoredImage = {
  id: number
  /** The client's image number (`I`), if it was transmitted with one. */
  number: number
  rgba: Rgba
  /** Transmission order, to find the newest image with a number. */
  seq: number
  /** Named placements (`p`). */
  placements: Set<number>
  /** Placements without a `p`. */
  anonymousPlacements: number
  /**
   * Virtual placements (`U=1`) by placement id (0 for none), with the keys
   * that shaped them, so a replaced image can be re-boxed the same way.
   */
  virtual: Map<number, Record<string, string>>
}

/** The placement keys a virtual placement keeps (source rectangle and box). */
const BOX_KEYS = ['x', 'y', 'w', 'h', 'c', 'r'] as const

/** A chunked transmission (`m=1`) being accumulated. */
type Loading = {
  keys: Record<string, string>
  payload: string[]
  length: number
  /** A limit was hit; remaining chunks are drained and the error reported at the end. */
  error: KittyError | null
}

type Quiet = 0 | 1 | 2

function quietOf(keys: Record<string, string>): Quiet {
  const q = keys.q
  return q === '1' ? 1 : q === '2' ? 2 : 0
}

/**
 * The kitty graphics interpreter (see `KittyEngine`). Images are kept as
 * RGBA keyed by image id; placements are only counted, since positions on
 * screen are not tracked. Virtual placements (`U=1`) keep their box keys so
 * a replaced image re-emits them with its new pixels. Each `handle` returns
 * the events the command produced, in order.
 */
export class Engine implements KittyEngine {
  readonly #options: EngineOptions
  readonly #maxImageBytes: number
  readonly #maxPayloadBytes: number
  readonly #maxStoreBytes: number
  /** Images in least-recently-used order (oldest first). */
  readonly #images = new Map<number, StoredImage>()
  #storeBytes = 0
  #seq = 0
  #nextId = FIRST_ALLOCATED_ID
  #loading: Loading | null = null
  readonly #logged = new Set<string>()

  constructor(options: EngineOptions) {
    this.#options = options
    this.#maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES
    this.#maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES
    this.#maxStoreBytes = options.maxStoreBytes ?? DEFAULT_MAX_STORE_BYTES
  }

  async handle(command: KittyCommand): Promise<EngineEvent[]> {
    const events: EngineEvent[] = []
    const { keys, payload } = command
    const loading = this.#loading

    if (loading !== null) {
      if (keys.a === 'd') {
        // kitty: any delete aborts a partial chunked upload.
        this.#loading = null
        events.push({ kind: 'log', message: 'chunked transmission aborted by a delete command' })
      } else {
        this.#appendChunk(loading, payload)
        if (keys.q !== undefined) loading.keys.q = keys.q
        if (keys.m === '1') return events
        this.#loading = null
        if (loading.error !== null) {
          this.#respondError(events, loading.keys, loading.error)
          return events
        }
        await this.#execute(events, loading.keys, loading.payload.join(''))
        return events
      }
    } else if (keys.m === '1' && isTransmit(keys.a)) {
      const { m: _m, ...rest } = keys
      const started: Loading = { keys: rest, payload: [], length: 0, error: null }
      this.#appendChunk(started, payload)
      this.#loading = started
      return events
    }

    const { m: _m, ...rest } = keys
    await this.#execute(events, rest, payload)
    return events
  }

  #appendChunk(loading: Loading, payload: string): void {
    if (loading.error !== null) return
    loading.length += payload.length
    if (loading.length > this.#maxPayloadBytes) {
      loading.error = new KittyError('EFBIG', `payload exceeds ${this.#maxPayloadBytes} bytes`)
      loading.payload = []
      return
    }
    loading.payload.push(payload)
  }

  async #execute(events: EngineEvent[], keys: Record<string, string>, payload: string): Promise<void> {
    try {
      const action = keys.a === undefined || keys.a === '' ? 't' : keys.a
      switch (action) {
        case 't':
        case 'T':
        case 'q':
          await this.#transmit(events, action, keys, payload)
          return
        case 'p':
          this.#put(events, keys)
          return
        case 'd':
          this.#delete(events, keys)
          return
        case 'f':
        case 'a':
        case 'c':
          throw new KittyError('EINVAL', `animation (a=${action}) is not supported`)
        default:
          throw new KittyError('EINVAL', `unknown action a=${action}`)
      }
    } catch (error) {
      if (!(error instanceof KittyError)) throw error
      this.#respondError(events, keys, error)
    }
  }

  async #transmit(events: EngineEvent[], action: 't' | 'T' | 'q', keys: Record<string, string>, payload: string): Promise<void> {
    const i = uintKey(keys, 'i')
    const number = uintKey(keys, 'I')
    const p = uintKey(keys, 'p')
    if (i !== 0 && number !== 0) throw new KittyError('EINVAL', 'both i and I given')

    const rgba = await decodeImage(keys, payload, {
      readFile: this.#options.readFile,
      deleteFile: this.#options.deleteFile,
      maxImageBytes: this.#maxImageBytes,
      maxPayloadBytes: this.#maxPayloadBytes,
    })
    if (action === 'q') {
      this.#respond(events, keys, { i, I: number }, 'OK')
      return
    }

    const id = i !== 0 ? i : this.#allocateId()
    const replaced = this.#images.get(id)
    let carried: Map<number, Record<string, string>> | undefined
    if (replaced !== undefined) {
      if (isReferenced(replaced)) events.push({ kind: 'delete', imageIds: [id] })
      carried = replaced.virtual
      this.#remove(replaced)
    }
    const image: StoredImage = {
      id,
      number,
      rgba,
      seq: ++this.#seq,
      placements: new Set(),
      anonymousPlacements: 0,
      virtual: new Map(),
    }
    this.#images.set(id, image)
    this.#storeBytes += rgba.data.length
    // Virtual placements outlive a replacement: they show the new pixels.
    if (carried !== undefined) {
      for (const [p, boxKeys] of carried) {
        try {
          this.#placeVirtual(events, image, boxKeys, p)
        } catch (error) {
          if (!(error instanceof KittyError)) throw error
          events.push({ kind: 'log', message: `virtual placement ${p} of image ${id} dropped: ${error.message}` })
        }
      }
    }
    this.#evict(id, events)

    // A response names the image only when the client named it (i or I).
    const named = i !== 0 || number !== 0
    const fields: ResponseFields = { i: named ? id : 0, I: number, p: named ? p : 0 }
    if (action === 'T') {
      try {
        this.#place(events, image, keys, p)
      } catch (error) {
        if (!(error instanceof KittyError)) throw error
        this.#respond(events, keys, fields, error.status)
        return
      }
    }
    this.#respond(events, keys, fields, 'OK')
  }

  #put(events: EngineEvent[], keys: Record<string, string>): void {
    const i = uintKey(keys, 'i')
    const number = uintKey(keys, 'I')
    const p = uintKey(keys, 'p')
    if (i !== 0 && number !== 0) throw new KittyError('EINVAL', 'both i and I given')
    if (i === 0 && number === 0) throw new KittyError('EINVAL', 'put without an image id or number')
    const image = number !== 0 ? this.#newestWithNumber(number) : this.#images.get(i)
    if (image === undefined) {
      throw new KittyError('ENOENT', `put refers to non-existent image with id: ${i} and number: ${number}`)
    }
    this.#touch(image)
    const fields: ResponseFields = { i: image.id, I: number, p }
    try {
      this.#place(events, image, keys, p)
    } catch (error) {
      if (!(error instanceof KittyError)) throw error
      this.#respond(events, keys, fields, error.status)
      return
    }
    this.#respond(events, keys, fields, 'OK')
  }

  /**
   * Emits a `place` event for `image` with the placement keys of `keys`, or,
   * with `U=1`, records a virtual placement and emits a `virtual` event.
   */
  #place(events: EngineEvent[], image: StoredImage, keys: Record<string, string>, p: number): void {
    for (const key of IGNORED_PLACEMENT_KEYS) {
      if (keys[key] !== undefined) this.#logOnce(events, `key:${key}`, `placement key ${key} is ignored`)
    }
    if (keys.U === '1') {
      this.#placeVirtual(events, image, keys, p)
      return
    }
    const { source, columns, rows } = this.#box(image.rgba, keys)
    if (p !== 0) image.placements.add(p)
    else image.anonymousPlacements++
    events.push({
      kind: 'place',
      image: source,
      columns,
      rows,
      cursor: keys.C === '1' ? 'stay' : 'move',
      imageId: image.id,
    })
  }

  /** Records (or replaces) virtual placement `p` of `image` and emits its `virtual` event. */
  #placeVirtual(events: EngineEvent[], image: StoredImage, keys: Record<string, string>, p: number): void {
    const { source, columns, rows } = this.#box(image.rgba, keys)
    const boxKeys: Record<string, string> = {}
    for (const key of BOX_KEYS) {
      const value = keys[key]
      if (value !== undefined) boxKeys[key] = value
    }
    image.virtual.set(p, boxKeys)
    events.push({
      kind: 'virtual',
      imageId: image.id,
      placementId: p !== 0 ? p : undefined,
      image: source,
      columns,
      rows,
    })
  }

  /**
   * The source rectangle (`x,y,w,h`) of `rgba` and the cell box (`c`,`r`) a
   * placement with `keys` covers: both given, as is; one given, the other
   * from the aspect ratio; neither, the source's size in cells.
   */
  #box(rgba: Rgba, keys: Record<string, string>): { source: Rgba; columns: number; rows: number } {
    const x = uintKey(keys, 'x')
    const y = uintKey(keys, 'y')
    const w = uintKey(keys, 'w')
    const h = uintKey(keys, 'h')
    const columnsKey = uintKey(keys, 'c')
    const rowsKey = uintKey(keys, 'r')
    if (x >= rgba.width || y >= rgba.height) {
      throw new KittyError('EINVAL', 'source rectangle lies outside the image')
    }
    const width = Math.min(w === 0 ? rgba.width : w, rgba.width - x)
    const height = Math.min(h === 0 ? rgba.height : h, rgba.height - y)
    const source = crop(rgba, x, y, width, height)

    const cell = this.#options.cellSize()
    const cellWidth = cell.width > 0 ? cell.width : 1
    const cellHeight = cell.height > 0 ? cell.height : 1
    let columns: number
    let rows: number
    if (columnsKey !== 0 && rowsKey !== 0) {
      columns = columnsKey
      rows = rowsKey
    } else if (columnsKey !== 0) {
      columns = columnsKey
      rows = Math.max(1, Math.ceil((columns * cellWidth * height) / width / cellHeight))
    } else if (rowsKey !== 0) {
      rows = rowsKey
      columns = Math.max(1, Math.ceil((rows * cellHeight * width) / height / cellWidth))
    } else {
      columns = Math.ceil(width / cellWidth)
      rows = Math.ceil(height / cellHeight)
    }
    return { source, columns, rows }
  }

  #delete(events: EngineEvent[], keys: Record<string, string>): void {
    const selector = keys.d === undefined || keys.d === '' ? 'a' : keys.d
    const free = selector !== selector.toLowerCase()
    switch (selector.toLowerCase()) {
      case 'a': {
        // kitty: d=a/A leaves virtual placements alone (only i, I, n, N, r, R
        // delete them), and an image they still reference is not freed.
        const ids: number[] = []
        for (const image of [...this.#images.values()]) {
          if (hasPlacements(image)) ids.push(image.id)
          clearPlacements(image)
          if (free && image.virtual.size === 0) this.#remove(image)
        }
        events.push(this.#deleteEvent(ids, []))
        return
      }
      case 'i':
      case 'n': {
        const image =
          selector.toLowerCase() === 'i'
            ? this.#images.get(uintKey(keys, 'i'))
            : this.#newestWithNumber(uintKey(keys, 'I'))
        if (image === undefined) return
        this.#deletePlacements(events, [image], uintKey(keys, 'p'), free)
        return
      }
      case 'r': {
        const from = uintKey(keys, 'x')
        const to = uintKey(keys, 'y')
        const images = [...this.#images.values()].filter((image) => image.id >= from && image.id <= to)
        if (images.length > 0) this.#deletePlacements(events, images, 0, free)
        return
      }
      case 'f':
        events.push({ kind: 'log', message: `delete d=${selector}: animation frames are not supported` })
        return
      case 'c':
      case 'p':
      case 'q':
      case 'x':
      case 'y':
      case 'z':
        events.push({
          kind: 'log',
          message: `delete d=${selector} ignored: placement positions are not tracked`,
        })
        return
      default:
        events.push({ kind: 'log', message: `delete with unknown selector d=${selector} ignored` })
    }
  }

  /** Deletes the placements of `images` (only placement `p` when non-zero); `free` drops unreferenced images. */
  #deletePlacements(events: EngineEvent[], images: StoredImage[], p: number, free: boolean): void {
    const removed: VirtualPlacementKey[] = []
    for (const image of images) {
      if (p !== 0) {
        image.placements.delete(p)
        if (image.virtual.delete(p)) removed.push({ imageId: image.id, placementId: p })
      } else {
        clearPlacements(image)
        for (const key of image.virtual.keys()) removed.push({ imageId: image.id, placementId: key !== 0 ? key : undefined })
        image.virtual.clear()
      }
      if (free && !isReferenced(image)) this.#remove(image)
    }
    events.push(this.#deleteEvent(images.map((image) => image.id), removed))
  }

  /**
   * A `delete` event for `imageIds`. It lists the virtual placements removed
   * only when some of those images keep others; otherwise "absent" (every
   * virtual placement of the images is gone) already says it.
   */
  #deleteEvent(imageIds: number[], removed: VirtualPlacementKey[]): EngineEvent {
    const kept = imageIds.some((id) => (this.#images.get(id)?.virtual.size ?? 0) > 0)
    return kept ? { kind: 'delete', imageIds, virtual: removed } : { kind: 'delete', imageIds }
  }

  #newestWithNumber(number: number): StoredImage | undefined {
    let newest: StoredImage | undefined
    for (const image of this.#images.values()) {
      if (image.number === number && (newest === undefined || image.seq > newest.seq)) newest = image
    }
    return newest
  }

  #allocateId(): number {
    for (;;) {
      const id = this.#nextId
      this.#nextId = id >= 0xffffffff ? FIRST_ALLOCATED_ID : id + 1
      if (!this.#images.has(id)) return id
    }
  }

  #touch(image: StoredImage): void {
    this.#images.delete(image.id)
    this.#images.set(image.id, image)
  }

  #remove(image: StoredImage): void {
    if (this.#images.get(image.id) !== image) return
    this.#images.delete(image.id)
    this.#storeBytes -= image.rgba.data.length
  }

  /** Evicts least recently used images (never `keep`) until the store fits its bound. */
  #evict(keep: number, events: EngineEvent[]): void {
    for (const image of [...this.#images.values()]) {
      if (this.#storeBytes <= this.#maxStoreBytes) return
      if (image.id === keep) continue
      this.#remove(image)
      events.push({ kind: 'log', message: `evicted image ${image.id} to bound image memory` })
      // Its placeholders show nothing from now on, as in kitty.
      if (image.virtual.size > 0) events.push({ kind: 'delete', imageIds: [image.id] })
    }
  }

  #respondError(events: EngineEvent[], keys: Record<string, string>, error: KittyError): void {
    events.push({ kind: 'log', message: `kitty a=${keys.a ?? 't'}: ${error.status}` })
    let fields: ResponseFields
    try {
      fields = { i: uintKey(keys, 'i'), I: uintKey(keys, 'I'), p: uintKey(keys, 'p') }
    } catch {
      // An unparsable id still means the client asked for a response.
      fields = {}
      if (keys.i === undefined && keys.I === undefined) return
      if (quietOf(keys) < 2) events.push({ kind: 'respond', data: encodeResponse(fields, error.status) })
      return
    }
    this.#respond(events, keys, fields, error.status)
  }

  /**
   * Emits a response, following kitty's rules: only when the command named an
   * image (`i` or `I`), `q=1` drops OK, `q=2` drops everything.
   */
  #respond(events: EngineEvent[], keys: Record<string, string>, fields: ResponseFields, status: string): void {
    if (!fields.i && !fields.I) return
    const quiet = quietOf(keys)
    if (quiet >= 2 || (quiet === 1 && status === 'OK')) return
    events.push({ kind: 'respond', data: encodeResponse(fields, status) })
  }

  #logOnce(events: EngineEvent[], tag: string, message: string): void {
    if (this.#logged.has(tag)) return
    this.#logged.add(tag)
    events.push({ kind: 'log', message })
  }
}

function isTransmit(action: string | undefined): boolean {
  return action === undefined || action === '' || action === 't' || action === 'T' || action === 'q' || action === 'f'
}

function hasPlacements(image: StoredImage): boolean {
  return image.anonymousPlacements > 0 || image.placements.size > 0
}

/** Whether anything, a normal or a virtual placement, still uses the image. */
function isReferenced(image: StoredImage): boolean {
  return hasPlacements(image) || image.virtual.size > 0
}

function clearPlacements(image: StoredImage): void {
  image.placements.clear()
  image.anonymousPlacements = 0
}

/** Creates a kitty graphics engine (see `Engine`). */
export function createEngine(options: EngineOptions): KittyEngine {
  return new Engine(options)
}
