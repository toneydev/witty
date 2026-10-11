// Capture the raw output of Claude Code running directly in a bundled ConPTY, with images
// forced on, and summarise the kitty graphics commands and placeholder cells it emitted.
//
//   node tools/capture-claude.mjs [--mod <plugin dir>] [--claude <path to claude.exe>] [--seconds 15]
//
// Defaults: the probe mod in examples/witty-probe, `claude` from PATH, 15 seconds.
// Writes the raw bytes to capture.bin in the current directory.
import pty from 'node-pty'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback }
const here = path.dirname(fileURLToPath(import.meta.url))
const mod = path.resolve(opt('--mod', path.join(here, '..', 'examples', 'witty-probe')))
const claude = opt('--claude', 'claude')
const seconds = Number(opt('--seconds', '15'))

const env = { ...process.env, CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' }
delete env.CLAUDECODE; delete env.CLAUDE_CODE_CHILD_SESSION; delete env.CLAUDE_CODE_SESSION_ID
const file = claude.endsWith('.exe') || claude.includes('\\') || claude.includes('/') ? claude : `${claude}.exe`
const p = pty.spawn(file, ['--plugin-dir', mod], { cols: 120, rows: 40, useConptyDll: true, env, cwd: process.cwd() })
const chunks = []
p.onData(d => {
  chunks.push(Buffer.from(d, 'utf8'))
  if (d.includes('\x1b[c')) p.write('\x1b[?62;4c')
  if (d.includes('\x1b[16t')) p.write('\x1b[6;19;9t')
  if (d.includes('\x1b[14t')) p.write('\x1b[4;760;1080t')
  if (d.includes('\x1b[18t')) p.write('\x1b[8;40;120t')
})
setTimeout(() => {
  const all = Buffer.concat(chunks)
  fs.writeFileSync('capture.bin', all)
  const s = all.toString('latin1')
  const apcs = [...s.matchAll(/\x1b_G([^\x1b]*)\x1b\\/g)].map(m => {
    const semi = m[1].indexOf(';')
    return semi < 0 ? m[1] : `${m[1].slice(0, semi)};<${m[1].length - semi - 1} payload bytes>`
  })
  console.log('bytes', all.length, '| APC commands:', apcs.length)
  for (const a of apcs.slice(0, 12)) console.log('  ', a)
  console.log('U+10EEEE placeholder cells:', all.toString('utf8').split('\u{10EEEE}').length - 1)
  p.kill(); setTimeout(() => process.exit(0), 500)
}, seconds * 1000)
