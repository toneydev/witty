// The real wiring of the pipeline's three injected pieces. Kept apart from
// cli.ts so tests can swap it out with `--wire <module>`.

import { createEngine } from './kitty/engine.ts'
import { createFileAccess } from './kitty/files.ts'
import { createSplitter } from './kitty/splitter.ts'
import type { Wire, WireOptions } from './pipeline.ts'
import { createPlaceEmitter } from './term/emit.ts'

export function createWire(options: WireOptions): Wire {
  // The file transports read paths the child names: only under the policy in
  // kitty/files.ts, and not at all with --no-files (then t=f/t=t are EINVAL).
  const files = options.files === false ? undefined : createFileAccess()
  return {
    splitter: createSplitter(),
    engine: createEngine({
      cellSize: options.cellSize,
      ...(files === undefined ? {} : { readFile: files.readFile, deleteFile: files.deleteFile }),
    }),
    emitter: createPlaceEmitter({ scale: options.scale ?? 'auto' }),
  }
}
