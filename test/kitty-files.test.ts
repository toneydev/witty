// The file transport policy (src/kitty/files.ts) and its use by the engine.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { parseKittyCommand } from '../src/kitty/command.ts'
import { createEngine } from '../src/kitty/engine.ts'
import { FileAccessError, checkFilePath, createFileAccess, isDeletableTempFile, isDosDevice } from '../src/kitty/files.ts'
import type { EngineEvent, FileRange } from '../src/types.ts'
import { createWire } from '../src/wire.ts'

const root = mkdtempSync(path.join(os.tmpdir(), 'witty-files-'))
after(() => rmSync(root, { recursive: true, force: true }))

/** A fake temp directory and a sibling "outside" directory, both under root. */
const tmp = path.join(root, 'tmp')
const outside = path.join(root, 'outside')
mkdirSync(tmp)
mkdirSync(outside)

const RGBA = Uint8Array.of(1, 2, 3, 255)
const write = (p: string, data: Uint8Array = RGBA): string => {
  writeFileSync(p, data)
  return p
}
const range = (maxBytes = 1024, offset = 0, size = 0): FileRange => ({ offset, size, maxBytes })
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')
const FAILED = '\x1b_Gi=1;EBADF:Failed to read image file\x1b\\'
const responses = (events: EngineEvent[]): string[] => events.flatMap((ev) => (ev.kind === 'respond' ? [ev.data] : []))

/** Expects `promise` to reject with exactly the uniform FileAccessError. */
async function refused(promise: Promise<unknown>, label: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof FileAccessError, `${label}: ${String(error)}`)
    assert.equal((error as Error).message, 'Failed to read image file', label)
    return true
  })
}

describe('file path rules', () => {
  it('accepts absolute drive paths only', () => {
    for (const p of ['C:\\x\\image.png', 'c:/x/image.png', 'D:\\a b\\console.png', 'C:\\x\\com10.png', 'C:\\x\\nul-ish.png']) {
      assert.ok(checkFilePath(p) !== undefined, p)
    }
    assert.equal(checkFilePath('C:\\x\\..\\y\\i.png'), 'C:\\y\\i.png')
  })

  it('rejects UNC, device namespaces, relative paths, NUL, streams and DOS devices', () => {
    const rejected = [
      '',
      'image.png',
      '.\\image.png',
      '..\\image.png',
      '\\image.png',
      '/image.png',
      'C:image.png',
      '\\\\server\\share\\image.png',
      '//server/share/image.png',
      '\\/server/share/image.png',
      '/\\server\\share\\image.png',
      '\\\\.\\pipe\\witty',
      '\\\\?\\C:\\x\\image.png',
      '\\\\.\\C:\\x\\image.png',
      'C:\\x\\ima\0ge.png',
      'C:\\x\\image.png:hidden',
      'C:\\x\\image.png::$DATA',
      'C:\\x\\NUL',
      'C:\\x\\nul.png',
      'C:\\x\\Con.txt',
      'C:\\x\\PRN',
      'C:\\x\\aux .png',
      'C:\\x\\COM1',
      'c:\\x\\com9.log',
      'C:\\x\\LPT1.png',
      'C:\\x\\lpt9',
    ]
    for (const p of rejected) assert.equal(checkFilePath(p), undefined, JSON.stringify(p))
  })

  it('recognises DOS device stems case-insensitively', () => {
    for (const name of ['CON', 'con.png', 'Aux', 'nUl.tar.gz', 'COM5', 'lpt3.x', 'PRN ']) assert.ok(isDosDevice(name), name)
    for (const name of ['CONSOLE', 'com0', 'com10', 'lpt', 'icon.png', 'null']) assert.ok(!isDosDevice(name), name)
  })
})

describe('file reads', () => {
  const files = createFileAccess({ tmpdir: tmp })

  it('reads a regular file within the limits', async () => {
    const p = write(path.join(outside, 'ok.rgba'))
    assert.deepEqual(await files.readFile(p, range()), RGBA)
    assert.deepEqual(await files.readFile(p, range(4, 1, 3)), RGBA)
  })

  it('refuses every rejected path class with the same error, before touching the disk', async () => {
    for (const p of ['rel.png', '\\\\server\\share\\x.png', '//server/share/x.png', '\\\\.\\pipe\\x', '\\\\?\\C:\\x', 'C:\\x\\NUL', 'C:\\a\0b']) {
      await refused(files.readFile(p, range()), p)
    }
  })

  it('refuses directories, missing files, oversized files and ranges outside the file', async () => {
    await refused(files.readFile(outside, range()), 'directory')
    await refused(files.readFile(path.join(outside, 'missing.png'), range()), 'missing')
    const big = write(path.join(outside, 'big.rgba'), new Uint8Array(2048))
    await refused(files.readFile(big, range(1024)), 'over maxBytes')
    const small = write(path.join(outside, 'small.rgba'))
    await refused(files.readFile(small, range(1024, 5)), 'offset past the end')
    await refused(files.readFile(small, range(1024, 2, 3)), 'offset + size past the end')
  })

  it('refuses a symlink, even to a readable file', async (t) => {
    const target = write(path.join(outside, 'target.rgba'))
    const link = path.join(outside, 'link.rgba')
    try {
      symlinkSync(target, link, 'file')
    } catch (error) {
      t.skip(`symlink creation not permitted here (${(error as NodeJS.ErrnoException).code})`)
      return
    }
    await refused(files.readFile(link, range()), 'symlink')
  })
})

describe('t=t deletion', () => {
  it('deletes only temp files inside the temp directory whose basename has the marker', () => {
    assert.ok(isDeletableTempFile(path.join(tmp, 'tty-graphics-protocol-1.png'), tmp))
    assert.ok(isDeletableTempFile(path.join(tmp, 'sub', 'x-tty-graphics-protocol'), tmp))
    // The marker in a directory name, then ..\ out of it: resolves to tmp\victim.txt.
    assert.ok(!isDeletableTempFile(`${tmp}\\tty-graphics-protocol\\..\\victim.txt`, tmp))
    assert.ok(!isDeletableTempFile(`${tmp}\\..\\outside\\tty-graphics-protocol.png`, tmp))
    assert.ok(!isDeletableTempFile(path.join(outside, 'tty-graphics-protocol.png'), tmp))
    assert.ok(!isDeletableTempFile(path.join(tmp, 'precious.png'), tmp))
    assert.ok(!isDeletableTempFile(tmp, tmp))
    assert.ok(!isDeletableTempFile('\\\\server\\share\\tty-graphics-protocol.png', tmp))
  })

  it('the engine deletes a temp file after reading it, and never a victim behind ..\\', async () => {
    const files = createFileAccess({ tmpdir: tmp })
    const engine = createEngine({ cellSize: () => ({ width: 10, height: 20 }), ...files })
    const temp = write(path.join(tmp, 'tty-graphics-protocol-abc.rgba'))
    const ok = await engine.handle(parseKittyCommand(`a=T,t=t,f=32,s=1,v=1,i=1;${b64(temp)}`))
    assert.deepEqual(responses(ok), ['\x1b_Gi=1;OK\x1b\\'])
    assert.ok(!existsSync(temp), 'the temp file is gone')

    const victim = write(path.join(tmp, 'victim.txt'))
    mkdirSync(path.join(tmp, 'tty-graphics-protocol'), { recursive: true })
    const bypass = `${tmp}\\tty-graphics-protocol\\..\\victim.txt`
    await engine.handle(parseKittyCommand(`a=T,t=t,f=32,s=1,v=1,i=1;${b64(bypass)}`))
    assert.ok(existsSync(victim), 'the ..\\ bypass must not delete')
    // A failed decode deletes nothing outside the rule either.
    const outsideTemp = write(path.join(outside, 'tty-graphics-protocol-x.png'), Uint8Array.of(0))
    const bad = await engine.handle(parseKittyCommand(`a=T,t=t,f=100,i=1;${b64(outsideTemp)}`))
    assert.deepEqual(responses(bad), [FAILED])
    assert.ok(existsSync(outsideTemp))
  })
})

describe('engine with the real file access', () => {
  it('answers every file failure with the one uniform status', async () => {
    const engine = createEngine({ cellSize: () => ({ width: 10, height: 20 }), ...createFileAccess({ tmpdir: tmp }) })
    const big = write(path.join(outside, 'huge.rgba'), new Uint8Array(4096))
    const tiny = write(path.join(outside, 'tiny.rgba'))
    const cases = [
      `a=T,t=f,f=32,s=1,v=1,i=1;${b64(path.join(outside, 'missing.rgba'))}`,
      `a=T,t=f,f=32,s=1,v=1,i=1;${b64(outside)}`,
      `a=T,t=f,f=32,s=1,v=1,i=1;${b64('\\\\server\\share\\x.rgba')}`,
      `a=T,t=f,f=32,s=1,v=1,i=1;${b64('relative.rgba')}`,
      `a=T,t=f,f=32,s=1,v=1,i=1;${b64('C:\\x\\CON')}`,
      `a=T,t=f,f=32,s=1,v=1,i=1;${b64('C:\\a\0b')}`,
      `a=T,t=f,f=32,s=1,v=1,i=1;`,
      `a=T,t=f,f=32,s=1,v=1,i=1,O=9;${b64(tiny)}`,
    ]
    for (const body of cases) assert.deepEqual(responses(await engine.handle(parseKittyCommand(body))), [FAILED], body)
    const limited = createEngine({ cellSize: () => ({ width: 10, height: 20 }), maxImageBytes: 1024, ...createFileAccess() })
    assert.deepEqual(responses(await limited.handle(parseKittyCommand(`a=T,t=f,f=32,s=1,v=1,i=1;${b64(big)}`))), [FAILED])
  })

  it('answers a file that reads but does not decode exactly like a missing one', async () => {
    const engine = createEngine({ cellSize: () => ({ width: 10, height: 20 }), ...createFileAccess({ tmpdir: tmp }) })
    const text = write(path.join(outside, 'text.txt'), new Uint8Array(12345).fill(0x61))
    const missing = path.join(outside, 'no-such-file.txt')
    const notZlib = write(path.join(outside, 'not-zlib.bin'), Buffer.from('garbage'))
    const cases = [
      `a=t,t=f,f=100,i=1;${b64(text)}`, // not a PNG (EBADPNG)
      `a=t,t=f,f=100,i=1;${b64(missing)}`, // the read fails
      `a=t,t=f,f=32,s=1000,v=1000,i=1;${b64(text)}`, // too short: ENODATA, which echoed the size
      `a=t,t=f,f=32,s=1,v=1,o=z,i=1;${b64(notZlib)}`, // inflate fails (EINVAL)
      `a=t,t=f,f=32,s=100000,v=100000,i=1;${b64(text)}`, // larger than the image limit (EFBIG)
      `a=t,t=f,f=32,s=0,v=1,i=1;${b64(text)}`, // zero width (EINVAL)
      `a=t,t=f,f=32,s=1,v=1,O=x,i=1;${b64(text)}`, // malformed offset (EINVAL)
    ]
    for (const body of cases) assert.deepEqual(responses(await engine.handle(parseKittyCommand(body))), [FAILED], body)
    // The same bytes inline do fail to inflate, so the o=z case above is an inflate failure.
    const inline = await engine.handle(parseKittyCommand(`a=t,f=32,s=1,v=1,o=z,i=1;${b64('garbage')}`))
    assert.match(responses(inline)[0] ?? '', /^\x1b_Gi=1;EINVAL:/)
  })

  it('--no-files: the wire refuses both transports with EINVAL; by default it reads', async () => {
    const tiny = write(path.join(outside, 'wire.rgba'))
    const off = createWire({ cellSize: () => ({ width: 10, height: 20 }), log: () => {}, files: false })
    for (const t of ['f', 't']) {
      const events = await off.engine.handle(parseKittyCommand(`a=T,t=${t},f=32,s=1,v=1,i=1;${b64(tiny)}`))
      assert.deepEqual(responses(events), ['\x1b_Gi=1;EINVAL:file transmission is not supported\x1b\\'], `t=${t}`)
    }
    const on = createWire({ cellSize: () => ({ width: 10, height: 20 }), log: () => {} })
    const events = await on.engine.handle(parseKittyCommand(`a=T,t=f,f=32,s=1,v=1,i=1;${b64(tiny)}`))
    assert.deepEqual(responses(events), ['\x1b_Gi=1;OK\x1b\\'])
  })
})
