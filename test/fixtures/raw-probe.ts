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

process.stdin.setRawMode(true)
if (phase === 'clear' || phase === 'restore') {
  await setConsoleModes({ inputClear: ENABLE_VIRTUAL_TERMINAL_INPUT })
}
if (phase === 'restore') {
  out(`HELPER ${await ensureVtInput('always')}\r\n`)
}
const modes = await setConsoleModes()
out(`MODES ${modes.inputAfter.toString(16)} ${modes.outputAfter.toString(16)}\r\n`)
out('\x1b[?1000h\x1b[?1006h')
out('READY\r\n')

let typed = ''
process.stdin.on('data', (chunk: Buffer) => {
  out(`IN:${chunk.toString('hex')}\r\n`)
  typed += chunk.toString('latin1')
  if (typed.includes('QUIT')) process.stdout.write('', () => process.exit(0))
})
