// The child pty wrapper: exit codes, a child that never started, and input
// written after the child is gone.

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import type { IPty } from 'node-pty'
import { settleExitCode, spawnChild, watchInput, type ChildPty } from '../src/host/pty.ts'

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

/** A node-pty stand-in for spawnChild: an input socket that can fail, and recorded writes. */
function fakeNodePty(pid: number) {
  const inSocket = new EventEmitter()
  const writes: string[] = []
  const exits: Array<(e: { exitCode: number }) => void> = []
  const pty = {
    pid,
    _agent: { inSocket },
    write: (data: string | Buffer) => void writes.push(String(data)),
    onExit: (cb: (e: { exitCode: number }) => void) => void exits.push(cb),
    onData: () => {},
    resize: () => {},
    pause: () => {},
    resume: () => {},
    kill: () => {},
  }
  return { pty, inSocket, writes, exit: (code: number) => exits.forEach((cb) => cb({ exitCode: code })) }
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
