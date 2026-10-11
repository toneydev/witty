// The real wiring of the pipeline's three injected pieces. Kept apart from
// cli.ts so tests can swap it out with `--wire <module>`.

import { readFile, unlink } from 'node:fs/promises'
import { createEngine } from './kitty/engine.ts'
import { createSplitter } from './kitty/splitter.ts'
import type { Wire, WireOptions } from './pipeline.ts'
import { createPlaceEmitter } from './term/emit.ts'

export function createWire(options: WireOptions): Wire {
  return {
    splitter: createSplitter(),
    engine: createEngine({
      cellSize: options.cellSize,
      readFile: async (path) => new Uint8Array(await readFile(path)),
      deleteFile: (path) => unlink(path),
    }),
    emitter: createPlaceEmitter({ scale: options.scale ?? 'auto' }),
  }
}
