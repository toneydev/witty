// A `--wire` module for the exit-path e2e tests: the stub wire, plus two
// control keys on a kitty command. `slow=<ms>` holds the command (and with it
// the child's output, as a large image does) for that long; `crash=1` throws
// outside the pipeline, as a bug in witty would, to exercise the crash path.

import type { Wire, WireOptions } from '../../src/pipeline.ts'
import { createWire as createStubWire } from './stub-wire.ts'

export function createWire(options: WireOptions): Wire {
  const wire = createStubWire(options)
  const engine = wire.engine
  return {
    ...wire,
    engine: {
      async handle(command) {
        const slow = Number(command.keys.slow ?? '0')
        if (slow > 0) {
          options.log(`hooks wire: holding the output ${slow} ms`)
          await new Promise((resolve) => setTimeout(resolve, slow))
        }
        if (command.keys.crash === '1') {
          setTimeout(() => {
            throw new Error('boom from the hooks wire')
          }, 0)
        }
        return engine.handle(command)
      },
    },
  }
}
