// A `--wire` module for the e2e tests: a minimal chunk-safe splitter, an
// engine that answers every kitty command with one 2×1 placement plus an OK
// response, and an emitter that returns a fixed, recognisable DCS.

import type { ApcSplitter, KittyCommand, KittyEngine, PlaceEmitter, SplitItem } from '../../src/types.ts'
import type { Wire, WireOptions } from '../../src/pipeline.ts'

/** The DCS the stub emitter writes for every placement (a tiny valid sixel). */
export const STUB_DCS = '\x1bPq#0;2;100;0;0#0~~\x1b\\'

const START = Buffer.from('\x1b_G', 'latin1')
const END = Buffer.from('\x1b\\', 'latin1')

function parseCommand(body: string): KittyCommand {
  const semi = body.indexOf(';')
  const control = semi < 0 ? body : body.slice(0, semi)
  const payload = semi < 0 ? '' : body.slice(semi + 1)
  const keys: Record<string, string> = {}
  for (const pair of control.split(',')) {
    const eq = pair.indexOf('=')
    if (eq > 0) keys[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  return { keys, payload }
}

/** Length of the longest suffix of `buf` that is a proper prefix of `ESC _ G`. */
function partialStart(buf: Buffer): number {
  for (let n = Math.min(START.length - 1, buf.length); n > 0; n--) {
    if (buf.subarray(buf.length - n).equals(START.subarray(0, n))) return n
  }
  return 0
}

function createStubSplitter(): ApcSplitter {
  let held = Buffer.alloc(0)
  return {
    push(chunk) {
      let buf = Buffer.concat([held, chunk])
      const items: SplitItem[] = []
      for (;;) {
        const start = buf.indexOf(START)
        if (start < 0) {
          const keep = partialStart(buf)
          if (buf.length - keep > 0) items.push({ kind: 'text', data: new Uint8Array(buf.subarray(0, buf.length - keep)) })
          held = Buffer.from(buf.subarray(buf.length - keep))
          return items
        }
        if (start > 0) items.push({ kind: 'text', data: new Uint8Array(buf.subarray(0, start)) })
        const end = buf.indexOf(END, start + START.length)
        if (end < 0) {
          held = Buffer.from(buf.subarray(start))
          return items
        }
        items.push({ kind: 'apc', command: parseCommand(buf.subarray(start + START.length, end).toString('latin1')) })
        buf = buf.subarray(end + END.length)
      }
    },
    flush() {
      const items: SplitItem[] = held.length > 0 ? [{ kind: 'text', data: new Uint8Array(held) }] : []
      held = Buffer.alloc(0)
      return items
    },
  }
}

function createStubEngine(): KittyEngine {
  return {
    async handle(command) {
      // A little latency, as real decoding has.
      await new Promise((resolve) => setTimeout(resolve, 20))
      const id = Number(command.keys.i ?? '0')
      return [
        {
          kind: 'place',
          image: { width: 1, height: 1, data: new Uint8Array([255, 0, 0, 255]) },
          columns: 2,
          rows: 1,
          cursor: 'move',
          imageId: id,
        },
        { kind: 'respond', data: `\x1b_Gi=${id};OK\x1b\\` },
      ]
    },
  }
}

const stubEmitter: PlaceEmitter = () => new TextEncoder().encode(STUB_DCS)

export function createWire(options: WireOptions): Wire {
  options.log(`stub wire, cell ${options.cellSize().width}x${options.cellSize().height}`)
  return { splitter: createStubSplitter(), engine: createStubEngine(), emitter: stubEmitter }
}
