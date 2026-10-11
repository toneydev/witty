import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSplitter } from '../src/kitty/splitter.ts'
import type { KittyCommand, SplitItem } from '../src/types.ts'

const enc = new TextEncoder()
const bytes = (text: string): Uint8Array => enc.encode(text)
const latin = (data: Uint8Array): string => Buffer.from(data).toString('latin1')

type Normal = { text: string } | { apc: KittyCommand }

/** Merges adjacent text items (across pushes) so chunkings can be compared. */
function normalise(items: SplitItem[]): Normal[] {
  const out: Normal[] = []
  for (const item of items) {
    if (item.kind === 'apc') {
      out.push({ apc: item.command })
      continue
    }
    if (item.data.length === 0) continue
    const last = out[out.length - 1]
    if (last !== undefined && 'text' in last) last.text += latin(item.data)
    else out.push({ text: latin(item.data) })
  }
  return out
}

function run(chunks: Uint8Array[]): Normal[] {
  const splitter = createSplitter()
  const items: SplitItem[] = []
  for (const chunk of chunks) items.push(...splitter.push(chunk))
  items.push(...splitter.flush())
  return normalise(items)
}

const STREAM = 'hello \x1b[31mred\x1b_Ga=T,f=24,s=1,v=1;AAAA\x1b\\ after\x1b_Gi=5;\x1b\\!'
const EXPECTED: Normal[] = [
  { text: 'hello \x1b[31mred' },
  { apc: { keys: { a: 'T', f: '24', s: '1', v: '1' }, payload: 'AAAA' } },
  { text: ' after' },
  { apc: { keys: { i: '5' }, payload: '' } },
  { text: '!' },
]

test('whole stream in one chunk', () => {
  assert.deepEqual(run([bytes(STREAM)]), EXPECTED)
})

test('split at every byte offset into two chunks', () => {
  const data = bytes(STREAM)
  for (let a = 0; a <= data.length; a++) {
    assert.deepEqual(run([data.subarray(0, a), data.subarray(a)]), EXPECTED, `split at ${a}`)
  }
})

test('split at every pair of offsets into three chunks', () => {
  const data = bytes(STREAM)
  for (let a = 0; a <= data.length; a++) {
    for (let b = a; b <= data.length; b++) {
      assert.deepEqual(
        run([data.subarray(0, a), data.subarray(a, b), data.subarray(b)]),
        EXPECTED,
        `split at ${a},${b}`,
      )
    }
  }
})

test('one byte at a time', () => {
  const data = bytes(STREAM)
  const chunks: Uint8Array[] = []
  for (let k = 0; k < data.length; k++) chunks.push(data.subarray(k, k + 1))
  assert.deepEqual(run(chunks), EXPECTED)
})

test('text with no escape passes through at once', () => {
  const splitter = createSplitter()
  assert.deepEqual(normalise(splitter.push(bytes('plain text'))), [{ text: 'plain text' }])
  assert.deepEqual(splitter.flush(), [])
})

test('non-kitty APCs and other escapes pass through promptly', () => {
  const splitter = createSplitter()
  const input = '\x1b_Xother apc\x1b\\\x1bP1$r\x1b\\\x1b]0;title\x07\x1b_\x1b\x1bx'
  assert.deepEqual(normalise(splitter.push(bytes(input))), [{ text: input }])
  assert.deepEqual(splitter.flush(), [])
})

test('a lone ESC at chunk end is held until the next byte', () => {
  const splitter = createSplitter()
  assert.deepEqual(normalise(splitter.push(bytes('abc\x1b'))), [{ text: 'abc' }])
  assert.deepEqual(normalise(splitter.push(bytes('[31m'))), [{ text: '\x1b[31m' }])
})

test('ESC _ at chunk end is held, released when not G', () => {
  const splitter = createSplitter()
  assert.deepEqual(normalise(splitter.push(bytes('x\x1b_'))), [{ text: 'x' }])
  assert.deepEqual(normalise(splitter.push(bytes('Pq'))), [{ text: '\x1b_Pq' }])
})

test('flush releases a held ESC and a partial APC as text', () => {
  const a = createSplitter()
  a.push(bytes('abc\x1b'))
  assert.deepEqual(normalise(a.flush()), [{ text: '\x1b' }])

  const b = createSplitter()
  assert.deepEqual(b.push(bytes('\x1b_Ga=T;AAA')), [])
  assert.deepEqual(normalise(b.flush()), [{ text: '\x1b_Ga=T;AAA' }])

  const c = createSplitter()
  c.push(bytes('\x1b_Ga=T;AAA\x1b'))
  assert.deepEqual(normalise(c.flush()), [{ text: '\x1b_Ga=T;AAA\x1b' }])
  assert.deepEqual(c.flush(), [])
})

test('an ESC that is not ST aborts the APC; the bytes pass through', () => {
  assert.deepEqual(run([bytes('\x1b_Ga=T;AA\x1b[31mX')]), [{ text: '\x1b_Ga=T;AA\x1b[31mX' }])
  // The aborting ESC may itself start a new kitty APC.
  assert.deepEqual(run([bytes('\x1b_Ga=T;AA'), bytes('\x1b_Gi=1;\x1b\\')]), [
    { text: '\x1b_Ga=T;AA' },
    { apc: { keys: { i: '1' }, payload: '' } },
  ])
})

test('an oversized APC is abandoned and passed through as text', () => {
  const splitter = createSplitter({ maxApcBytes: 16 })
  const items = [
    ...splitter.push(bytes('a\x1b_Ga=T;0123456789')),
    ...splitter.push(bytes('abcdefghij')),
    ...splitter.push(bytes('KLM\x1b\\b\x1b_Gi=2;\x1b\\')),
    ...splitter.flush(),
  ]
  assert.deepEqual(normalise(items), [
    { text: 'a\x1b_Ga=T;0123456789abcdefghijKLM\x1b\\b' },
    { apc: { keys: { i: '2' }, payload: '' } },
  ])
})

test('oversized APC: held bytes are released as soon as the limit is crossed', () => {
  const splitter = createSplitter({ maxApcBytes: 4 })
  assert.deepEqual(splitter.push(bytes('\x1b_Gab')), [])
  assert.deepEqual(normalise(splitter.push(bytes('cdef'))), [{ text: '\x1b_Gabcdef' }])
})

test('large payloads beyond 4096 base64 characters', () => {
  const payload = 'A'.repeat(100_000)
  const data = bytes(`\x1b_Ga=t,i=1;${payload}\x1b\\`)
  const chunks: Uint8Array[] = []
  for (let k = 0; k < data.length; k += 777) chunks.push(data.subarray(k, k + 777))
  assert.deepEqual(run(chunks), [{ apc: { keys: { a: 't', i: '1' }, payload } }])
})

test('pushed chunks may be reused by the caller once an APC is held', () => {
  const splitter = createSplitter()
  const buf = new Uint8Array(64)
  const first = bytes('\x1b_Gi=1;AB')
  buf.set(first)
  splitter.push(buf.subarray(0, first.length))
  buf.fill(0x7a)
  const second = bytes('CD\x1b\\')
  buf.set(second)
  assert.deepEqual(normalise(splitter.push(buf.subarray(0, second.length))), [
    { apc: { keys: { i: '1' }, payload: 'ABCD' } },
  ])
})
