import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KittyError, encodeResponse, parseKittyCommand, uintKey } from '../src/kitty/command.ts'

test('parses keys and payload', () => {
  assert.deepEqual(parseKittyCommand('a=T,f=100,i=31;iVBORw0KGgo='), {
    keys: { a: 'T', f: '100', i: '31' },
    payload: 'iVBORw0KGgo=',
  })
})

test('no semicolon means keys only', () => {
  assert.deepEqual(parseKittyCommand('a=d,d=A'), { keys: { a: 'd', d: 'A' }, payload: '' })
})

test('empty payload after semicolon', () => {
  assert.deepEqual(parseKittyCommand('a=q,i=1;'), { keys: { a: 'q', i: '1' }, payload: '' })
})

test('empty body', () => {
  assert.deepEqual(parseKittyCommand(''), { keys: {}, payload: '' })
  assert.deepEqual(parseKittyCommand(';'), { keys: {}, payload: '' })
})

test('only the first semicolon splits; payload kept verbatim', () => {
  assert.deepEqual(parseKittyCommand('m=1;ab;c=d,e'), { keys: { m: '1' }, payload: 'ab;c=d,e' })
})

test('empty pairs skipped, bare keys get empty values, last repeat wins, values keep "="', () => {
  assert.deepEqual(parseKittyCommand(',a=t,,U,i=1,i=2,x=a=b;'), {
    keys: { a: 't', U: '', i: '2', x: 'a=b' },
    payload: '',
  })
})

test('encodes responses', () => {
  assert.equal(encodeResponse({ i: 1, I: 2 }, 'OK'), '\x1b_Gi=1,I=2;OK\x1b\\')
  assert.equal(encodeResponse({ i: 1 }, 'EINVAL:message'), '\x1b_Gi=1;EINVAL:message\x1b\\')
  assert.equal(encodeResponse({ i: 7, p: 3 }, 'OK'), '\x1b_Gi=7,p=3;OK\x1b\\')
  assert.equal(encodeResponse({ i: 7, I: 0, p: undefined }, 'OK'), '\x1b_Gi=7;OK\x1b\\')
})

test('uintKey reads unsigned integers and rejects junk', () => {
  assert.equal(uintKey({ s: '640' }, 's'), 640)
  assert.equal(uintKey({}, 's'), 0)
  assert.equal(uintKey({ s: '' }, 's', 5), 5)
  assert.equal(uintKey({ i: '4294967295' }, 'i'), 0xffffffff)
  for (const bad of ['-1', '1.5', 'abc', '4294967296', '0x10']) {
    assert.throws(() => uintKey({ i: bad }, 'i'), (error: unknown) => error instanceof KittyError && error.code === 'EINVAL')
  }
})

test('responses are sanitised: printable ASCII only, no ; or backslash, status capped at 128', () => {
  const dirty = 'EINVAL:a\x18b\rc\nd\x7fe;f\\g\x1bh\x07i\u{1F600}j\u{E9}'
  assert.equal(encodeResponse({ i: 1 }, dirty), '\x1b_Gi=1;EINVAL:a?b?c?d?e?f?g?h?i?j?\x1b\\')
  const long = encodeResponse({ i: 1 }, `EINVAL:${'x'.repeat(500)}`)
  assert.equal(long.length, '\x1b_Gi=1;'.length + 128 + 2)
  for (const ch of long.slice('\x1b_Gi=1;'.length, -2)) assert.ok(ch >= ' ' && ch <= '~' && ch !== ';' && ch !== '\\')
})

test('bad key values are never echoed in the message', () => {
  const value = 'x\x18\r\n\x7f;'
  assert.throws(
    () => uintKey({ s: value }, 's'),
    (error: unknown) => error instanceof KittyError && !error.message.includes(value) && !/[\x00-\x1f\x7f;]/.test(error.message),
  )
})
