// A child for the exit-path e2e tests. It prints READY; typing QUIT makes it
// send one kitty command (control keys from argv[3], e.g. `slow=2000` for the
// hooks wire) followed by BYE, and then exit with the code in argv[2], unless
// argv[4] is `stay`.

const exitCode = Number(process.argv[2] ?? '0')
const keys = process.argv[3] ?? ''
const stay = process.argv[4] === 'stay'
process.stdin.setRawMode(true)

process.stdout.write('READY\r\n')

let typed = ''
let quitting = false
process.stdin.on('data', (chunk: Buffer) => {
  typed += chunk.toString('latin1')
  if (quitting || !typed.includes('QUIT')) return
  quitting = true
  process.stdout.write(`\x1b_Ga=T,f=100,i=9${keys === '' ? '' : `,${keys}`};QUJD\x1b\\BYE\r\n`, () => {
    if (!stay) process.exit(exitCode)
  })
})
