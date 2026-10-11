// Console-mode probe for test/host-console.test.ts. Puts stdin in raw mode
// as witty does, then optionally manipulates the console input mode:
//   argv[2] = 'raw'      : raw mode only
//   argv[2] = 'clear'    : raw mode, then clear ENABLE_VIRTUAL_TERMINAL_INPUT
//                          (what a raw mode without RAW_VT looks like)
//   argv[2] = 'restore'  : as 'clear', then ensureVtInput('always')
// It prints `MODES <in> <out>` (hex), enables SGR mouse tracking, prints
// READY, then `IN:<hex>` for every chunk read; `QUIT` exits.

import {
  ENABLE_VIRTUAL_TERMINAL_INPUT,
  ensureVtInput,
  setConsoleModes,
} from '../../src/host/console.ts'

const phase = process.argv[2] ?? 'raw'
const out = (s: string): void => {
  process.stdout.write(s)
}

/** Reports a helper failure as one line (`HELPER:failed <step> <json message>`) instead of crashing. */
const failed = (step: string, error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error)
  out(`HELPER:failed ${step} ${JSON.stringify(message)}\r\n`)
}

process.stdin.setRawMode(true)
if (phase === 'clear' || phase === 'restore') {
  try {
    await setConsoleModes({ inputClear: ENABLE_VIRTUAL_TERMINAL_INPUT })
  } catch (error) {
    failed('clear', error)
  }
}
if (phase === 'restore') {
  // ensureVtInput never throws; a failure comes back as its log line.
  const line = await ensureVtInput('always')
  out(`HELPER ${line}\r\n`)
  if (!/helper set modes/.test(line)) failed('restore', line)
}
try {
  const modes = await setConsoleModes()
  out(`MODES ${modes.inputAfter.toString(16)} ${modes.outputAfter.toString(16)}\r\n`)
} catch (error) {
  out('MODES unknown\r\n')
  failed('modes', error)
}
out('\x1b[?1000h\x1b[?1006h')
out('READY\r\n')

let typed = ''
process.stdin.on('data', (chunk: Buffer) => {
  out(`IN:${chunk.toString('hex')}\r\n`)
  typed += chunk.toString('latin1')
  if (typed.includes('QUIT')) process.stdout.write('', () => process.exit(0))
})
