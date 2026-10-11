// A stand-in for Claude Code in the e2e tests. It turns on SGR mouse
// tracking, prints text around one kitty APC, then reports every byte it
// reads as `IN:<hex>` and its width after each resize as `COLS:<n>`.
// Typing `QUIT` makes it exit with the code given as argv[2] (default 0).

const exitCode = Number(process.argv[2] ?? '0')
process.stdin.setRawMode(true)

const out = (s: string): void => {
  process.stdout.write(s)
}

out('\x1b[?1000h\x1b[?1006h')
out('BEFORE<\x1b_Ga=T,f=100,i=7;QUJD\x1b\\>AFTER\r\n')
out(`COLS:${process.stdout.columns}\r\n`)
out('READY\r\n')

let typed = ''
process.stdin.on('data', (chunk: Buffer) => {
  out(`IN:${chunk.toString('hex')}\r\n`)
  typed += chunk.toString('latin1')
  if (typed.includes('QUIT')) {
    out('BYE\r\n')
    process.stdout.write('', () => process.exit(exitCode))
  }
})

process.stdout.on('resize', () => {
  out(`COLS:${process.stdout.columns}\r\n`)
})
