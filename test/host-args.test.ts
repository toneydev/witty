// witty's command-line parsing.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseArgs, UsageError } from '../src/host/args.ts'

describe('parseArgs', () => {
  it('defaults to claude with no args', () => {
    const o = parseArgs([])
    assert.equal(o.command, 'claude')
    assert.deepEqual(o.args, [])
    assert.deepEqual(o.cell, { width: 10, height: 20 })
    assert.equal(o.force, true)
    assert.equal(o.inheritCursor, true)
    assert.equal(o.debug, false)
    assert.equal(o.vtInput, 'auto')
  })

  it('turns cursor inheritance off with --no-inherit-cursor', () => {
    const o = parseArgs(['--no-inherit-cursor'])
    assert.equal(o.inheritCursor, false)
    assert.equal(o.command, 'claude')
  })

  it('takes everything from the first non-option token as the command', () => {
    const o = parseArgs(['--cell', '8x16', 'claude', '--resume', '--debug'])
    assert.deepEqual(o.cell, { width: 8, height: 16 })
    assert.equal(o.command, 'claude')
    assert.deepEqual(o.args, ['--resume', '--debug'])
    assert.equal(o.debug, false)
  })

  it('takes everything after -- as the command', () => {
    const o = parseArgs(['--no-force', '--', '--weird-name', 'x'])
    assert.equal(o.force, false)
    assert.equal(o.command, '--weird-name')
    assert.deepEqual(o.args, ['x'])
  })

  it('keeps the default command after a bare --', () => {
    assert.equal(parseArgs(['--debug', '--']).command, 'claude')
  })

  it('parses --log (implying --debug), --opt=value, help, version and the hidden options', () => {
    const o = parseArgs(['--log=C:\\t\\w.log', '--wire', 'x.ts', '--vt-input', 'always', '-h', '--version'])
    assert.equal(o.logFile, 'C:\\t\\w.log')
    assert.equal(o.debug, true)
    assert.equal(o.wire, 'x.ts')
    assert.equal(o.vtInput, 'always')
    assert.equal(o.help, true)
    assert.equal(o.version, true)
  })

  it('rejects unknown options and bad values', () => {
    assert.throws(() => parseArgs(['--nope']), UsageError)
    assert.throws(() => parseArgs(['--cell', 'big']), UsageError)
    assert.throws(() => parseArgs(['--cell']), UsageError)
    assert.throws(() => parseArgs(['--vt-input', 'maybe']), UsageError)
  })

  it('file transports are on by default; --no-files turns them off', () => {
    assert.equal(parseArgs([]).files, true)
    assert.equal(parseArgs(['--no-files', 'claude']).files, false)
    assert.equal(parseArgs(['--', '--no-files']).files, true, 'after -- it belongs to the command')
  })

  it('parses --scale auto|nearest|smooth (default auto) and rejects anything else', () => {
    assert.equal(parseArgs([]).scale, 'auto')
    assert.equal(parseArgs(['--scale', 'nearest']).scale, 'nearest')
    assert.equal(parseArgs(['--scale=smooth', 'claude']).scale, 'smooth')
    assert.equal(parseArgs(['--scale', 'auto', '--', 'x']).scale, 'auto')
    assert.throws(() => parseArgs(['--scale', 'blurry']), /--scale expects auto, nearest or smooth, got "blurry"/)
    assert.throws(() => parseArgs(['--scale', 'Nearest']), UsageError)
    assert.throws(() => parseArgs(['--scale']), UsageError)
  })
})
