// The output pipeline: child output bytes → splitter → (text | kitty command)
// → outer terminal, with every byte kept in its original order.
//
// Text is written through synchronously while nothing is in flight. As soon
// as a kitty command is being handled (engine.handle is async: decoding,
// file reads), everything after it — text and later commands — waits in one
// serial queue behind it, so an image always lands exactly where its APC was.
//
// Every text item also goes through the unicode placeholder pass, at the
// moment it is written (so in byte order, and after the events of every
// command before it): `virtual` and `delete` events keep the registry of
// virtual placements the pass draws placeholder cells from.

import type { ApcSplitter, CellSize, EngineEvent, KittyCommand, KittyEngine, PlaceEmitter, PlaceholderPass, ScaleMode, SplitItem } from './types.ts'
import { VirtualPlacements, createPlaceholderPass } from './term/placeholders.ts'

export type PipelineOptions = {
  splitter: ApcSplitter
  engine: KittyEngine
  emitter: PlaceEmitter
  /** Current cell size, read at each placement. */
  cellSize: () => CellSize
  /**
   * Writes to the outer terminal. May return a promise (e.g. resolving on
   * 'drain'); later output then waits for it, so nothing is dropped or
   * reordered under backpressure.
   */
  writeOut: (bytes: Uint8Array) => void | Promise<unknown>
  /** Writes a response to the child's input. */
  writeChild: (data: string) => void
  /** Diagnostic lines (`--debug`). */
  log?: (line: string) => void
  /**
   * How long the placeholder pass may hold a trailing run with no new chunk
   * before it is flushed anyway, in ms. Default 25; 0 disables the timer.
   */
  idleFlushMs?: number
  /** How virtual placements are scaled to their cell box (`--scale`). Default 'auto'. */
  scale?: ScaleMode
}

/** Default for `PipelineOptions.idleFlushMs`. */
export const DEFAULT_IDLE_FLUSH_MS = 25

/** What `createWire` receives: the live cell size and the logger. */
export type WireOptions = {
  cellSize: () => CellSize
  log: (line: string) => void
  /** How placed images are scaled to their cell box (`--scale`). Default 'auto'. */
  scale?: ScaleMode
}

/** The three injected pieces of the pipeline. */
export type Wire = {
  splitter: ApcSplitter
  engine: KittyEngine
  emitter: PlaceEmitter
}

/** The factory `src/wire.ts` (and any hidden `--wire <module>`) exports as `createWire`. */
export type WireFactory = (options: WireOptions) => Wire | Promise<Wire>

export interface Pipeline {
  /** Processes one chunk of child output. Resolves when all of it has been written. */
  feed(chunk: Uint8Array): Promise<void>
  /** Flushes the splitter at end of stream and waits for the queue to drain. */
  end(): Promise<void>
  /** Number of queued tasks (commands being handled, output waiting behind them). */
  readonly pending: number
}

function isPromise(value: unknown): value is Promise<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === 'function'
}

/** Describes a command for the log without its payload. */
function describe(command: KittyCommand): string {
  const keys = Object.entries(command.keys)
    .map(([k, v]) => `${k}=${v}`)
    .join(',')
  return `apc ${keys} (payload ${command.payload.length} bytes)`
}

export function createPipeline(options: PipelineOptions): Pipeline {
  const { splitter, engine, emitter, cellSize, writeOut, writeChild } = options
  const log = options.log ?? (() => {})

  let pending = 0
  let tail: Promise<void> = Promise.resolve()

  const virtualPlacements = new VirtualPlacements()
  const placeholders: PlaceholderPass = createPlaceholderPass({
    registry: virtualPlacements,
    cellSize,
    log,
    scale: options.scale ?? 'auto',
  })

  const idleFlushMs = options.idleFlushMs ?? DEFAULT_IDLE_FLUSH_MS
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let ended = false

  const cancelIdleFlush = (): void => {
    if (idleTimer === undefined) return
    clearTimeout(idleTimer)
    idleTimer = undefined
  }

  /** The placeholder pass over one text item; a failure in it must not eat output. */
  const transform = (data: Uint8Array): Uint8Array => {
    let out: Uint8Array
    try {
      out = placeholders.push(data)
    } catch (error) {
      log(`placeholder pass error: ${error instanceof Error ? error.message : String(error)}`)
      out = data
    }
    armIdleFlush()
    return out
  }

  /** Writes already transformed bytes (nothing when empty). */
  const write = (bytes: Uint8Array): void | Promise<unknown> => (bytes.length > 0 ? writeOut(bytes) : undefined)

  /** Writes whatever the placeholder pass holds, at the current point of the byte stream. */
  const flushPlaceholders = (): void | Promise<unknown> => {
    cancelIdleFlush()
    if (!placeholders.holding) return undefined
    try {
      return write(placeholders.flush())
    } catch (error) {
      log(`placeholder flush error: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /**
   * (Re)starts the idle timer while the pass holds a trailing run, so an
   * image row that ends a frame is drawn even if the child goes quiet. When it
   * fires with work in flight, the flush queues behind that work.
   */
  function armIdleFlush(): void {
    cancelIdleFlush()
    if (ended || idleFlushMs <= 0 || !placeholders.holding) return
    idleTimer = setTimeout(() => {
      idleTimer = undefined
      log('placeholder pass idle: flushing a held run')
      if (pending === 0) {
        const result = flushPlaceholders()
        if (isPromise(result)) enqueue(() => result)
      } else {
        enqueue(flushPlaceholders)
      }
    }, idleFlushMs)
    idleTimer.unref?.()
  }

  /** Appends a task to the serial queue; a failing task is logged and the queue goes on. */
  const enqueue = (task: () => unknown): void => {
    pending++
    tail = tail
      .then(task)
      .then(
        () => {},
        (error: unknown) => log(`pipeline error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`),
      )
      .finally(() => {
        pending--
      })
  }

  const writeText = (data: Uint8Array): void => {
    if (data.length === 0) return
    if (pending === 0) {
      const result = write(transform(data))
      // Backpressure: hold everything after this write until it is accepted.
      if (isPromise(result)) enqueue(() => result)
    } else {
      enqueue(() => write(transform(data)))
    }
  }

  const apply = async (event: EngineEvent): Promise<void> => {
    switch (event.kind) {
      case 'place': {
        log(`place image ${event.imageId} ${event.image.width}x${event.image.height} in ${event.columns}x${event.rows} cells, cursor ${event.cursor}`)
        await writeOut(emitter(event, cellSize()))
        break
      }
      case 'virtual':
        log(`virtual placement of image ${event.imageId}${event.placementId === undefined ? '' : ` placement ${event.placementId}`} ${event.image.width}x${event.image.height} in ${event.columns}x${event.rows} cells`)
        virtualPlacements.set({
          imageId: event.imageId,
          placementId: event.placementId,
          image: event.image,
          columns: event.columns,
          rows: event.rows,
        })
        break
      case 'respond':
        writeChild(event.data)
        break
      case 'delete':
        log(`delete images ${event.imageIds.join(',') || '(none)'}`)
        virtualPlacements.delete(event.imageIds, event.virtual)
        break
      case 'log':
        log(event.message)
        break
    }
  }

  const handleCommand = (command: KittyCommand): void => {
    enqueue(async () => {
      // A held placeholder run comes before this command in the byte stream,
      // and the command ends it: write it before the command's own output.
      await flushPlaceholders()
      log(describe(command))
      let events: EngineEvent[]
      try {
        events = await engine.handle(command)
      } catch (error) {
        log(`engine error: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      for (const event of events) {
        try {
          await apply(event)
        } catch (error) {
          log(`${event.kind} failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    })
  }

  const run = (items: SplitItem[]): Promise<void> => {
    for (const item of items) {
      if (item.kind === 'text') writeText(item.data)
      else handleCommand(item.command)
    }
    return pending === 0 ? Promise.resolve() : tail
  }

  return {
    feed(chunk) {
      // New output: the held run may continue in it, so no idle flush now.
      cancelIdleFlush()
      let items: SplitItem[]
      try {
        items = splitter.push(chunk)
      } catch (error) {
        // A splitter bug must not eat output: pass the chunk on as text.
        log(`splitter error: ${error instanceof Error ? error.message : String(error)}`)
        items = [{ kind: 'text', data: chunk }]
      }
      const done = run(items)
      // Still holding (e.g. this chunk had no text): wait again, from now.
      if (idleTimer === undefined) armIdleFlush()
      return done
    },
    async end() {
      ended = true
      cancelIdleFlush()
      let items: SplitItem[] = []
      try {
        items = splitter.flush()
      } catch (error) {
        log(`splitter flush error: ${error instanceof Error ? error.message : String(error)}`)
      }
      await run(items)
      // Anything the placeholder pass still holds goes out last.
      enqueue(flushPlaceholders)
      await tail
      cancelIdleFlush()
    },
    get pending() {
      return pending
    },
  }
}
