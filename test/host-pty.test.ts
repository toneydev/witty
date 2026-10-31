// The child pty wrapper: exit codes, a child that never started, input
// written after the child is gone, and output read as bytes.

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import type { IPty } from 'node-pty'
import { readOutputAsBytes, settleExitCode, spawnChild, watchInput, type ChildPty } from '../src/host/pty.ts'

/** A stand-in for node-pty's IPty with the agent field settleExitCode reads. */
function fakePty(agent: { exitCode?: number | undefined }): IPty {
  return { _agent: agent } as unknown as IPty
}

describe('settleExitCode', () => {
  it('returns a reported code at once', async () => {
    const agent = { exitCode: undefined as number | undefined }
    assert.equal(await settleExitCode(fakePty(agent), 42, 50), 42)
    assert.equal(await settleExitCode(fakePty(agent), 0, 50), 0)
  })

  it('waits for the code the native side reports after the exit event', async () => {
    const agent = { exitCode: undefined as number | undefined }
    setTimeout(() => (agent.exitCode = 42), 40)
    assert.equal(await settleExitCode(fakePty(agent), undefined, 2000), 42)
  })

  it('falls back to 1, not success, when no code ever arrives', async () => {
    const started = Date.now()
    assert.equal(await settleExitCode(fakePty({}), undefined, 60), 1)
    assert.ok(Date.now() - started >= 50)
    // No agent at all (another node-pty build): the same fallback.
    assert.equal(await settleExitCode({} as unknown as IPty, undefined, 20), 1)
  })

  it('looks once more after the deadline, for a code that came in while the event loop was busy', async () => {
    const agent = { exitCode: undefined as number | undefined }
    const settled = settleExitCode(fakePty(agent), undefined, 30)
    // Block the loop past the deadline; the code arrives meanwhile.
    const until = Date.now() + 60
    while (Date.now() < until) {
      // busy
    }
    agent.exitCode = 7
    assert.equal(await settled, 7)
  })
})

/**
 * A node-pty stand-in for spawnChild: an input socket that can fail, recorded
 * writes, and output emitted on demand (with `setEncoding` only when asked).
 */
function fakeNodePty(pid: number, options: { setEncoding?: boolean } = {}) {
  const inSocket = new EventEmitter()
  const writes: string[] = []
  const exits: Array<(e: { exitCode: number }) => void> = []
  const dataListeners: Array<(text: string) => void> = []
  const encodings: Array<string | null> = []
  const pty = {
    pid,
    _agent: { inSocket },
    write: (data: string | Buffer) => void writes.push(String(data)),
    onExit: (cb: (e: { exitCode: number }) => void) => void exits.push(cb),
    onData: (cb: (text: string) => void) => void dataListeners.push(cb),
    ...(options.setEncoding === true ? { setEncoding: (encoding: string | null) => void encodings.push(encoding) } : {}),
    resize: () => {},
    pause: () => {},
    resume: () => {},
    kill: () => {},
  }
  return {
    pty,
    inSocket,
    writes,
    encodings,
    exit: (code: number) => exits.forEach((cb) => cb({ exitCode: code })),
    emit: (text: string) => dataListeners.forEach((cb) => cb(text)),
  }
}

describe('spawnChild', () => {
  it('survives the input pipe failing after the child exits, and drops input from then on', () => {
    const fake = fakeNodePty(1234)
    const child = spawnChild({ file: 'x.exe', args: '', cwd: '.', env: {}, cols: 80, rows: 24, spawn: () => fake.pty as unknown as IPty })
    child.write('a')
    // What node-pty's conin socket emits when written to after the pseudo-console is gone.
    const eagain = Object.assign(new Error('write EAGAIN'), { code: 'EAGAIN', syscall: 'write' })
    assert.doesNotThrow(() => fake.inSocket.emit('error', eagain))
    assert.equal(child.inputClosed, true)
    child.write('b')
    assert.deepEqual(fake.writes, ['a'])
    assert.equal(child.started, true)
  })

  it('tells a child that never started (pid 0) from one that did', () => {
    const fake = fakeNodePty(0)
    const child = spawnChild({ file: 'x.exe', args: '', cwd: '.', env: {}, cols: 80, rows: 24, spawn: () => fake.pty as unknown as IPty })
    assert.equal(child.started, false)
  })

  it('watchInput reports false when the socket is not where node-pty keeps it', () => {
    assert.equal(watchInput({} as unknown as IPty, () => {}), false)
    assert.equal(watchInput({ _agent: {} } as unknown as IPty, () => {}), false)
  })

  it('reads the output as bytes: node-pty is switched to latin1 strings, each char one byte', () => {
    const fake = fakeNodePty(1234, { setEncoding: true })
    const child = spawnChild({ file: 'x.exe', args: '', cwd: '.', env: {}, cols: 80, rows: 24, spawn: () => fake.pty as unknown as IPty })
    assert.deepEqual(fake.encodings, ['latin1'])
    const reads: Uint8Array[] = []
    child.onData((bytes) => reads.push(bytes))
    // "é─" as UTF-8 (C3 A9 E2 94 80), split inside the second character, as latin1 strings.
    fake.emit('A\xc3\xa9\xe2')
    fake.emit('\x94\x80Z')
    assert.deepEqual(reads.map((r) => [...r]), [
      [0x41, 0xc3, 0xa9, 0xe2],
      [0x94, 0x80, 0x5a],
    ])
  })

  it("re-encodes node-pty's UTF-8 strings when it cannot switch the encoding", () => {
    const fake = fakeNodePty(1234)
    const child = spawnChild({ file: 'x.exe', args: '', cwd: '.', env: {}, cols: 80, rows: 24, spawn: () => fake.pty as unknown as IPty })
    const reads: Uint8Array[] = []
    child.onData((bytes) => reads.push(bytes))
    fake.emit('Aé─')
    assert.deepEqual(reads.map((r) => [...r]), [[0x41, 0xc3, 0xa9, 0xe2, 0x94, 0x80]])
  })

  it('readOutputAsBytes reports false when node-pty has no setEncoding or it throws', () => {
    assert.equal(readOutputAsBytes({} as unknown as IPty), false)
    const throwing = {
      setEncoding: () => {
        throw new Error('no')
      },
    }
    assert.equal(readOutputAsBytes(throwing as unknown as IPty), false)
  })

  // The real thing: non-ASCII output through the bundled ConPTY comes out as
  // its UTF-8 bytes, whatever the read boundaries.
  it('passes non-ASCII output through as its UTF-8 bytes', { timeout: 60000 }, async () => {
    const expected = 'Aé─中Z'
    const child: ChildPty = spawnChild({
      file: process.execPath,
      args: '-e process.stdout.write(String.fromCodePoint(0x41,0xe9,0x2500,0x4e2d,0x5a))',
      cwd: process.cwd(),
      env: process.env,
      cols: 80,
      rows: 24,
      inheritCursor: false,
    })
    const reads: Uint8Array[] = []
    let answered = false
    const exited = new Promise<number>((resolve) => child.onExit(resolve))
    child.onData((bytes) => {
      reads.push(bytes)
      // The ConPTY asks for the terminal's attributes (DA1) and waits about 3 s for an answer.
      if (!answered) {
        answered = true
        child.write('\x1b[?61;4c')
      }
    })
    assert.equal(await exited, 0)
    const text = Buffer.concat(reads).toString('utf8')
    assert.ok(text.includes(expected), `output ${JSON.stringify(text)}`)
  })

  // The real thing. Writing between the child's exit and node-pty's 'exit'
  // event used to crash the host with EAGAIN. That window is normally tens of
  // milliseconds; holding the output paused (as witty does while stdout is
  // full or an image is being drawn) holds 'exit' back, so the window stays
  // open until a write has failed, whatever the machine's speed.
  it('keeps running when written to after the child has exited, then reports its exit code', { timeout: 60000 }, async () => {
    const child: ChildPty = spawnChild({
      file: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
      args: '/d /c exit 3',
      cwd: process.cwd(),
      env: process.env,
      cols: 80,
      rows: 24,
      inheritCursor: false,
    })
    let code: number | undefined
    child.onExit((c) => (code = c))
    // node-pty defers writes until the first output; pause only after it. That
    // output asks for the terminal's attributes (DA1), and the ConPTY waits
    // about 3 s for an answer before it starts the child: answer it.
    await new Promise<void>((resolve) => child.onData(() => resolve()))
    child.write('\x1b[?61;4c')
    child.pause()
    const deadline = Date.now() + 30000
    while (!child.inputClosed && code === undefined && Date.now() < deadline) {
      child.write('x')
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.equal(child.inputClosed, true, 'no write ever failed: the window was not reached')
    assert.equal(code, undefined, "'exit' came while the output was paused")
    child.write('after')
    child.resume()
    while (code === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
    assert.equal(code, 3)
  })
})
